/* river.js — 🌊 สายน้ำเจ้าพระยา: เขื่อน → นครสวรรค์ → ชัยนาท → กรุงเทพฯ → อ่าวไทย
   ใช้ข้อมูลที่ Flood real มีอยู่แล้ว (สถานีวัดระดับน้ำ + เขื่อนจาก ThaiWater) ไม่เรียก API เพิ่ม
   - แท็บ "🌊 สายน้ำ": แผนภาพลำดับตามน้ำไหล + เวลาน้ำเดินทาง (ประมาณ)
   - ชั้นแผนที่ "🌊 สายน้ำเจ้าพระยา": เส้นสีตามระดับน้ำ + ทิศทางไหล
   แนวเส้น = ต่อจุดสถานีวัดน้ำเป็นเส้นตรง (ไม่ใช่แนวตลิ่งจริง) · เวลาเดินทาง = ระยะ × ความคดเคี้ยว ÷ ความเร็วคลื่นน้ำที่เลือก (ค่าประมาณ) */
"use strict";

/* สถานีตามลำดับ เหนือ -> ใต้ (id ของ ThaiWater) — สถานีที่ไม่มีในข้อมูลรอบนั้นจะถูกข้ามเอง */
const RV_CHAIN = ["568", "2795", "584", "83", "80", "2744", "89", "71", "2723", "68", "2626", "58", "39", "49", "26", "2599", "4"];
const RV_MOUTH = {lat: 13.52, lon: 100.59, name: "ปากแม่น้ำ · อ่าวไทย"};
/* ทางน้ำจากเขื่อนที่เข้ามารวม: ชื่อเขื่อน -> สถานีที่ไปรวม (เส้นประ = ไม่ใช่แนวแม่น้ำจริง) */
const RV_TRIBS = [
  {key: "ภูมิพล", label: "แม่น้ำปิง", to: "568"},
  {key: "สิริกิติ์", label: "แม่น้ำน่าน", to: "568"},
  {key: "ป่าสักชลสิทธิ์", label: "แม่น้ำป่าสัก", to: "39"},
];
const RV_SINU = 1.25;                // ความคดเคี้ยวของแม่น้ำเทียบเส้นตรง (ประมาณ)
let rvSpeed = 4;                     // ความเร็วคลื่นน้ำ กม./ชม. ใช้เฉพาะช่วงเหนือเขื่อนเจ้าพระยา (ประมาณ ≈ 139 กม. ใน ~32 ชม.)
/* เวลาน้ำเดินทางจาก "ท้ายเขื่อนเจ้าพระยา" (ชัยนาท) — อ้างอิง Spring News (ชัยนาท→สิงห์บุรี ~10 ชม., →อ่างทอง ~8, →อยุธยา ~6, →ปทุมธานี ~8, →นนทบุรี/กรุงเทพฯ ~24)
   ผูกกับสถานี: id -> ชม. สะสม · ระหว่างสถานีที่ผูกไว้ประมาณเชิงเส้นตามระยะ */
const RV_ANCHORS = {"2744": 0, "68": 10, "58": 18, "39": 24, "4": 56};
const RV_REF = "Spring News";
let rvChain = [];                    // [{st, km, hrs}] หลังคำนวณ

const rvKm = (a, b, c, d) => {
  const R = 6371, r = Math.PI / 180, dl = (c - a) * r, dn = (d - b) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const rvHrsTxt = h => h < 1 ? "ไม่ถึง 1 ชม." : h < 36 ? `≈ ${Math.round(h)} ชม.` : `≈ ${(h / 24).toFixed(1)} วัน`;
const rvTrend = s => {
  if (s.wl_msl == null || s.wl_prev == null) return ["–", "ไม่มีข้อมูลแนวโน้ม", "#94a3b8"];
  const d = s.wl_msl - s.wl_prev;
  if (d > 0.05) return ["▲", `กำลังขึ้น ${d.toFixed(2)} ม.`, "#ef4444"];
  if (d < -0.05) return ["▼", `กำลังลด ${(-d).toFixed(2)} ม.`, "#22c55e"];
  return ["●", "ทรงตัว", "#94a3b8"];
};
/* สถานะ 3 แบบ: ปกติ = เขียว · น้ำมาก (เฝ้าระวัง/วิกฤต) = ส้ม · ล้นตลิ่ง = แดง · ไม่มีข้อมูล = เทา
   ตามระดับของ ThaiWater: 5 = ล้นตลิ่ง, 4 = น้ำมาก (>70% ตลิ่ง), 1–3 = ปกติ/น้ำน้อย */
const RV_ST = {
  ok:   {c: "#22c55e", t: "ปกติ",      spd: 2.6},
  warn: {c: "#f97316", t: "น้ำมาก",     spd: 1.5},
  crit: {c: "#ef4444", t: "ล้นตลิ่ง",   spd: 0.8},
  none: {c: "#64748b", t: "ไม่มีข้อมูล", spd: 0},
};
const rvLv = s => (s && s.level) || 0;
const rvStKey = lv => lv >= 5 ? "crit" : lv === 4 ? "warn" : lv >= 1 ? "ok" : "none";
const rvState = s => RV_ST[rvStKey(rvLv(s))];
const rvColor = s => rvState(s).c;
const rvPill = s => `<span class="pill" style="background:${rvState(s).c}">${rvState(s).t}</span>`;
const rvWorst = (a, b) => RV_ST[rvStKey(Math.max(rvLv(a), rvLv(b)))].c;   // สีช่วงน้ำ = ระดับที่แย่กว่าของสองสถานี

function rvBuild() {
  const all = (DATA && DATA.waterlevel) || [];
  const by = {}; all.forEach(w => { by[String(w.id)] = w; });
  const sts = RV_CHAIN.map(id => by[id]).filter(s => s && typeof s.lat === "number" && typeof s.lon === "number");
  let km = 0;
  rvChain = sts.map((s, i) => {
    if (i) km += rvKm(sts[i - 1].lat, sts[i - 1].lon, s.lat, s.lon) * RV_SINU;
    return {st: s, km, hrs: 0};
  });
  const anc = rvChain.map((x, i) => [i, RV_ANCHORS[String(x.st.id)]]).filter(a => a[1] !== undefined);   // [index, ชม.จากเขื่อน]
  if (anc.length >= 2) {
    const d0 = rvChain[anc[0][0]].km, base = d0 / rvSpeed;       // ชม. จากปากน้ำโพ ถึงเขื่อน
    rvChain.forEach((x, i) => {
      if (x.km <= d0) { x.hrs = x.km / rvSpeed; return; }         // เหนือเขื่อน: ระยะ ÷ ความเร็วประมาณ
      let j = 0; while (j < anc.length - 2 && i > anc[j + 1][0]) j++;
      const [ia, ha] = anc[j], [ib, hb] = anc[j + 1], ka = rvChain[ia].km, kb = rvChain[ib].km;
      x.hrs = base + ha + (hb - ha) * (x.km - ka) / Math.max(1, kb - ka);
    });
  } else rvChain.forEach(x => { x.hrs = x.km / rvSpeed; });
  return rvChain;
}
const rvDams = () => {
  const dams = ((DATA && DATA.main) || {}).dams || [];
  return RV_TRIBS.map(t => ({t, d: dams.find(x => (x.name || "").includes(t.key))})).filter(x => x.d);
};

/* ---------------- แผนภาพสายน้ำ (ลูกศรวิ่งตามทิศน้ำไหล · จุดกะพริบตามสถานะ) ---------------- */
const RV_KEY = ["568", "2744", "58", "39", "49", "26", "2599", "4"];   // จุดหลักที่แสดงในแผนภาพ (ที่เหลืออยู่ในรายการด้านล่าง)
function rvSvg(ch) {
  const by = {}; ch.forEach(x => { by[String(x.st.id)] = x; });
  const keys = RV_KEY.map(id => by[id]).filter(Boolean);
  if (keys.length < 3) return "";
  const X = 150, Y0 = 150, DY = 84, W = 360;
  const yOf = i => Y0 + i * DY, H = yOf(keys.length - 1) + 128;
  const dams = rvDams();
  const damSt = d => RV_ST[d.level >= 5 ? "crit" : d.level === 4 ? "warn" : d.level ? "ok" : "none"];
  /* ลูกศรวิ่ง: กลุ่ม <g> ตำแหน่งคงที่ + path ที่เลื่อนด้วย CSS (rv-mv) — ang = ทิศที่ชี้ (0 = ลง) */
  const mv = (x, y, ang, col, delay, dist) => `<g transform="translate(${x},${y}) rotate(${ang || 0})"><path class="rv-mv" d="M-7,-5 L0,4 L7,-5" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" style="--d:${dist || 26}px;animation-delay:${delay}s;filter:drop-shadow(0 0 3px ${col})"/></g>`;
  const node = (x, y, st, r) => {
    const dur = st.spd || 0;
    return (dur ? `<circle class="rv-pulse" cx="${x}" cy="${y}" r="${r}" fill="${st.c}" style="animation-duration:${dur}s"/>` : "")
      + `<circle cx="${x}" cy="${y}" r="${r + 3}" fill="var(--panel)" stroke="${st.c}" stroke-opacity=".55" stroke-width="2"/>`
      + `<circle class="${dur ? "rv-blink" : ""}" cx="${x}" cy="${y}" r="${r}" fill="${st.c}" style="${dur ? "animation-duration:" + dur + "s" : ""}"/>`;
  };
  const chip = (x, y, txt, col) => {
    const w = Math.round(txt.length * 6.4 + 14);
    return `<rect x="${x}" y="${y - 11}" width="${w}" height="16" rx="8" fill="${col}" opacity=".18"/><rect x="${x}" y="${y - 11}" width="${w}" height="16" rx="8" fill="none" stroke="${col}" stroke-opacity=".7"/><text x="${x + 7}" y="${y + 1}" class="rv-c" fill="${col}">${txt}</text>`;
  };
  let o = `<svg viewBox="0 0 ${W} ${H}" class="rv-svg" role="img" aria-label="แผนภาพสายน้ำ ลูกศรวิ่งชี้ทิศทางน้ำไหลจากเหนือลงใต้ จุดกะพริบตามระดับน้ำ">
    <defs><linearGradient id="rvCh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d4ed8" stop-opacity=".28"/><stop offset="1" stop-color="#0ea5e9" stop-opacity=".28"/></linearGradient></defs>`;
  /* ต้นน้ำ: ปิง วัง ยม น่าน */
  const topN = [{x: 55, lab: "ปิง", key: "ภูมิพล"}, {x: 130, lab: "วัง", key: null}, {x: 205, lab: "ยม", key: null}, {x: 280, lab: "น่าน", key: "สิริกิติ์"}];
  topN.forEach((t, i) => {
    const dm = t.key ? dams.find(d => d.t.key === t.key) : null, st = dm ? damSt(dm.d) : RV_ST.none;
    o += `<path d="M${t.x} 66 L${t.x} 100 L${X} ${yOf(0) - 16}" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-dasharray="7 7" class="rv-march" opacity=".75"/>`;
    o += mv(t.x, 84, 0, "#38bdf8", i * 0.25, 22);
    o += node(t.x, 36, st, 8);
    o += `<text x="${t.x}" y="16" text-anchor="middle" class="rv-t">${t.lab}</text>`;
    o += `<text x="${t.x}" y="58" text-anchor="middle" class="rv-m">${dm && dm.d.pct != null ? "เขื่อน " + fmt(dm.d.pct, 0) + "%" : "ไม่มีข้อมูล"}</text>`;
  });
  /* ลำน้ำหลัก: ท่อน้ำโปร่ง + เส้นสีสถานะ + ลูกศรวิ่ง */
  o += `<line x1="${X}" y1="${yOf(0)}" x2="${X}" y2="${yOf(keys.length - 1) + 70}" stroke="url(#rvCh)" stroke-width="26" stroke-linecap="round"/>`;
  keys.forEach((k, i) => {
    if (i >= keys.length - 1) return;
    const y = yOf(i), y2 = yOf(i + 1), col = rvWorst(k.st, keys[i + 1].st);
    o += `<line x1="${X}" y1="${y}" x2="${X}" y2="${y2}" stroke="${col}" stroke-width="7" stroke-linecap="round" opacity=".92" style="filter:drop-shadow(0 0 5px ${col})"/>`;
    [0.28, 0.72].forEach((f, j) => { o += mv(X, y + (y2 - y) * f, 0, col, (i * 0.37 + j * 0.9) % 1.8, 30); });
  });
  const yl = yOf(keys.length - 1);
  o += `<line x1="${X}" y1="${yl}" x2="${X}" y2="${yl + 72}" stroke="#0ea5e9" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 11" class="rv-march"/>` + mv(X, yl + 38, 0, "#0ea5e9", 0, 30);
  /* จุดสถานี + ป้าย */
  keys.forEach((k, i) => {
    const y = yOf(i), s = k.st, st = rvState(s), [ar, tt, tc] = rvTrend(s);
    o += node(X, y, st, 8);
    o += `<text x="${X + 22}" y="${y - 6}" class="rv-t">${esc(s.name.replace(/\(.*\)/, ""))}</text>`;
    o += chip(X + 22, y + 14, `${s.bank_pct == null ? "–" : fmt(s.bank_pct, 0) + "% ตลิ่ง"} · ${st.t} ${ar}`, st.c);
    o += `<text x="${X + 22}" y="${y + 33}" class="rv-m">${i ? "ถึงช้ากว่าปากน้ำโพ ≈ " + rvHrsTxt(k.hrs).replace("≈ ", "") : "จุดรวม 4 สายจากเหนือ"}</text>`;
    const nm = String(s.id);
    if (nm === "2744") {
      o += `<path d="M${X - 12} ${y} L46 ${y + 26} L46 ${y + 58}" fill="none" stroke="#94a3b8" stroke-width="3" stroke-dasharray="6 6" class="rv-march" opacity=".8"/>` + mv(46, y + 42, 0, "#94a3b8", 0.3, 18);
      o += `<text x="46" y="${y + 76}" text-anchor="middle" class="rv-m">แม่น้ำน้อย / ท่าจีน</text>`;
    }
    if (nm === "39") {
            o += `<path d="M334 ${y - 46} L${X + 12} ${y - 9}" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-dasharray="7 7" class="rv-march" opacity=".8"/>` + mv(246, y - 28, 78, "#38bdf8", 0, 24);
      o += `<text x="334" y="${y - 22}" text-anchor="end" class="rv-m">ป่าสัก</text>`;
    }
    if (nm === "26") o += `<text x="${X + 22}" y="${y + 47}" class="rv-m">▸ พื้นที่นนทบุรี</text>`;
    if (nm === "2599") o += `<text x="${X + 22}" y="${y + 47}" class="rv-m">▸ กรุงเทพฯ ตอนบน</text>`;
  });
  o += node(X, yl + 88, {c: "#0ea5e9", spd: 3}, 8);
  o += `<text x="${X + 22}" y="${yl + 85}" class="rv-t">อ่าวไทย (ปากน้ำ)</text><text x="${X + 22}" y="${yl + 102}" class="rv-m">น้ำทะเลหนุนมีผลช่วงนี้</text>`;
  return o + "</svg>"
    + `<div class="rv-lg"><span><i style="background:${RV_ST.ok.c}"></i>ปกติ</span><span><i style="background:${RV_ST.warn.c}"></i>น้ำมาก (เฝ้าระวัง)</span><span><i style="background:${RV_ST.crit.c}"></i>ล้นตลิ่ง</span><span><i style="background:${RV_ST.none.c}"></i>ไม่มีข้อมูล</span><span class="muted">กะพริบเร็ว = ระดับสูง</span></div>`;
}

/* ---------------- แท็บ ---------------- */
const rvLatest = ch => { const t = ch.map(x => String(x.st.time || "")).filter(Boolean).sort(); return t.length ? t[t.length - 1].replace("T", " ").slice(0, 16) : "–"; };
function rvRender() {
  const box = document.getElementById("rvBody"); if (!box) return;
  const ch = rvBuild();
  if (ch.length < 3) { box.innerHTML = `<div class="note">ยังมีข้อมูลสถานีตามแม่น้ำเจ้าพระยาไม่พอ (พบ ${ch.length} สถานี) — รอข้อมูลรอบถัดไป</div>`; return; }
  const dams = rvDams();
  const top = ch.reduce((m, x) => (x.st.bank_pct ?? -1) > (m.st.bank_pct ?? -1) ? x : m, ch[0]);
  const idx = id => ch.findIndex(x => String(x.st.id) === id);
  const cd = idx("2744"), bk = idx("4");
  const eta = (cd >= 0 && bk > cd) ? (ch[bk].hrs - ch[cd].hrs) : null;

  const damCards = dams.map(({t, d}) => `<div class="rv-dam">
      <div class="t"><b>${esc(d.name)}</b>${pill(DAM, d.level)}</div>
      <div class="sub">${esc(t.label)} · น้ำในอ่าง ${fmt(d.pct, 0)}% · ไหลเข้า ${fmt(d.inflow, 2)} · ระบาย ${fmt(d.released, 2)} ล้าน ลบ.ม./วัน</div>
    </div>`).join("");

  const rows = ch.map((x, i) => {
    const s = x.st, c = rvColor(s), nxt = ch[i + 1], seg = nxt ? rvWorst(s, nxt.st) : null;
    const [ar, tt, tc] = rvTrend(s);
    const pct = s.bank_pct == null ? null : Math.max(0, Math.min(130, s.bank_pct));
    const isTop = x === top;
    return `<div class="rv-row${isTop ? " top" : ""}">
      <div class="rv-rail"><span class="rv-dot rv-blink${rvLv(s) >= 4 ? "" : " calm"}" style="background:${c};animation-duration:${rvState(s).spd || 2}s"></span>${nxt ? `<span class="rv-seg" style="background:${seg}"></span>` : ""}</div>
      <div class="rv-main">
        <div class="rv-h"><b>${esc(s.name)}</b> <span class="muted">${esc(s.province || "")}</span>
          ${rvPill(s)}${isTop ? ' <span class="rv-flag">จุดน้ำสูงสุดในสายนี้</span>' : ""}</div>
        <div class="rv-bar"><i style="width:${pct == null ? 0 : (pct / 130 * 100)}%;background:${c}"></i><u style="left:${100 / 1.3}%"></u></div>
        <div class="rv-s">ระดับ ${s.bank_pct == null ? "–" : fmt(s.bank_pct, 0) + "% ของตลิ่ง"} · ${s.wl_msl == null ? "–" : fmt(s.wl_msl, 2) + " ม.รทก."}
          · <span style="color:${tc}" title="${esc(tt)}">${ar} ${esc(tt)}</span></div>
        <div class="rv-s muted">${i === 0 ? "จุดเริ่มต้นสาย (ปากน้ำโพ)" : `ห่างจากจุดก่อนหน้า ≈ ${Math.round(x.km - ch[i - 1].km)} กม. · น้ำจากต้นสายถึงที่นี่ ${rvHrsTxt(x.hrs)}`}</div>
      </div></div>`;
  }).join("");

  box.innerHTML = `
    <div class="rv-sum">
      <div><span class="muted">จุดน้ำสูงสุดตอนนี้</span><br><b>${esc(top.st.name)}</b> · ${fmt(top.st.bank_pct, 0)}% ของตลิ่ง</div>
      ${eta != null ? `<div><span class="muted">น้ำจาก ท้ายเขื่อนเจ้าพระยา ถึง สะพานกรุงเทพ</span><br><b>${rvHrsTxt(eta)}</b> <span class="muted">(ตามตารางอ้างอิง)</span></div>` : ""}
      <div><span class="muted">การอัปเดตข้อมูล</span><br><b>ทุก ~15 นาที</b> <span class="muted">(ระบบดึงจาก ThaiWater ทุก 15 นาที · ${STATIC ? "เว็บนี้สร้างใหม่ทุก ~15 นาที" : "หน้านี้ตรวจข้อมูลใหม่ทุก 1 นาที"})</span><br>
        <span class="muted">ดึงล่าสุด ${esc(((DATA && DATA.updated_at) || "–").replace("T", " "))} · ค่าวัดล่าสุดของสถานี ${esc(rvLatest(ch))}</span></div>
      <div><span class="muted">เวลาน้ำเดินทาง อ้างอิง</span><br><b>${RV_REF}</b> <span class="muted">(ชัยนาท→กรุงเทพฯ ≈ 56 ชม.) · เหนือเขื่อนประมาณ ${rvSpeed} กม./ชม. · เป็นค่าเฉลี่ย ไม่ใช่พยากรณ์</span></div>
    </div>
    <h3 class="rv-h3">แผนภาพสายน้ำ · ลูกศร = ทิศน้ำไหล (สี = ระดับน้ำ)</h3>
    <div class="rv-svgbox">${rvSvg(ch)}</div>
    <h3 class="rv-h3">ต้นน้ำ · เขื่อน</h3>
    <div class="rv-dams">${damCards || '<div class="muted">ไม่มีข้อมูลเขื่อนต้นน้ำรอบนี้</div>'}</div>
    <h3 class="rv-h3">ไหลลงมาตามลำดับ (เหนือ → ใต้)</h3>
    <div class="rv-flow">${rows}
      <div class="rv-row"><div class="rv-rail"><span class="rv-dot" style="background:#0ea5e9"></span></div>
        <div class="rv-main"><div class="rv-h"><b>${esc(RV_MOUTH.name)}</b></div>
        <div class="rv-s muted">น้ำทะเลหนุนมีผลช่วงปลายน้ำ (ตั้งแต่ราวสะพานกรุงเทพลงไป) · ยังไม่มีข้อมูลระดับน้ำทะเลอัตโนมัติ — ตรวจตารางน้ำขึ้นน้ำลงจากกรมอุทกศาสตร์ ทร. เพิ่มเติม</div></div></div>
    </div>
    <div class="note" style="margin-top:12px">ข้อควรรู้: เวลาน้ำเดินทางเป็นค่าประมาณจากระยะทางและความเร็วที่เลือก ไม่ใช่การพยากรณ์ทางการ ·
      แนวเส้นบนแผนที่ต่อจากจุดสถานีวัดน้ำ ไม่ใช่แนวตลิ่งจริง · ข้อมูลระดับน้ำ/เขื่อนจาก ThaiWater รอบล่าสุด</div>`;
}

/* ---------------- ชั้นแผนที่ ---------------- */
function rvArrow(a, b, col, f) {       // ลูกศรวิ่งตามทิศน้ำไหล (a -> b) เลื่อนด้วย CSS
  const p = [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
  const k = Math.cos(a.lat * Math.PI / 180);
  const ang = Math.atan2((b.lon - a.lon) * k, b.lat - a.lat) * 180 / Math.PI;   // 0 = เหนือ, 90 = ตะวันออก
  const icon = L.divIcon({className: "", iconSize: [18, 18], iconAnchor: [9, 9],
    html: `<div style="transform:rotate(${ang.toFixed(0)}deg);width:18px;height:18px"><div class="rv-mmv" style="color:#fff;text-shadow:0 0 3px #000,0 0 5px ${col};animation-delay:${(f * 1.6).toFixed(2)}s">▲</div></div>`});
  return L.marker(p, {icon, interactive: false, keyboard: false, zIndexOffset: 400});
}
function rvMap() {
  if (typeof map === "undefined" || !map || typeof L === "undefined") return;
  if (!layers.river) layers.river = L.layerGroup();
  const g = layers.river; g.clearLayers();
  const ch = rvChain.length ? rvChain : rvBuild();
  if (ch.length < 2) return;
  const pts = ch.map(x => x.st);
  for (let i = 0; i < pts.length - 1; i++) {
    const col = rvWorst(pts[i], pts[i + 1]);
    L.polyline([[pts[i].lat, pts[i].lon], [pts[i + 1].lat, pts[i + 1].lon]], {color: col, weight: 7, opacity: .85, lineCap: "round"}).addTo(g);
    rvArrow(pts[i], pts[i + 1], col, 0.3).addTo(g); rvArrow(pts[i], pts[i + 1], col, 0.7).addTo(g);
  }
  const last = pts[pts.length - 1];
  L.polyline([[last.lat, last.lon], [RV_MOUTH.lat, RV_MOUTH.lon]], {color: "#0ea5e9", weight: 6, opacity: .7, dashArray: "2 10", lineCap: "round"}).addTo(g);
  L.circleMarker([RV_MOUTH.lat, RV_MOUTH.lon], {radius: 6, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: .9})
    .bindPopup(`<b>${esc(RV_MOUTH.name)}</b><br>น้ำทะเลหนุนมีผลช่วงปลายน้ำ (ยังไม่มีข้อมูลอัตโนมัติ)`).addTo(g);
  const bk = ch.find(x => String(x.st.id) === "4"), cd = ch.find(x => String(x.st.id) === "2744");
  ch.forEach(x => {
    const s = x.st, [ar, tt] = rvTrend(s);
    const etaBk = (bk && x.hrs < bk.hrs) ? `<br>น้ำถึงสะพานกรุงเทพอีก ${rvHrsTxt(bk.hrs - x.hrs)} (ประมาณ)` : "";
    const st = rvState(s), icon = L.divIcon({className: "", iconSize: [26, 26], iconAnchor: [13, 13],
      html: `<span class="rv-pd${st.spd ? " on" : ""}" style="--c:${st.c};--t:${st.spd || 2}s"><i></i><b></b></span>`});
    L.marker([s.lat, s.lon], {icon, zIndexOffset: 500})
      .bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.province || "")}<br>ระดับ ${s.bank_pct == null ? "–" : fmt(s.bank_pct, 0) + "% ของตลิ่ง"} ${rvPill(s)}<br>${s.wl_msl == null ? "" : fmt(s.wl_msl, 2) + " ม.รทก. · "}${ar} ${esc(tt)}${etaBk}<br><small>${esc(s.time || "")}</small>`)
      .addTo(g);
  });
  rvDams().forEach(({t, d}) => {     // เส้นประจากเขื่อนมาสายหลัก
    const to = pts.find(p => String(p.id) === t.to); if (!to || typeof d.lat !== "number") return;
    L.polyline([[d.lat, d.lon], [to.lat, to.lon]], {color: "#60a5fa", weight: 3, opacity: .6, dashArray: "8 8"})
      .bindPopup(`<b>${esc(t.label)}</b> จาก ${esc(d.name)}<br>ระบาย ${fmt(d.released, 2)} ล้าน ลบ.ม./วัน<br><small>เส้นประ = ทิศทางน้ำ ไม่ใช่แนวแม่น้ำจริง</small>`).addTo(g);
  });
  const cb = document.getElementById("lyRiver");
  if (cb && cb.checked) g.addTo(map); else map.removeLayer(g);
}

/* ---------------- ต่อเข้ากับแอป ---------------- */
(function () {
  const _ra = renderAll;
  renderAll = function () { _ra(); try { rvRender(); rvMap(); } catch (e) { console.error("river", e); } };
  const cb = document.getElementById("lyRiver");
  if (cb) cb.addEventListener("change", () => {
    if (typeof map === "undefined" || !map) return;
    rvMap();
    if (cb.checked && rvChain.length > 1) map.fitBounds(L.latLngBounds(rvChain.map(x => [x.st.lat, x.st.lon]).concat([[RV_MOUTH.lat, RV_MOUTH.lon]])).pad(0.1));
  });
  if (typeof DATA !== "undefined" && DATA) { try { rvRender(); rvMap(); } catch (e) { console.error("river", e); } }
})();
