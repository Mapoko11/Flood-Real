/**
 * Flood real — TomTom proxy (Cloudflare Worker)
 * ให้เว็บ github.io ค้นรถติด / หาเส้นทาง / สีการจราจร ได้ โดย "ไม่เปิดเผย key"
 *
 * ต้องตั้งใน Cloudflare:
 *   - Secret  TOMTOM_API_KEY      (Settings -> Variables and Secrets -> Add -> Secret)
 *   - KV      COUNTER             (Bindings -> KV namespace, ใช้นับโควตารายวัน)
 *   - Variable ALLOWED_ORIGIN     (ไม่ใส่ = https://mapoko11.github.io)
 *
 * เส้นทาง:
 *   GET /traffic?q=ชื่อถนน         -> รูปแบบเดียวกับ /api/traffic ของเว็บในเครื่อง
 *   GET /route?from=...&to=...     -> รูปแบบเดียวกับ /api/route
 *   GET /tile/{z}/{x}/{y}.png      -> ภาพสีการจราจร
 *   GET /usage                     -> โควตาที่ใช้ไปวันนี้
 *
 * กันโควตาหมด (key ตัวเดียวกับเว็บในเครื่อง = โควตาเดือนเดียวกัน จึงตั้งเพดานต่อวันไว้ต่ำ):
 *   - รับเฉพาะจากเว็บที่อนุญาต / cache ผลเดิม 5 นาที / จำกัดต่อ IP / เพดานต่อวัน (DAILY)
 */

const DAILY = { traffic: 40, route: 200, search: 50 };   // เพดานต่อวัน (เวลาไทย) — KV ฟรีเขียนได้ 1,000 ครั้ง/วัน
// ภาพสีการจราจร (tile) ไม่นับใน KV: ใช้ cache 2 นาที + โควตา TomTom 200,000/เดือน
const PER_IP = { max: 15, windowMs: 10 * 60 * 1000 };                  // ต่อ IP ต่อ 10 นาที
const CACHE_SEC = 300;
const BIAS = [13.7563, 100.5018];                                      // กรุงเทพฯ

const CATEGORY = {0:"ไม่ทราบ",1:"อุบัติเหตุ",2:"หมอก",3:"สภาพอันตราย",4:"ฝน",5:"น้ำแข็ง",6:"รถติด",7:"ปิดช่องจราจร",
  8:"ปิดถนน",9:"ซ่อมถนน",10:"ลมแรง",11:"น้ำท่วม",14:"รถเสีย"};
const MAGNITUDE = {0:"ไม่ทราบ",1:"เล็กน้อย",2:"ปานกลาง",3:"หนัก",4:"ปิดถนน/ไม่เคลื่อน"};

const ipHits = new Map();   // best-effort ต่อ isolate (ไม่เปลือง KV)

class TrafficError extends Error {}

export default {
  // Cron Trigger (ตั้งใน Cloudflare: Settings -> Trigger events -> Cron "*/15 * * * *")
  // สั่ง GitHub Actions สร้างเว็บใหม่ทุก 15 นาที — แทน cron ของ GitHub ที่มักเลื่อน/ข้ามรอบ
  // ต้องมี Secret GH_TOKEN (fine-grained token: repo Flood-Real, สิทธิ์ Actions: Read and write)
  async scheduled(event, env, ctx) {
    // บันทึกว่า cron ทำงานจริง (ก่อนเรียก GitHub) เพื่อแยกว่า "cron ไม่ทำงาน" หรือ "สั่ง GitHub ไม่ผ่าน"
    ctx.waitUntil((async () => {
      try { await env.COUNTER.put("cron:last", JSON.stringify({ at: nowTh(), cron: event.cron || "" }), { expirationTtl: 7 * 86400 }); } catch (e) {}
      await dispatchBuild(env, "cron");
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowed = (env.ALLOWED_ORIGIN || "https://mapoko11.github.io").replace(/\/$/, "");
    const origin = request.headers.get("Origin") || "";
    const referer = request.headers.get("Referer") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ ok: false, error: "method" }, 405, cors);

    // ข้อมูลน้ำท่วมถนน กทม. (ข้อมูลสาธารณะ) — เปิดให้ server ในเครื่อง/GitHub Actions เรียกได้ด้วย
    // ต้นทางถูกเรียกไม่เกิน 1 ครั้ง / 10 นาที ไม่ว่าจะมีคนเรียกกี่ครั้ง (cache)
    if (url.pathname === "/bma") return await bma(env, ctx, cors);
    if (url.pathname === "/bma-canal") return await bma(env, ctx, cors, "canal");
    // อ่านหน้า "ระดับน้ำในคลอง" ของ กทม. ผ่าน Worker (จำกัดเฉพาะ path /water... เท่านั้น, cache 10 นาที)
    if (url.pathname === "/bkk") return await bkk(url.searchParams.get("p") || "", ctx, cors);

    // รับเฉพาะเว็บที่อนุญาต (fetch ส่ง Origin, <img> ของ tile ส่ง Referer)
    const fromAllowed = origin === allowed || referer.startsWith(allowed + "/");
    if (!fromAllowed && url.pathname !== "/health") return json({ ok: false, error: "ไม่อนุญาต" }, 403, cors);

    try {
      if (url.pathname === "/health") return json({ ok: true }, 200, cors);
      if (url.pathname === "/usage") return json({ ok: true, day: today(), ...(await usage(env)),
        last_build: JSON.parse((await env.COUNTER.get("dispatch:last")) || "null"),
        last_cron: JSON.parse((await env.COUNTER.get("cron:last")) || "null"),
        gh_token: !!env.GH_TOKEN }, 200, cors);

      // ทดสอบสั่งสร้างเว็บทันที (เฉพาะจากเว็บที่อนุญาต, ได้ 1 ครั้ง / 5 นาที)
      if (url.pathname === "/build-now") {
        const lastAt = await env.COUNTER.get("buildnow:lock");
        if (lastAt) return json({ ok: false, error: "เพิ่งสั่งไป รอ 5 นาที" }, 429, cors);
        await env.COUNTER.put("buildnow:lock", "1", { expirationTtl: 300 });
        const st = await dispatchBuild(env, "manual");
        return json({ ok: st.status === "ok", ...st }, 200, cors);
      }

      if (url.pathname === "/stats") return await visitStats(env, ctx, cors);

      const tm = url.pathname.match(/^\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if (tm) return await tile(env, ctx, +tm[1], +tm[2], +tm[3], cors);

      if (url.pathname === "/traffic" || url.pathname === "/route") {
        const ip = request.headers.get("CF-Connecting-IP") || "?";
        if (!ipAllow(ip)) return json({ ok: false, error: "ค้นถี่เกินไป รอสักครู่แล้วลองใหม่" }, 429, cors);
        const isRoute = url.pathname === "/route";
        const avoidRaw = (url.searchParams.get("avoid") || "").slice(0, 4000);
        const q = isRoute ? `${norm(url.searchParams.get("from"))}|${norm(url.searchParams.get("to"))}|${avoidRaw}`
                          : norm(url.searchParams.get("q"));
        const cacheKey = new Request(`https://cache.floodreal/${isRoute ? "r" : "t"}/${encodeURIComponent(q)}`);
        const cache = caches.default;
        const hit = await cache.match(cacheKey);
        if (hit) {
          const body = await hit.json();
          return json({ ...body, cached: true }, 200, cors);
        }
        const result = isRoute
          ? await route(env, url.searchParams.get("from"), url.searchParams.get("to"), avoidRaw)
          : await search(env, url.searchParams.get("q"));
        ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SEC}` } })));
        return json(result, 200, cors);
      }
      return json({ ok: false, error: "not found" }, 404, cors);
    } catch (e) {
      const msg = e instanceof TrafficError ? e.message : "เกิดข้อผิดพลาดที่ตัวกลาง";
      return json({ ok: false, error: msg }, e instanceof TrafficError ? 400 : 502, cors);
    }
  },
};

/* ---------------- helpers ---------------- */

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}
function today() {   // วันที่ตามเวลาไทย
  return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
}
function nowTh() {
  return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 19);
}
function norm(t) {
  return String(t || "").toLowerCase().replace(/ถนน|ถ\./g, "").replace(/\s+/g, "").slice(0, 100);
}
function ipAllow(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < PER_IP.windowMs);
  if (arr.length >= PER_IP.max) { ipHits.set(ip, arr); return false; }
  arr.push(now); ipHits.set(ip, arr);
  if (ipHits.size > 5000) ipHits.clear();
  return true;
}
async function usage(env) {
  const d = today(), out = {};
  for (const k of Object.keys(DAILY)) out[k] = { used: +(await env.COUNTER.get(`${d}:${k}`) || 0), limit: DAILY[k] };
  return out;
}
async function spend(env, kind) {
  const k = `${today()}:${kind}`;
  const n = +(await env.COUNTER.get(k) || 0);
  if (n >= DAILY[kind]) throw new TrafficError("โควตาของวันนี้หมดแล้ว (กันไม่ให้เกินฟรี) ลองใหม่พรุ่งนี้ หรือใช้เว็บในเครื่อง/วงแลน");
  await env.COUNTER.put(k, String(n + 1), { expirationTtl: 3 * 86400 });
}
async function tt(env, url, body) {
  if (!env.TOMTOM_API_KEY) throw new TrafficError("ยังไม่ได้ตั้ง TOMTOM_API_KEY ใน Worker");
  const u = url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(env.TOMTOM_API_KEY);
  const init = { headers: { "User-Agent": "FloodReal-Worker/1.0" } };
  if (body) { init.method = "POST"; init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const r = await fetch(u, init);
  if (r.status === 401 || r.status === 403) throw new TrafficError("TomTom ปฏิเสธ key");
  if (r.status === 429) throw new TrafficError("TomTom จำกัดความถี่ ลองใหม่อีกสักครู่");
  if (!r.ok) throw new TrafficError(`TomTom ตอบ HTTP ${r.status}`);
  return r;
}
function km(a, b, c, d) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const h = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function dist(r, bias) {
  const p = r.position || {};
  return (typeof p.lat === "number") ? km(bias[0], bias[1], p.lat, p.lon) : 1e9;
}

/* ---------------- หาพิกัด (เอนเอียงใกล้ กทม./ต้นทาง) ---------------- */

async function lookup(env, q, bias = BIAS, nearKm = 150) {
  const base = `countrySet=TH&language=th-TH&limit=8&lat=${bias[0].toFixed(5)}&lon=${bias[1].toFixed(5)}`;
  let res = (await (await tt(env, `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(q)}.json?${base}`)).json()).results || [];
  if (!res.length || Math.min(...res.map(r => dist(r, bias))) > nearKm) {
    try {
      await spend(env, "search");
      const s = (await (await tt(env, `https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json?${base}&idxSet=Str,Geo,POI,PAD,Addr`)).json()).results || [];
      res = s.concat(res);
    } catch (e) { if (!(e instanceof TrafficError)) throw e; }   // เพดาน search หมด -> ใช้ผล geocode เดิม
  }
  const near = res.filter(r => dist(r, bias) <= nearKm);
  const pool = near.length ? near : res;
  pool.sort((a, b) => near.length ? (b.score || 0) - (a.score || 0) : dist(a, bias) - dist(b, bias));
  return pool;
}

/* ---------------- ค้นรถติดตามชื่อถนน ---------------- */

async function search(env, qRaw) {
  const q = String(qRaw || "").trim();
  if (q.length < 2 || q.length > 80) throw new TrafficError("พิมพ์ชื่อถนน 2–80 ตัวอักษร");
  await spend(env, "traffic");
  const [qc, hint] = splitParen(q);
  const ll = parseLatLon(q);                                       // "lat,lon@ชื่อ" = เบราว์เซอร์หาพิกัดมาแล้ว (Longdo) หรือจุดที่จำไว้
  const isJn = !ll && qc.startsWith("แยก");
  DIAG = {};
  const osm = isJn ? await osmJunction(env, qc, null) : null;      // ชื่อ "แยก…" ใช้จุดจาก OSM ก่อน
  const ld = (osm || ll) ? [] : await longdo(env, qc, null, hint);
  const res = (osm || ld.length || ll) ? [] : await lookup(env, (qc + " " + hint).trim());
  if (!res.length && !ld.length && !osm && !ll) throw new TrafficError(`ไม่พบถนน/สถานที่ชื่อ “${q}”`);
  let road, tl, br;
  const around = (lat, lon, dl) => { tl = { lat: lat + dl, lon: lon - dl }; br = { lat: lat - dl, lon: lon + dl }; };
  if (ll) {
    road = { name: ll[2], area: "ตำแหน่งจาก Longdo (ค้นจากเบราว์เซอร์)", type: "POI", lat: ll[0], lon: ll[1] };
    around(ll[0], ll[1], 0.011);
  } else if (osm) {
    road = { name: qc, area: "ตำแหน่งจาก OSM", type: "ทางแยก", lat: osm.lat, lon: osm.lon };
    around(osm.lat, osm.lon, 0.011);
  } else if (ld.length) {
    const d = ld[0];
    road = { name: d.name, area: (d.area ? d.area + " · " : "") + "ตำแหน่งจาก Longdo", type: "POI", lat: d.lat, lon: d.lon };
    around(d.lat, d.lon, 0.011);
  } else {
    const nq = normTh(qc);
    const rk = r => {
      const a = r.address || {}, nm = normTh((r.poi || {}).name || a.streetName || ""), hit = nq && nm.includes(nq) ? 0 : 1;
      const ps = r.position || {}, dist = typeof ps.lat === "number" ? km(BIAS[0], BIAS[1], ps.lat, ps.lon) : 999;
      return isJn ? [hit, r.type === "Cross Street" ? 0 : 1, dist] : [r.type === "Street" ? 0 : 1, hit, dist];
    };
    res.sort((x, y) => { const p = rk(x), q2 = rk(y); return (p[0] - q2[0]) || (p[1] - q2[1]) || (p[2] - q2[2]); });
    const r = res[0], a = r.address || {}, vp = r.viewport || {}, pos = r.position || {};
    tl = vp.topLeftPoint; br = vp.btmRightPoint;
    if (isJn || !tl || !br) around(pos.lat, pos.lon, isJn ? 0.011 : 0.02);
    road = {
      name: a.streetName || (r.poi || {}).name || a.freeformAddress || q,
      area: [a.municipalitySubdivision, a.municipality, a.countrySubdivision].filter(Boolean).join(", ") + " · ตำแหน่งจาก TomTom" + (DIAG.osm || DIAG.ld ? " (" + [DIAG.osm ? "OSM: " + DIAG.osm : "", DIAG.ld ? "Longdo: " + DIAG.ld : ""].filter(Boolean).join(" · ") + ")" : ""),
      type: r.type || "", lat: pos.lat, lon: pos.lon,
    };
  }
  // ขยายขอบเขต 1.5 กม. และไม่เกิน ~50 กม. จากกลาง
  const dlat = 1.5 / 111, dlon = 1.5 / (111 * Math.max(0.2, Math.cos((tl.lat + br.lat) / 2 * Math.PI / 180)));
  let b = [tl.lon - dlon, br.lat - dlat, br.lon + dlon, tl.lat + dlat];
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  b = [Math.max(b[0], cx - 0.45), Math.max(b[1], cy - 0.45), Math.min(b[2], cx + 0.45), Math.min(b[3], cy + 0.45)];

  const fields = "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,lastReportTime,from,to,length,delay,roadNumbers}}}";
  const inc = await (await tt(env, `https://api.tomtom.com/traffic/services/5/incidentDetails?bbox=${b.map(v => v.toFixed(5)).join(",")}` +
    `&fields=${encodeURIComponent(fields)}&language=th-TH&timeValidityFilter=present`)).json();

  const words = [norm(road.name), norm(q)];
  const items = [];
  for (const it of inc.incidents || []) {
    const p = it.properties || {}, g = it.geometry || {};
    let coords = g.coordinates || [];
    if (g.type === "Point") coords = [coords];
    const pts = coords.filter(c => Array.isArray(c) && c.length >= 2).map(c => [c[1], c[0]]);
    if (!pts.length) continue;
    const text = norm([p.from, p.to, (p.roadNumbers || []).join(" "), (p.events || []).map(e => e.description).join(" ")].join(" "));
    const cat = +(p.iconCategory || 0), mag = +(p.magnitudeOfDelay || 0);
    items.push({
      id: String(p.id || ""), category: CATEGORY[cat] || "อื่นๆ", cat, magnitude: mag, magnitude_text: MAGNITUDE[mag] || "",
      tail: String(p.from || ""), head: String(p.to || ""),
      length_km: Math.round((p.length || 0) / 10) / 100, delay_min: Math.round((p.delay || 0) / 6) / 10,
      events: (p.events || []).map(e => e.description || "").slice(0, 3), roads: p.roadNumbers || [],
      since: String(p.startTime || ""), updated: String(p.lastReportTime || ""),
      on_road: words.some(w => w && text.includes(w)), line: pts.slice(0, 400),
    });
  }
  items.sort((x, y) => (x.on_road === y.on_road ? 0 : x.on_road ? -1 : 1) || ((x.cat !== 6) - (y.cat !== 6)) ||
    (y.magnitude - x.magnitude) || (y.length_km - x.length_km));
  return { ok: true, query: q, road, bbox: b, items: items.slice(0, 60), total: items.length, at: nowTh(), cached: false };
}

/* ---------------- หาเส้นทางเลี่ยงรถติด ---------------- */

function parseLatLon(t) {
  // "lat,lon" หรือ "lat,lon@ชื่อ" (ผู้ใช้เลือกจุดเอง/ลากหมุด)
  const [head, ...rest] = String(t || "").split("@");
  const m = head.split(",").map(Number);
  return (m.length === 2 && m[0] >= 5 && m[0] <= 21 && m[1] >= 97 && m[1] <= 106)
    ? [m[0], m[1], rest.join("@").trim().slice(0, 80) || "ตำแหน่งปัจจุบัน"] : null;
}
const TYPE_TH = { "Cross Street": "ทางแยก", "Street": "ถนน", "Geography": "พื้นที่", "POI": "สถานที่", "Point Address": "ที่อยู่", "Address Range": "ที่อยู่" };
const TYPE_BONUS = { "Cross Street": 1.5, "Street": 1.0, "Geography": 0.6, "POI": 0.5 };
const normTh = t => String(t || "").toLowerCase().replace(/ถนน/g, "").replace(/ถ\./g, "").replace(/\s+/g, "");
function candName(r, q) {
  const a = r.address || {};
  return (r.poi || {}).name || a.streetName || a.freeformAddress || q;
}
/* จัดอันดับใหม่: ชื่อตรงที่พิมพ์ + เป็นทางแยก/ถนน มาก่อนร้านค้า/POI ชื่อคล้าย (sort เสถียร) */
function rankPlace(pool, q, bias) {
  // เฉพาะผลที่ชื่อตรงที่พิมพ์และอยู่ไม่ไกลจุดอ้างอิง (<=40 กม.) ถูกยกขึ้นก่อน (ทางแยก > ถนน > สถานที่) ผลอื่นคงลำดับเดิม
  const nq = normTh(q), bs = bias || BIAS;
  const sc = r => {
    const a = r.address || {};
    const hit = [candName(r, ""), a.streetName || "", a.freeformAddress || ""].some(n => nq && normTh(n).includes(nq)) && dist(r, bs) <= 40;
    return hit ? -(2 + (TYPE_BONUS[r.type] || 0)) : 0;
  };
  return pool.map((r, i) => [r, i]).sort((x, y) => (sc(x[0]) - sc(y[0])) || (x[1] - y[1])).map(v => v[0]);
}
function altsOf(pool, q, n = 4) {
  const out = [];
  for (const r of pool) {
    const p = r.position || {};
    if (typeof p.lat !== "number") continue;
    if (out.some(o => km(p.lat, p.lon, o.lat, o.lon) < 0.08)) continue;
    const a = r.address || {};
    out.push({ name: candName(r, q), kind: TYPE_TH[r.type] || "", area: [a.municipalitySubdivision, a.municipality].filter(Boolean).join(", "),
      lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 });
    if (out.length >= n) break;
  }
  return out;
}
/* ตำแหน่ง "ทางแยก" จาก OSM (Overpass) แม่นกว่า TomTom ที่มักให้จุด "สะพานข้ามแยก" · cache ใน KV (เจอ 30 วัน/ไม่เจอ 7 วัน) · ดึงไม่สำเร็จ -> ใช้ TomTom ต่อ */
let DIAG = {};   // เหตุผลที่ OSM/Longdo ไม่ได้ผล (แสดงต่อท้ายข้อความเมื่อถอยไปใช้ TomTom)
const OSM_BBOX = "13.45,100.25,14.15,100.95";
async function osmJunction(env, qRaw, bias) {
  const name = String(qRaw || "").trim().split(/\s+/).join(" ");
  if (!name.startsWith("แยก") || !/^[฀-๿A-Za-z0-9 .\-]{3,40}$/.test(name)) return null;
  const kv = "osm2:" + normTh(name);      // osm2 = กรองป้ายรถ/สถานีออกแล้ว
  try {
    const c = JSON.parse((await env.COUNTER.get(kv)) || "null");
    if (c) return c.hit || null;
  } catch (e) {}
  const variants = [...new Set([name, name.replace(/ /g, ""), "แยก " + name.slice(3).trim()])];
  const parts = variants.map(v => `node["name"="${v}"](${OSM_BBOX});node["name:th"="${v}"](${OSM_BBOX});`).join("");
  let els = null;
  const mirrors = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
  const errs = [];
  for (const ep of mirrors) {          // ลองเซิร์ฟเวอร์สำรองตามลำดับ ตัวไหนล่มข้ามไปตัวถัดไป
    try {
      const r = await fetch(ep, { method: "POST", headers: { "User-Agent": "FloodReal/1.0 (+systemL traffic)" },
        body: new URLSearchParams({ data: `[out:json][timeout:15];(${parts});out tags center 40;` }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) { errs.push(new URL(ep).hostname.split(".").slice(-2, -1)[0] + " HTTP " + r.status); continue; }
      els = (await r.json()).elements || [];
      break;
    } catch (e) { errs.push(new URL(ep).hostname.split(".").slice(-2, -1)[0] + " " + String((e && e.name) || e)); }
  }
  if (els === null) { DIAG.osm = "Overpass ใช้ไม่ได้ (" + errs.join(", ") + ")"; return null; }
  const isJnNode = t => !["public_transport", "railway", "amenity", "shop", "office", "tourism", "building", "station"].some(k => k in t)
                        && !["bus_stop", "platform"].includes(t.highway);
  const pts = els.filter(e => typeof e.lat === "number" && typeof e.lon === "number" && isJnNode(e.tags || {})).map(e => [e.lat, e.lon]);
  let hit = null;
  if (pts.length) {
    const b = bias || BIAS;
    const ref = pts.slice().sort((x, y) => km(b[0], b[1], x[0], x[1]) - km(b[0], b[1], y[0], y[1]))[0];
    const grp = pts.filter(p => km(ref[0], ref[1], p[0], p[1]) <= 0.3);
    hit = { lat: Math.round(grp.reduce((a, p) => a + p[0], 0) / grp.length * 1e6) / 1e6, lon: Math.round(grp.reduce((a, p) => a + p[1], 0) / grp.length * 1e6) / 1e6, n: pts.length };
  }
  try { await env.COUNTER.put(kv, JSON.stringify({ hit }), { expirationTtl: (hit ? 30 : 7) * 86400 }); } catch (e) {}
  return hit;
}
/* Longdo Map Search (ต้องตั้ง secret LONGDO_API_KEY ใน Worker; ไม่ตั้ง = ข้าม) · cache KV 30 วัน · ล้มเหลวเงียบๆ */
const PAREN = /^(.*?)\s*[(（]([^)）]*)[)）]\s*$/;
function splitParen(q) {
  const m = PAREN.exec(String(q || "").trim().split(/\s+/).join(" "));
  return m && m[1].trim() ? [m[1].trim(), m[2].trim()] : [String(q || "").trim(), ""];
}
const LD_BAD = ["ป้ายรถ", "สถานี", "บริษัท", "ร้าน", "สาขา", "คอนโด", "ตลาด", "โรงแรม", "ธนาคาร", "ปั๊ม", "อาคาร", "ทางออก"];
async function longdo(env, q, bias, hint) {
  const k = String(env.LONGDO_API_KEY || "").trim(), name = String(q || "").trim();
  if (!k || name.length < 3) { DIAG.ld = k ? "ชื่อสั้นเกินไป" : "ยังไม่ได้ตั้ง Secret LONGDO_API_KEY ใน Worker"; return []; }
  const kv = "ld2:" + normTh(name) + (hint ? "|" + normTh(hint) : "");
  try { const c = JSON.parse((await env.COUNTER.get(kv)) || "null"); if (c) { if (!(c.hit || []).length) DIAG.ld = "ไม่พบผลลัพธ์ (จากแคช 3 วัน)"; return c.hit || []; } } catch (e) {}
  const b = bias || BIAS;
  let data;
  try {
    const u = "https://search.longdo.com/mapsearch/json/search?" + new URLSearchParams({ keyword: name, lon: b[1], lat: b[0], span: "40km", limit: "10", key: k, locale: "th" });
    const r = await fetch(u, { headers: { "User-Agent": "FloodReal/1.0 (+systemL traffic)", "Referer": "https://mapoko11.github.io/Flood-Real/", "Origin": "https://mapoko11.github.io" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) { DIAG.ld = "HTTP " + r.status + (r.status === 401 || r.status === 403 ? " (key ไม่ผ่าน/จำกัดโดเมน)" : ""); return []; }
    const txt = await r.text();
    let js = null;
    try { js = JSON.parse(txt); } catch (e) { DIAG.ld = "Longdo ตอบกลับ: " + txt.replace(/\s+/g, " ").slice(0, 90) + " [key ยาว " + k.length + " ตัว · รหัสตรวจ " + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k)))].slice(0, 3).map(x => x.toString(16).padStart(2, "0")).join("") + "]"; return []; }
    data = js.data || [];
  } catch (e) { DIAG.ld = "เชื่อมต่อ Longdo ไม่ได้ (" + String((e && (e.name + ": " + e.message)) || e).slice(0, 80) + ")"; return []; }
  const nq = normTh(name), nh = normTh(hint);
  const bad = d => LD_BAD.some(w => String(d.name || "").includes(w)) ? 1 : 0;       // ป้ายรถ/สถานี/ร้าน ไปท้าย
  const hm = d => (!nh || normTh((d.address || "") + (d.name || "")).includes(nh)) ? 0 : 1;
  data = data.slice().sort((x, y) => (hm(x) - hm(y)) || (bad(x) - bad(y)));
  const out = [];
  for (const d of data) {
    if (typeof d.lat !== "number" || typeof d.lon !== "number" || !normTh(d.name).includes(nq)) continue;
    if (km(b[0], b[1], d.lat, d.lon) > 40) continue;
    out.push({ name: String(d.name), kind: "Longdo", area: String(d.address || "").slice(0, 60), lat: Math.round(d.lat * 1e6) / 1e6, lon: Math.round(d.lon * 1e6) / 1e6 });
    if (out.length >= 3) break;
  }
  if (!out.length) DIAG.ld = data.length ? "ไม่พบชื่อที่ตรงในรัศมี 40 กม." : "ไม่พบผลลัพธ์";
  try { await env.COUNTER.put(kv, JSON.stringify({ hit: out }), { expirationTtl: (out.length ? 30 : 3) * 86400 }); } catch (e) {}
  return out;
}
async function place(env, q0, bias) {
  const ll = parseLatLon(q0);
  if (ll) return { name: ll[2], lat: ll[0], lon: ll[1], alts: [] };
  const [q, hint] = splitParen(q0);
  const osm = await osmJunction(env, q, bias);
  const res = rankPlace(await lookup(env, (q + " " + hint).trim(), bias || BIAS), q, bias);
  const ld = await longdo(env, q, bias, hint);
  if (!res.length && !osm && !ld.length) throw new TrafficError(`ไม่พบสถานที่ “${q0}”`);
  let alts = altsOf(res, q);
  const far = (x, y) => km(x.lat, x.lon, y.lat, y.lon) >= 0.08;
  if (ld.length && !osm) {
    alts = ld.concat(alts.filter(x => ld.every(y => far(x, y)))).slice(0, 5);
    return { name: q, lat: ld[0].lat, lon: ld[0].lon, kind: "Longdo", alts };
  }
  if (ld.length) alts = alts.concat(ld.filter(y => far(y, osm)));
  if (osm) {
    alts = [{ name: q, kind: "ทางแยก (OSM)", area: "", lat: osm.lat, lon: osm.lon }].concat(alts.filter(x => far(x, osm))).slice(0, 5);
    return { name: q, lat: osm.lat, lon: osm.lon, kind: "ทางแยก (OSM)", alts };
  }
  const r = res[0], pos = r.position || {};
  return { name: candName(r, q), lat: pos.lat, lon: pos.lon, kind: TYPE_TH[r.type] || "", alts };
}
function viaStreets(instr, total) {
  const d = {};
  instr.forEach((ins, i) => {
    const st = (ins.street || "").trim();
    const s = ins.routeOffsetInMeters || 0;
    const e = i + 1 < instr.length ? (instr[i + 1].routeOffsetInMeters || 0) : total;
    if (st) d[st] = (d[st] || 0) + Math.max(0, e - s);
  });
  return Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
}
/* จุดน้ำท่วมที่หน้าเว็บส่งมา "s,w,n,e;..." -> เลือก ≤10 กล่องที่อยู่ใกล้แนวต้นทาง-ปลายทาง (TomTom avoidAreas) */
function parseAvoid(s) {
  const out = [];
  for (const part of String(s || "").split(";").slice(0, 80)) {
    const b = part.split(",").map(Number);
    if (b.length !== 4 || b.some(x => !isFinite(x))) continue;
    const [so, we, no, ea] = b;
    if (so >= 5 && so < no && no <= 21 && we >= 97 && we < ea && ea <= 106 && no - so <= 0.05 && ea - we <= 0.05) out.push(b);
  }
  return out;
}
function segKm(plat, plon, a, b) {
  const kx = 111.32 * Math.cos(plat * Math.PI / 180), ky = 110.57;
  const ax = a.lon * kx, ay = a.lat * ky, bx = b.lon * kx, by = b.lat * ky, px = plon * kx, py = plat * ky;
  const dx = bx - ax, dy = by - ay;
  const t = (dx === 0 && dy === 0) ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function pickAvoid(boxes, a, b) {
  const corridor = Math.max(3, 0.25 * km(a.lat, a.lon, b.lat, b.lon));
  return boxes.filter(x => ![a, b].some(p => x[0] <= p.lat && p.lat <= x[2] && x[1] <= p.lon && p.lon <= x[3]))
    .map(x => [segKm((x[0] + x[2]) / 2, (x[1] + x[3]) / 2, a, b), x]).filter(v => v[0] <= corridor)
    .sort((p, q) => p[0] - q[0]).slice(0, 10).map(v => v[1]);
}

async function route(env, srcRaw, dstRaw, avoidRaw) {
  const src = String(srcRaw || "").trim(), dst = String(dstRaw || "").trim();
  if (src.length < 2 || src.length > 100 || dst.length < 2 || dst.length > 100) throw new TrafficError("ใส่ต้นทางและปลายทาง (2–100 ตัวอักษร)");
  await spend(env, "route");
  const a = await place(env, src);
  const b = await place(env, dst, [a.lat, a.lon]);
  const locs = `${a.lat.toFixed(6)},${a.lon.toFixed(6)}:${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
  const rurl = `https://api.tomtom.com/routing/1/calculateRoute/${locs}/json?traffic=true&maxAlternatives=2` +
    `&routeType=fastest&travelMode=car&departAt=now&instructionsType=text&language=th-TH&computeTravelTimeFor=all&sectionType=traffic`;
  let chosen = pickAvoid(parseAvoid(avoidRaw), a, b), js;
  const body = chosen.length ? { avoidAreas: { rectangles: chosen.map(x => ({
    southWestCorner: { latitude: x[0], longitude: x[1] }, northEastCorner: { latitude: x[2], longitude: x[3] } })) } } : null;
  try { js = await (await tt(env, rurl, body)).json(); }
  catch (e) { if (!body) throw e; chosen = []; js = await (await tt(env, rurl)).json(); }   // หลบไม่ได้ -> เส้นทางปกติ
  const routes = [];
  for (const r of js.routes || []) {
    const sm = r.summary || {};
    const pts = [];
    for (const leg of r.legs || []) for (const p of leg.points || []) pts.push([p.latitude, p.longitude]);
    const step = Math.max(1, Math.floor(pts.length / 800));
    const line = pts.filter((_, i) => i % step === 0);
    if (pts.length && (pts.length - 1) % step) line.push(pts[pts.length - 1]);
    const jams = [];
    for (const sec of r.sections || []) {
      if (sec.sectionType !== "TRAFFIC") continue;
      const seg = pts.slice(sec.startPointIndex || 0, (sec.endPointIndex || 0) + 1);
      if (seg.length > 1) {
        const st = Math.max(1, Math.floor(seg.length / 150));
        jams.push({ line: seg.filter((_, i) => i % st === 0).concat([seg[seg.length - 1]]),
          delay_min: Math.round((sec.delayInSeconds || 0) / 6) / 10, magnitude: +(sec.magnitudeOfDelay || 0), speed: sec.effectiveSpeedInKmh });
      }
    }
    const instr = (r.guidance || {}).instructions || [];
    const total = sm.lengthInMeters || 0;
    routes.push({
      km: Math.round(total / 100) / 10, minutes: Math.round((sm.travelTimeInSeconds || 0) / 60),
      delay_min: Math.round((sm.trafficDelayInSeconds || 0) / 60),
      free_minutes: Math.round((sm.noTrafficTravelTimeInSeconds || 0) / 60) || null,
      arrive: String(sm.arrivalTime || "").slice(11, 16), via: viaStreets(instr, total),
      steps: instr.filter(i => i.message).slice(0, 40).map(i => ({ text: i.message, km: Math.round((i.routeOffsetInMeters || 0) / 100) / 10 })),
      jams: jams.sort((x, y) => y.delay_min - x.delay_min).slice(0, 30), line,
    });
  }
  if (!routes.length) throw new TrafficError("หาเส้นทางไม่ได้ (ลองระบุต้นทาง/ปลายทางให้ชัดขึ้น)");
  let best = 0;
  routes.forEach((r, i) => { if (r.minutes < routes[best].minutes) best = i; });
  const slowest = Math.max(...routes.map(r => r.minutes));
  routes.forEach((r, i) => { r.best = i === best; r.saves_min = Math.max(0, slowest - r.minutes); });
  const far = km(a.lat, a.lon, b.lat, b.lon);
  const warn = far > 150 ? `ต้นทาง/ปลายทางห่างกัน ${Math.round(far).toLocaleString()} กม. — ถ้าไม่ใช่ที่ตั้งใจ ลองพิมพ์ชื่อให้ชัดขึ้น เช่น ใส่เขต/จังหวัด` : "";
  return { ok: true, from: a, to: b, routes, best, warn, avoided: chosen, at: nowTh(), cached: false };
}

/* ---------------- ภาพสีการจราจร ---------------- */

async function tile(env, ctx, z, x, y, cors) {
  if (!(z >= 5 && z <= 18 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z)) return new Response(null, { status: 204, headers: cors });
  const key = new Request(`https://cache.floodreal/tile/${z}/${x}/${y}`);
  const hit = await caches.default.match(key);
  if (hit) return new Response(hit.body, { headers: { ...cors, "Content-Type": "image/png", "Cache-Control": "public, max-age=120" } });
  const r = await tt(env, `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?thickness=8&tileSize=256`);
  const buf = await r.arrayBuffer();
  ctx.waitUntil(caches.default.put(key, new Response(buf, { headers: { "Content-Type": "image/png", "Cache-Control": "max-age=120" } })));
  return new Response(buf, { headers: { ...cors, "Content-Type": "image/png", "Cache-Control": "public, max-age=120" } });
}

/* ---------------- สั่ง GitHub สร้างเว็บใหม่ (ใช้กับ Cron Trigger) ---------------- */

async function dispatchBuild(env, by = "cron") {
  const repo = env.GH_REPO || "Mapoko11/Flood-Real";
  const wf = env.GH_WORKFLOW || "pages.yml";
  let status = "no-token", detail = "";
  if (env.GH_TOKEN) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${String(env.GH_TOKEN).trim()}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "FloodReal-Worker/1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      });
      status = r.status === 204 ? "ok" : `HTTP ${r.status}`;
      if (r.status !== 204) detail = (await r.text()).slice(0, 200);   // ข้อความจาก GitHub (ไม่มี token)
    } catch (e) {
      status = "error";
      detail = String(e && e.message || e).slice(0, 200);
    }
  }
  const rec = { at: nowTh(), by, status, detail };
  try { await env.COUNTER.put("dispatch:last", JSON.stringify(rec), { expirationTtl: 7 * 86400 }); } catch (e) {}
  return rec;
}

/* ---------------- น้ำท่วมถนน กทม. (สำนักการระบายน้ำ) ---------------- */

// แหล่งข้อมูล กทม. ที่อนุญาต (ตายตัว ไม่รับ URL จากผู้ใช้)
const BMA_SRC = {
  flood: { url: "https://weather.bangkok.go.th/Flood/PageMap/GetData?id=0", referer: "https://weather.bangkok.go.th/Flood/",
           ok: (j) => j && Array.isArray(j.dtTbl) },
  canal: { url: "https://weather.bangkok.go.th/water/PageMap/GoogleMap", referer: "https://weather.bangkok.go.th/water/",
           method: "POST", body: "payload=TEST_DATA_GOES_HERE", ok: (j) => Array.isArray(j) && j.length > 0 },
};

async function bma(env, ctx, cors, name = "flood") {
  const src = BMA_SRC[name];
  const key = new Request("https://floodreal-cache.local/bma-" + name);
  const kvKey = name === "flood" ? "bma:last" : "bma:" + name;
  const hit = await caches.default.match(key);
  if (hit) return new Response(hit.body, { headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "X-Bma": "cache" } });
  let body = null, status = "ok";
  // กันยิงต้นทางถี่ข้ามศูนย์ข้อมูล Cloudflare (cache แยกตามที่ตั้ง): จำเวลาที่ลองครั้งล่าสุดไว้ใน KV
  try {
    const last = JSON.parse((await env.COUNTER.get(kvKey + ":try")) || "null");
    if (last && Date.now() - last.t < (last.ok ? 1200e3 : 1800e3)) {
      const kb = await env.COUNTER.get(kvKey);
      if (kb) return new Response(kb, { headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "X-Bma": last.ok ? "kv" : "stale: รอรอบถัดไป" } });
    }
  } catch (e) {}
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": src.referer,
    };
    if (src.body) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    const r = await fetch(src.url, { method: src.method || "GET", headers, body: src.body, cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const t = await r.text();
    if (!src.ok(JSON.parse(t))) throw new Error("รูปแบบข้อมูลเปลี่ยน");
    body = t;
    ctx.waitUntil(env.COUNTER.put(kvKey, t, { expirationTtl: 2 * 86400 }));
  } catch (e) {
    status = "stale: " + String(e && e.message || e).slice(0, 80);
    body = await env.COUNTER.get(kvKey);
    if (!body) return json({ ok: false, error: status }, 502, cors);
  }
  ctx.waitUntil(env.COUNTER.put(kvKey + ":try", JSON.stringify({ t: Date.now(), ok: status === "ok" }), { expirationTtl: 86400 }));
  const ttl = status === "ok" ? 1200 : 1800;   // ได้ผล จำ 20 นาที · พังแล้วรอ 30 นาทีค่อยลองต้นทางใหม่ (กทม. บล็อก IP ที่เรียกถี่)
  ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } })));
  return new Response(body, { headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "X-Bma": status } });
}

async function bkk(p, ctx, cors) {
  if (!/^\/water(\/[A-Za-z0-9_.\/-]{0,80})?(\?[A-Za-z0-9=&_.%-]{0,120})?$/i.test(p))
    return json({ ok: false, error: "path ไม่อนุญาต" }, 400, cors);
  const key = new Request("https://floodreal-cache.local/bkk" + p);
  const hit = await caches.default.match(key);
  if (hit) return new Response(hit.body, { headers: { ...cors, "Content-Type": hit.headers.get("Content-Type") || "text/plain" } });
  const r = await fetch("https://weather.bangkok.go.th" + p, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Accept": "application/json, text/javascript, text/html, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://weather.bangkok.go.th/water",
    },
  });
  let ct = r.headers.get("Content-Type") || "text/plain";
  if (!/json/i.test(ct)) ct = "text/plain; charset=utf-8";   // ไม่ให้หน้า HTML ของเว็บอื่นรันบนโดเมนเรา
  const body = (await r.text()).slice(0, 3000000);
  if (!r.ok) return json({ ok: false, error: `HTTP ${r.status}` }, 502, cors);
  ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { "Content-Type": ct, "Cache-Control": "max-age=600" } })));
  return new Response(body, { headers: { ...cors, "Content-Type": ct } });
}

/* ---------------- ยอดผู้เข้าชม (Cloudflare Web Analytics ผ่าน GraphQL) ----------------
 * ต้องมี Secret CF_API_TOKEN (สิทธิ์ Account Analytics: Read) + Variable CF_ACCOUNT_ID
 * cache 10 นาที -> ไม่ยิง API ตามจำนวนคนเปิด */
async function visitStats(env, ctx, cors) {
  const key = new Request("https://floodreal-cache.local/stats");
  const hit = await caches.default.match(key);
  if (hit) return new Response(hit.body, { headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return json({ ok: false, error: "ยังไม่ได้ตั้ง CF_API_TOKEN / CF_ACCOUNT_ID" }, 200, cors);
  const host = env.STATS_HOST || "mapoko11.github.io";
  const th = new Date(Date.now() + 7 * 3600e3);                     // เวลาไทย
  const today = th.toISOString().slice(0, 10);
  const since = new Date(Date.parse(today + "T00:00:00Z") - 6 * 86400e3 - 7 * 3600e3).toISOString();   // 7 วัน (เริ่มเที่ยงคืนไทย)
  const q = `query($acc: String!, $since: Time!, $host: String!) { viewer { accounts(filter: {accountTag: $acc}) {
      rumPageloadEventsAdaptiveGroups(limit: 5000, filter: {datetime_geq: $since, requestHost: $host}) {
        count sum { visits } dimensions { datetimeHour } } } } }`;
  let out;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { acc: env.CF_ACCOUNT_ID, since, host } }),
    });
    const j = await r.json();
    if (j.errors && j.errors.length) throw new Error(String(j.errors[0].message || "graphql error").slice(0, 120));
    const rows = (((j.data || {}).viewer || {}).accounts || [{}])[0].rumPageloadEventsAdaptiveGroups || [];
    const agg = { today: { views: 0, visits: 0 }, week: { views: 0, visits: 0 } };
    for (const x of rows) {
      const hTh = new Date(Date.parse(x.dimensions.datetimeHour) + 7 * 3600e3).toISOString().slice(0, 10);
      const v = x.count || 0, vi = (x.sum || {}).visits || 0;
      agg.week.views += v; agg.week.visits += vi;
      if (hTh === today) { agg.today.views += v; agg.today.visits += vi; }
    }
    out = { ok: true, at: nowTh(), ...agg };
  } catch (e) {
    out = { ok: false, error: String(e && e.message || e).slice(0, 150) };
  }
  const body = JSON.stringify(out);
  ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${out.ok ? 600 : 120}` } })));
  return new Response(body, { headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
}
