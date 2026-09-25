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

    // รับเฉพาะเว็บที่อนุญาต (fetch ส่ง Origin, <img> ของ tile ส่ง Referer)
    const fromAllowed = origin === allowed || referer.startsWith(allowed + "/");
    if (!fromAllowed && url.pathname !== "/health") return json({ ok: false, error: "ไม่อนุญาต" }, 403, cors);

    try {
      if (url.pathname === "/health") return json({ ok: true }, 200, cors);
      if (url.pathname === "/usage") return json({ ok: true, day: today(), ...(await usage(env)) }, 200, cors);

      const tm = url.pathname.match(/^\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if (tm) return await tile(env, ctx, +tm[1], +tm[2], +tm[3], cors);

      if (url.pathname === "/traffic" || url.pathname === "/route") {
        const ip = request.headers.get("CF-Connecting-IP") || "?";
        if (!ipAllow(ip)) return json({ ok: false, error: "ค้นถี่เกินไป รอสักครู่แล้วลองใหม่" }, 429, cors);
        const isRoute = url.pathname === "/route";
        const q = isRoute ? `${norm(url.searchParams.get("from"))}|${norm(url.searchParams.get("to"))}`
                          : norm(url.searchParams.get("q"));
        const cacheKey = new Request(`https://cache.floodreal/${isRoute ? "r" : "t"}/${encodeURIComponent(q)}`);
        const cache = caches.default;
        const hit = await cache.match(cacheKey);
        if (hit) {
          const body = await hit.json();
          return json({ ...body, cached: true }, 200, cors);
        }
        const result = isRoute
          ? await route(env, url.searchParams.get("from"), url.searchParams.get("to"))
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
async function tt(env, url) {
  if (!env.TOMTOM_API_KEY) throw new TrafficError("ยังไม่ได้ตั้ง TOMTOM_API_KEY ใน Worker");
  const u = url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(env.TOMTOM_API_KEY);
  const r = await fetch(u, { headers: { "User-Agent": "FloodReal-Worker/1.0" } });
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
  const res = await lookup(env, q);
  if (!res.length) throw new TrafficError(`ไม่พบถนน/สถานที่ชื่อ “${q}”`);
  res.sort((a, b) => (a.type === "Street" ? 0 : 1) - (b.type === "Street" ? 0 : 1));
  const r = res[0], a = r.address || {}, vp = r.viewport || {}, pos = r.position || {};
  let tl = vp.topLeftPoint, br = vp.btmRightPoint;
  if (!tl || !br) { tl = { lat: pos.lat + 0.02, lon: pos.lon - 0.02 }; br = { lat: pos.lat - 0.02, lon: pos.lon + 0.02 }; }
  const road = {
    name: a.streetName || (r.poi || {}).name || a.freeformAddress || q,
    area: [a.municipalitySubdivision, a.municipality, a.countrySubdivision].filter(Boolean).join(", "),
    type: r.type || "", lat: pos.lat, lon: pos.lon,
  };
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
  const m = String(t || "").split(",").map(Number);
  return (m.length === 2 && m[0] >= 5 && m[0] <= 21 && m[1] >= 97 && m[1] <= 106) ? m : null;
}
async function place(env, q, bias) {
  const ll = parseLatLon(q);
  if (ll) return { name: "ตำแหน่งปัจจุบัน", lat: ll[0], lon: ll[1] };
  const res = await lookup(env, q, bias || BIAS);
  if (!res.length) throw new TrafficError(`ไม่พบสถานที่ “${q}”`);
  const r = res[0], a = r.address || {}, pos = r.position || {};
  return { name: (r.poi || {}).name || a.freeformAddress || q, lat: pos.lat, lon: pos.lon };
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
async function route(env, srcRaw, dstRaw) {
  const src = String(srcRaw || "").trim(), dst = String(dstRaw || "").trim();
  if (src.length < 2 || src.length > 100 || dst.length < 2 || dst.length > 100) throw new TrafficError("ใส่ต้นทางและปลายทาง (2–100 ตัวอักษร)");
  await spend(env, "route");
  const a = await place(env, src);
  const b = await place(env, dst, [a.lat, a.lon]);
  const locs = `${a.lat.toFixed(6)},${a.lon.toFixed(6)}:${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
  const js = await (await tt(env, `https://api.tomtom.com/routing/1/calculateRoute/${locs}/json?traffic=true&maxAlternatives=2` +
    `&routeType=fastest&travelMode=car&departAt=now&instructionsType=text&language=th-TH&computeTravelTimeFor=all&sectionType=traffic`)).json();
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
  return { ok: true, from: a, to: b, routes, best, warn, at: nowTh(), cached: false };
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
