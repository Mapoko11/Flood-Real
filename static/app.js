/* Flood real — หน้าเว็บ (อ่านจาก /api/data อย่างเดียว) */
"use strict";
/* STATIC = true เมื่อเป็นเว็บบน GitHub Pages (ไม่มี server) -> อ่านไฟล์ข้อมูลตรง + เรียก RainViewer เอง */
const STATIC = !!window.FLOOD_STATIC;
const PROXY = String(window.FLOOD_PROXY || "").replace(/\/$/, "");   // Cloudflare Worker (เว็บ github.io) — ซ่อน key TomTom
const TR_OK = !STATIC || !!PROXY;                                    // ใช้ค้นรถติด/เส้นทางได้ไหม
const TR_API = {
  traffic: q => STATIC ? `${PROXY}/traffic?q=${encodeURIComponent(q)}` : `/api/traffic?q=${encodeURIComponent(q)}`,
  route: (a,b) => STATIC ? `${PROXY}/route?from=${encodeURIComponent(a)}&to=${encodeURIComponent(b)}` : `/api/route?from=${encodeURIComponent(a)}&to=${encodeURIComponent(b)}`,
  tile: STATIC ? `${PROXY}/tile/{z}/{x}/{y}.png` : "/api/traffic-tile/{z}/{x}/{y}.png",
  usage: STATIC ? `${PROXY}/usage` : "/api/traffic-usage",
};
const API = {
  data:   () => STATIC ? "data/latest.json?t=" + Date.now() : "/api/data",
  gistda: p  => STATIC ? `data/gistda_${encodeURIComponent(p)}.json` : "/api/gistda.geojson?period=" + encodeURIComponent(p),
};
let _rvCache = {at:0, data:null};
async function getRadar(){
  if(!STATIC) return fetch("/api/radar",{cache:"no-store"}).then(r=>r.json());
  if(_rvCache.data && Date.now()-_rvCache.at < 5*60*1000) return _rvCache.data;
  const js = await fetch("https://api.rainviewer.com/public/weather-maps.json").then(r=>r.json());
  const frames = [];
  for(const k of ["past","nowcast"]) for(const f of ((js.radar||{})[k]||[])) frames.push({time:f.time, path:f.path, now:k==="nowcast"});
  if(!/^https:\/\//.test(js.host||"") || !frames.length) return {ok:false, error:"RainViewer format"};
  _rvCache = {at:Date.now(), data:{ok:true, host:js.host, frames}};
  return _rvCache.data;
}

const WL = {1:["น้อยวิกฤต","#db802b"],2:["น้อย","#ffc000"],3:["ปกติ","#00b050"],4:["น้ำมาก","#3b82f6"],5:["ล้นตลิ่ง","#ef4444"],0:["ไม่มีข้อมูล","#64748b"]};
const RAIN = {0:["ไม่มีฝน","#64748b"],1:["เล็กน้อย","#a5f3fc"],2:["ปานกลาง","#38bdf8"],3:["หนัก","#22c55e"],4:["หนักมาก","#f97316"]};
const DAM = {1:["วิกฤต","#db802b"],2:["น้อย","#ffc000"],3:["ปกติ","#00b050"],4:["มาก","#3b82f6"],5:["เกินความจุ","#ef4444"],0:["ไม่มีข้อมูล","#64748b"]};
const SRC_NAME = {waterlevel:"ระดับน้ำ",rain:"ฝน",main:"เขื่อน/คาดการณ์",gistda:"GISTDA",tmd:"กรมอุตุฯ",traffy:"Traffy",bma:"ถนน กทม.",bma_canal:"คลอง กทม."};
const CANAL = {critical:["ถึงระดับวิกฤต","#ef4444"],warning:["เฝ้าระวัง","#f59e0b"],normal:["ปกติ","#22c55e"],down:["ขัดข้อง","#64748b"]};
const BMA = {flood:["น้ำท่วม","#ef4444"],minor:["ท่วมขังเล็กน้อย","#f59e0b"],normal:["ปกติ","#22c55e"],down:["ขัดข้อง","#64748b"],unknown:["ไม่ทราบ","#64748b"]};
function bmaWet(p){ return p.state==="flood" || p.state==="minor"; }
const TF_COLOR = {"รอรับเรื่อง":"#ef4444","กำลังดำเนินการ":"#f59e0b","ส่งต่อ":"#a855f7","เสร็จสิ้น":"#22c55e"};
function tfColor(st){ return TF_COLOR[st] || "#94a3b8"; }
function tfOpen(it){ return !/เสร็จสิ้น|ยกเลิก|ไม่เกี่ยวข้อง/.test(it.state||""); }

let DATA = null, map, layers = {}, satPeriod = "1day", satShown = "";
const PERIOD_TH = {"1day":"ล่าสุด","3days":"3 วัน","7days":"7 วัน","30days":"30 วัน"};
function satCur(){ const g=(DATA&&DATA.gistda)||{}; return (g.periods||{})[satPeriod] || null; }
const $ = (s) => document.querySelector(s);

function esc(v){ return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fmt(v, d=1){ return (v===null||v===undefined||isNaN(v)) ? "-" : Number(v).toLocaleString("th-TH",{maximumFractionDigits:d,minimumFractionDigits:0}); }
function pill(tbl, lv){ const [t,c]=tbl[lv]||tbl[0]; return `<span class="pill" style="background:${c}">${esc(t)}</span>`; }
function safeUrl(u){ return /^https?:\/\//i.test(u||"") ? esc(u) : "#"; }
function q(){ return $("#q").value.trim().toLowerCase(); }
function match(o, keys){ const s=q(); if(!s) return true; return keys.some(k => String(o[k]||"").toLowerCase().includes(s)); }
function hasLL(o){ return typeof o.lat==="number" && typeof o.lon==="number" && Math.abs(o.lat)>0.1; }

/* ---------------- โหลดข้อมูล ---------------- */
async function load(){
  try{
    const r = await fetch(API.data(), {cache:"no-store"});
    DATA = await r.json();
    renderAll();
  }catch(e){
    $("#updated").textContent = "โหลดข้อมูลไม่ได้: " + e.message;
  }
}

let satUserPicked = false;
function prepSat(){
  const per = ((DATA.gistda||{}).periods)||{};
  if(!satUserPicked && !((per[satPeriod]||{}).count)){
    const first = Object.keys(PERIOD_TH).find(k => (per[k]||{}).count > 0);
    if(first) satPeriod = first;
  }
  document.querySelectorAll(".seg[data-seg=sat] button").forEach(b=>{
    const c = (per[b.dataset.p]||{}).count;
    b.textContent = PERIOD_TH[b.dataset.p] + (c!=null ? ` (${Number(c).toLocaleString("th-TH")})` : "");
    b.classList.toggle("active", b.dataset.p===satPeriod);
  });
}

function renderAll(){
  if(!DATA) return;
  try{ prepSat(); }catch(e){ console.error(e); }
  $("#updated").textContent = DATA.updated_at ? "อัปเดต " + DATA.updated_at.replace("T"," ") : "ยังไม่มีข้อมูล (รอรอบแรก)";
  for(const f of [renderKpis, renderStatus, renderMap, renderWl, renderRain, renderDam, renderSat, renderTraffy, renderBma, renderCanal, renderFc]){
    try{ f(); }catch(e){ console.error(f.name, e); }   // ส่วนไหนพัง ส่วนอื่นยังแสดง
  }
}

function renderKpis(){
  const wl = DATA.waterlevel||[], rain = DATA.rain||[], dams=(DATA.main||{}).dams||[];
  const cur = satCur();
  const k = [
    ["red", wl.filter(w=>w.level===5).length, "สถานีน้ำล้นตลิ่ง"],
    ["blue", wl.filter(w=>w.level===4).length, "สถานีน้ำมาก (>70%)"],
    ["purple", rain.filter(r=>r.rain>90).length, "สถานีฝนหนักมาก (>90 มม.)"],
    ["amber", dams.filter(d=>(d.pct||0)>80).length, "เขื่อนน้ำ >80%"],
    ["", cur ? (cur.provinces||[]).length : "–", "จังหวัดมีน้ำท่วม (ดาวเทียม " + PERIOD_TH[satPeriod] + ")"],
    ["", wl.length, "สถานีวัดระดับน้ำทั้งหมด"],
    ["red", (DATA.bma&&DATA.bma.count) ? (DATA.bma.count.flood||0)+(DATA.bma.count.minor||0) : "–", "ถนน กทม. น้ำท่วม (จุดวัด)"],
    ["red", ((DATA.traffy||{}).items||[]).filter(tfOpen).length, `แจ้งปัญหาค้าง (Traffy ${fmt((DATA.traffy||{}).hours||72,0)} ชม.)`],
  ];
  $("#kpis").innerHTML = k.map(([c,v,l])=>`<div class="kpi ${c}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");
}

function renderStatus(){
  const st = DATA.status||{};
  $("#srcStatus").innerHTML = Object.keys(SRC_NAME).map(k=>{
    const s = st[k]; const blk = DATA[k];
    let cls="off", tip="ยังไม่ดึง";
    if(s){ cls = s.ok ? "ok" : "bad"; tip = s.ok ? "ดึงได้ "+s.at : "ดึงไม่ได้: "+s.error; }
    if((k==="gistda"||k==="tmd") && blk && blk.configured===false){ cls="off"; tip="ยังไม่ได้ใส่ API key"; }
    return `<span class="src ${cls}" title="${esc(tip)}">${esc(SRC_NAME[k])}</span>`;
  }).join("");
}

/* ---------------- แผนที่ ---------------- */
function initMap(){
  map = L.map("map", {preferCanvas:true}).setView([13.2, 101.0], 6);
  const zcls = ()=>map.getContainer().classList.toggle("zoom-near", map.getZoom()>=12);
  map.on("zoomend", zcls); zcls();
  setBase(basemap);
  ["wl","rain","dam","sat","tf","bma","canal","tr"].forEach(n => layers[n] = L.layerGroup());
  layers.tr.addTo(map);
  $("#legend").innerHTML =
    "<b>ระดับน้ำ:</b> " + [5,4,3,2,1].map(l=>`<span><i class="dot" style="background:${WL[l][1]}"></i>${WL[l][0]}</span>`).join(" ") +
    " &nbsp; <b>ฝน:</b> " + [4,3,2,1].map(l=>`<span><i class="dot" style="background:${RAIN[l][1]}"></i>${RAIN[l][0]}</span>`).join(" ") +
    " &nbsp; <span>▲ = เขื่อน</span> &nbsp; <b>Traffy:</b> " +
    Object.entries(TF_COLOR).map(([k,c])=>`<span><i class="dot" style="background:${c};border-radius:2px"></i>${k}</span>`).join(" ") +
    " &nbsp; <b>คลอง กทม.:</b> " + ["critical","warning","normal"].map(k=>`<span><i class="dot" style="background:${CANAL[k][1]};border-radius:2px"></i>${CANAL[k][0]}</span>`).join(" ") +
    " &nbsp; <b>ถนน กทม.:</b> " + ["flood","minor","normal"].map(k=>`<span><i class="dot" style="background:${BMA[k][1]}"></i>${BMA[k][0]}</span>`).join(" ");
}

/* ---------------- พื้นหลังแผนที่ ---------------- */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const ATTR = "Tiles &copy; Esri | ข้อมูล: ThaiWater, GISTDA, กรมอุตุฯ";
const BASES = {
  street: () => [L.tileLayer(ESRI+"World_Street_Map/MapServer/tile/{z}/{y}/{x}", {maxZoom:18, attribution:ATTR})],
  sat: () => [
    L.tileLayer(ESRI+"World_Imagery/MapServer/tile/{z}/{y}/{x}", {maxZoom:18, attribution:ATTR}),
    L.tileLayer(ESRI+"Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {maxZoom:18}),
  ],
  dark: () => [
    L.tileLayer(ESRI+"Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {maxZoom:16, attribution:ATTR}),
    // ตัวอักษรชั้นบน เร่งความสว่างให้อ่านง่าย (class lbl-bright ใน CSS)
    L.tileLayer(ESRI+"Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {maxZoom:16, className:"lbl-bright"}),
  ],
};
let basemap = "street", baseLayers = [], sizeK = 1, locMarker = null;
function setBase(name){
  if(!BASES[name]) return;
  basemap = name;
  baseLayers.forEach(l => map.removeLayer(l));
  baseLayers = BASES[name]();
  baseLayers.forEach(l => l.addTo(map));
  baseLayers.slice().reverse().forEach(l => l.bringToBack());   // ภาพพื้นอยู่ล่างสุด ตัวอักษรอยู่บน
  document.querySelectorAll(".seg[data-seg=base] button").forEach(b => b.classList.toggle("active", b.dataset.b===name));
  $("#map").classList.toggle("light", name!=="dark");
}

/* ซูมไปยังจุดที่ตรงกับคำค้น (เรียกเฉพาะตอนพิมพ์ค้นหา) */
function zoomToSearch(){
  if(!map || !q()) return;
  const pts = [];
  (DATA.waterlevel||[]).filter(hasLL).filter(w=>match(w,["name","province","amphoe","basin","river"])).forEach(w=>pts.push([w.lat,w.lon]));
  ((DATA.main||{}).dams||[]).filter(hasLL).filter(d=>match(d,["name","province","basin"])).forEach(d=>pts.push([d.lat,d.lon]));
  if($("#lyRain").checked) (DATA.rain||[]).filter(hasLL).filter(r=>match(r,["name","province","amphoe"])).forEach(r=>pts.push([r.lat,r.lon]));
  if(pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), {maxZoom:11});
}

function popupWl(w){
  return `<b>${esc(w.name)}</b><br>${esc(w.amphoe)} ${esc(w.province)}<br>
    ${w.river?("แม่น้ำ: "+esc(w.river)+"<br>"):""}ลุ่มน้ำ: ${esc(w.basin)}<br>
    ระดับน้ำ ${fmt(w.wl_msl,2)} ม.รทก. (${fmt(w.bank_pct,0)}% ตลิ่ง) ${pill(WL,w.level)}<br>
    <small>${esc(w.time)} · ${esc(w.agency)}</small>`;
}

function renderMap(){
  if(typeof L==="undefined"){ $("#map").innerHTML='<div class="note">โหลดแผนที่ไม่ได้</div>'; return; }
  if(!map) initMap();
  const risk = $("#onlyRisk").checked;
  Object.values(layers).forEach(l=>{ if(l!==layers.sat && l!==layers.tr) l.clearLayers(); });   // ผลค้นรถติดไม่ลบตอนรีเฟรช

  (DATA.waterlevel||[]).filter(hasLL).filter(w=>match(w,["name","province","amphoe","basin","river"]))
    .filter(w=>!risk || w.level>=4)
    .sort((a,b)=>a.level-b.level)
    .forEach(w=>{
      L.circleMarker([w.lat,w.lon],{radius: (w.level>=4?8:5)*sizeK, color:"#0b1220", weight:1,
        fillColor:(WL[w.level]||WL[0])[1], fillOpacity:.95}).bindPopup(popupWl(w)).addTo(layers.wl);
    });

  (DATA.rain||[]).filter(hasLL).filter(r=>r.level>0).filter(r=>match(r,["name","province","amphoe"]))
    .filter(r=>!risk || r.level>=3)
    .forEach(r=>{
      L.circleMarker([r.lat,r.lon],{radius:(3+r.level*2)*sizeK, stroke:false,
        fillColor:RAIN[r.level][1], fillOpacity:.6})
       .bindPopup(`<b>${esc(r.name)}</b><br>${esc(r.amphoe)} ${esc(r.province)}<br>ฝน 24 ชม. <b>${fmt(r.rain)}</b> มม. ${pill(RAIN,r.level)}<br><small>${esc(r.time)}</small>`)
       .addTo(layers.rain);
    });

  ((DATA.main||{}).dams||[]).filter(hasLL).filter(d=>match(d,["name","province","basin"]))
    .filter(d=>!risk || d.level>=4)
    .forEach(d=>{
      const c=(DAM[d.level]||DAM[0])[1];
      const icon = L.divIcon({className:"", html:`<div style="color:${c};font-size:${Math.round(20*sizeK)}px;line-height:1;text-shadow:0 0 3px #000">▲</div>`, iconSize:[20*sizeK,20*sizeK], iconAnchor:[10*sizeK,12*sizeK]});
      L.marker([d.lat,d.lon],{icon}).bindPopup(`<b>${esc(d.name)}</b><br>${esc(d.province)}<br>
        น้ำในอ่าง ${fmt(d.pct,0)}% ${pill(DAM,d.level)}<br>ไหลเข้า ${fmt(d.inflow,2)} · ระบาย ${fmt(d.released,2)} ล้าน ลบ.ม.<br><small>${esc(d.time)}</small>`)
       .addTo(layers.dam);
    });

  ((DATA.traffy||{}).items||[]).filter(hasLL).filter(t=>match(t,["district","subdistrict","province","address","desc"]))
    .filter(t=>!risk || tfOpen(t))
    .forEach(t=>{
      const c = tfColor(t.state);
      const icon = L.divIcon({className:"", html:`<div style="width:${Math.round(12*sizeK)}px;height:${Math.round(12*sizeK)}px;background:${c};border:2px solid #fff;border-radius:3px;transform:rotate(45deg);box-shadow:0 0 3px #000"></div>`,
        iconSize:[12*sizeK,12*sizeK], iconAnchor:[6*sizeK,6*sizeK]});
      L.marker([t.lat,t.lon],{icon}).bindPopup(tfPopup(t),{maxWidth:260}).addTo(layers.tf);
    });
  ((DATA.bma_canal||{}).points||[]).filter(hasLL).filter(p=>p.state!=="down")
    .filter(p=>match(p,["name","full","district"]))
    .filter(p=>!risk || p.state==="critical" || p.state==="warning")
    .forEach(p=>{
      const c = (CANAL[p.state]||CANAL.down)[1];
      L.circleMarker([p.lat,p.lon],{radius:5*sizeK, color:"#fff", weight:1.5, fillColor:c, fillOpacity:.95})
        .bindTooltip(`${fmt(p.wl_in,2)}`, {permanent:true, direction:"right", offset:[5,0], className:"canal-lbl", opacity:1})
        .bindPopup(canalPopup(p)).addTo(layers.canal);
    });

  ((DATA.bma||{}).points||[]).filter(hasLL).filter(p=>p.state!=="down" && p.state!=="unknown")
    .filter(p=>match(p,["name","road","district"]))
    .filter(p=>!risk || bmaWet(p))
    .sort((a,b)=>(bmaWet(a)?1:0)-(bmaWet(b)?1:0))
    .forEach(p=>{
      const c = (BMA[p.state]||BMA.unknown)[1];
      let mk;
      if(bmaWet(p)){
        const icon = L.divIcon({className:"", html:`<div class="bma-pin" style="background:${c};font-size:${Math.round(12*sizeK)}px">${fmt(p.cm,0)} ซม.</div>`, iconSize:null, iconAnchor:[18,10]});
        mk = L.marker([p.lat,p.lon],{icon, zIndexOffset:500});
      } else {
        mk = L.circleMarker([p.lat,p.lon],{radius:4*sizeK, color:"#fff", weight:1, fillColor:c, fillOpacity:.9});
      }
      mk.bindPopup(bmaPopup(p)).addTo(layers.bma);
    });
  loadSat();
  syncLayers();
}

function canalPopup(p){
  const row=(t,v,w,c)=>v==null?"":`<tr><td>${t}</td><td class="num"><b>${fmt(v,2)}</b></td><td class="num">${w==null?"-":fmt(w,2)}</td><td class="num">${c==null?"-":fmt(c,2)}</td></tr>`;
  return `<b>🏙️ ${esc(p.name)}</b> ${pill(CANAL,p.state)}<br><small>${esc(p.full)} · เขต${esc(p.district)}</small>
    <table class="canal-tbl"><tr><th></th><th>ระดับน้ำ</th><th>เฝ้าระวัง</th><th>วิกฤต</th></tr>
    ${row("ในคลอง",p.wl_in,p.warn,p.crit)}${row("นอกประตู 1",p.wl_out1,p.warn_out1,p.crit_out1)}${row("นอกประตู 2",p.wl_out2,null,null)}</table>
    <small>หน่วย ม.รทก.${p.max_today!=null?` · สูงสุดวันนี้ ${fmt(p.max_today,2)}`:""}${p.gates&&p.gates.length?` · ประตูน้ำ: ${esc(p.gates.join(" / "))}`:""}<br>
    เวลา ${esc(p.time||"-")} · สำนักการระบายน้ำ กทม.</small>`;
}

function bmaPopup(p){
  return `<b>🚗 ${esc(p.name)}</b><br>${esc(p.road)} · เขต${esc(p.district)}<br>
    ระดับน้ำบนถนน <b>${fmt(p.cm,1)} ซม.</b> ${pill(BMA,p.state)}${p.max_cm!=null&&bmaWet(p)?`<br>สูงสุดรอบนี้ ${fmt(p.max_cm,1)} ซม.`:""}
    ${p.since?`<br>เริ่มท่วม ${esc(p.since.replace("T"," "))}`:""}<br>
    <small>วัดเมื่อ ${esc((p.time||"-").replace("T"," "))} · สำนักการระบายน้ำ กทม.</small>`;
}

function loadSat(force){
  const cur = satCur();
  const key = satPeriod + "|" + (cur ? cur.at : "");
  if(!force && key === satShown) return;
  satShown = key;
  layers.sat.clearLayers();
  if(!cur || !cur.count) return;
  const want = satPeriod;
  fetch(API.gistda(want)).then(r=>r.json()).then(g=>{
    if(want !== satPeriod) return;   // ผู้ใช้กดเปลี่ยนช่วงไปแล้ว
    layers.sat.clearLayers();
    L.geoJSON(g,{style:{color:"#ef4444",weight:1,fillColor:"#ef4444",fillOpacity:.45},
      onEachFeature:(f,ly)=>{ const p=f.properties||{}; ly.bindPopup(`<b>พื้นที่น้ำท่วม (GISTDA)</b><br>
        ${esc(p.tb_tn||"")} ${esc(p.ap_tn||"")} ${esc(p.pv_tn||"")}<br>
        ขนาด ~${fmt((p.f_area||0)/1600,1)} ไร่ · ประชากร ${fmt(p.population,0)} · อาคาร ${fmt(p.building,0)}<br>
        <small>ภาพดาวเทียม ${esc(p.file_name||"")}</small>`); }
    }).addTo(layers.sat);
  }).catch(()=>{ satShown=""; });
}

function syncLayers(){
  const m = {wl:"#lyWl", rain:"#lyRain", dam:"#lyDam", sat:"#lySat", tf:"#lyTraffy", bma:"#lyBma", canal:"#lyCanal"};
  for(const [k,sel] of Object.entries(m)){
    if($(sel).checked) layers[k].addTo(map); else map.removeLayer(layers[k]);
  }
}

/* ---------------- ตาราง ---------------- */
function renderWl(){
  const lv = $("#wlLevel").value;
  const rows = (DATA.waterlevel||[]).filter(w=>match(w,["name","province","amphoe","basin","river"]))
    .filter(w=>!lv || String(w.level)===lv)
    .sort((a,b)=>(b.bank_pct??-1)-(a.bank_pct??-1));
  $("#wlCount").textContent = `${rows.length} สถานี`;
  $("#wlTable").innerHTML = `<thead><tr><th>สถานี</th><th>จังหวัด / อำเภอ</th><th>ลุ่มน้ำ / แม่น้ำ</th>
    <th class="num">ระดับน้ำ (ม.รทก.)</th><th>% ความจุลำน้ำ</th><th>สถานการณ์</th><th>เวลา</th></tr></thead><tbody>` +
    rows.map(w=>{
      const p = Math.max(0, Math.min(100, w.bank_pct||0)); const c=(WL[w.level]||WL[0])[1];
      const trend = (w.wl_msl!=null && w.wl_prev!=null) ? (w.wl_msl>w.wl_prev?" ▲":(w.wl_msl<w.wl_prev?" ▼":"")) : "";
      return `<tr><td>${esc(w.name)}</td><td>${esc(w.province)} / ${esc(w.amphoe)}</td>
        <td>${esc(w.basin)}${w.river?" / "+esc(w.river):""}</td>
        <td class="num">${fmt(w.wl_msl,2)}${trend}</td>
        <td><div style="display:flex;gap:8px;align-items:center"><div class="bar" style="flex:1"><i style="width:${p}%;background:${c}"></i></div>${fmt(w.bank_pct,0)}%</div></td>
        <td>${pill(WL,w.level)}</td><td class="muted">${esc(w.time)}</td></tr>`;
    }).join("") + "</tbody>";
}

function renderRain(){
  const rows = (DATA.rain||[]).filter(r=>match(r,["name","province","amphoe","basin"])).slice(0,500);
  $("#rainCount").textContent = `แสดง ${rows.length} สถานี (เรียงจากฝนมากสุด)`;
  $("#rainTable").innerHTML = `<thead><tr><th>#</th><th>สถานี</th><th>จังหวัด / อำเภอ</th><th>ลุ่มน้ำ</th>
    <th class="num">ฝน 24 ชม. (มม.)</th><th>ระดับ</th><th>เวลา</th></tr></thead><tbody>` +
    rows.map((r,i)=>`<tr><td class="muted">${i+1}</td><td>${esc(r.name)}</td><td>${esc(r.province)} / ${esc(r.amphoe)}</td>
      <td>${esc(r.basin)}</td><td class="num"><b>${fmt(r.rain)}</b></td><td>${pill(RAIN,r.level)}</td>
      <td class="muted">${esc(r.time)}</td></tr>`).join("") + "</tbody>";
}

function renderDam(){
  const dams = ((DATA.main||{}).dams||[]).filter(d=>match(d,["name","province","basin"]));
  if(!dams.length){ $("#damBars").innerHTML = `<div class="note">ยังไม่มีข้อมูลเขื่อน</div>`; return; }
  $("#damBars").innerHTML = dams.map(d=>{
    const p = Math.max(0, Math.min(100, d.pct||0)); const c=(DAM[d.level]||DAM[0])[1];
    return `<div class="dam"><div class="t"><b>${esc(d.name)}</b>${pill(DAM,d.level)}</div>
      <div class="bar"><i style="width:${p}%;background:${c}"></i></div>
      <div class="sub">น้ำในอ่าง <b style="color:var(--text)">${fmt(d.pct,1)}%</b> (${fmt(d.storage,0)} ล้าน ลบ.ม.)
       · ใช้การได้ ${fmt(d.uses_pct,1)}%<br>ไหลเข้า ${fmt(d.inflow,2)} · ระบาย ${fmt(d.released,2)} ล้าน ลบ.ม./วัน
       · ${esc(d.province)} · ${esc(d.time)}</div></div>`;
  }).join("");
}

function renderSat(){
  const g = DATA.gistda||{};
  if(!g.configured){
    $("#satBox").innerHTML = `<div class="note">ยังไม่ได้ใส่ <b>GISTDA_API_KEY</b> — สมัครฟรีที่
      <a href="https://api-gateway.gistda.or.th" target="_blank" rel="noopener">api-gateway.gistda.or.th</a>
      แล้วใส่ใน <code>config_local.json</code> จะเห็นพื้นที่น้ำท่วมจากดาวเทียมบนแผนที่และตารางนี้<br>
      ระหว่างนี้ดูแผนที่ทางการได้ที่ <a href="https://flood.gistda.or.th" target="_blank" rel="noopener">flood.gistda.or.th</a></div>`;
    return;
  }
  const cur = satCur();
  if(!cur){ $("#satInfo").textContent=""; $("#satBox").innerHTML = `<div class="note">ยังไม่มีข้อมูลช่วง ${esc(PERIOD_TH[satPeriod])} (รอรอบดึงถัดไป)</div>`; return; }
  const part = (cur.shown!=null && cur.shown<cur.count) ? ` (แผนที่แสดง ${fmt(cur.shown,0)})` : "";
  $("#satInfo").textContent = `${fmt(cur.count,0)} พื้นที่${part} · รวม ${fmt(cur.rai,0)} ไร่ · ประชากรในพื้นที่ ~${fmt(cur.population,0)} คน · อาคาร ${fmt(cur.building,0)}`
    + (cur.ok ? ` · ดึงเมื่อ ${String(cur.at||"").replace("T"," ")}` : ` · ⚠ ดึงรอบล่าสุดไม่ได้ (แสดงข้อมูลเดิม)`);
  const rows = (cur.provinces||[]).filter(p=>match(p,["province"]));
  if(!rows.length){ $("#satBox").innerHTML = `<div class="note">ดาวเทียมไม่พบพื้นที่น้ำท่วมในช่วง ${esc(PERIOD_TH[satPeriod])} 🎉</div>`; return; }
  $("#satBox").innerHTML = `<div class="table-wrap"><table><thead><tr><th>จังหวัด</th><th class="num">อำเภอ</th><th class="num">จำนวนพื้นที่</th><th class="num">พื้นที่ (ไร่)</th>
    <th class="num">ประชากร</th><th class="num">อาคาร</th><th class="num">โรงเรียน</th><th class="num">โรงพยาบาล</th></tr></thead><tbody>` +
    rows.map(p=>`<tr><td>${esc(p.province)}</td><td class="num">${fmt(p.amphoe,0)}</td><td class="num">${fmt(p.count,0)}</td>
      <td class="num"><b>${fmt(p.rai,0)}</b></td><td class="num">${fmt(p.population,0)}</td><td class="num">${fmt(p.building,0)}</td>
      <td class="num">${fmt(p.school,0)}</td><td class="num">${fmt(p.hospital,0)}</td></tr>`).join("") +
    `</tbody></table></div>`;
}

function tfPopup(t){
  return `<div class="tf-pop"><b>แจ้งปัญหา (Traffy)</b> <span class="pill" style="background:${tfColor(t.state)}">${esc(t.state||"-")}</span><br>
    ${t.photo?`<a href="${safeUrl(t.photo)}" target="_blank" rel="noopener"><img loading="lazy" src="${safeUrl(t.photo)}" alt=""></a>`:""}
    ${esc(t.desc)}<br><small>${esc(t.address)}<br>แจ้ง ${esc(t.time)} · ล่าสุด ${esc(t.last)}${t.org?"<br>หน่วยงาน: "+esc(t.org):""}<br>#${esc(t.id)}</small></div>`;
}

function renderTraffy(){
  const tf = DATA.traffy || {};
  if(tf.configured===false){ $("#tfInfo").textContent="ปิดการดึง Traffy อยู่ (TRAFFY_ENABLED)"; return; }
  const sel = $("#tfState").value;
  const items = (tf.items||[]).filter(t=>match(t,["district","subdistrict","province","address","desc"]))
    .filter(t=> !sel ? true : sel==="open" ? tfOpen(t) : t.state===sel);
  const st = tf.by_state||{};
  $("#tfInfo").textContent = `${fmt(items.length,0)} เรื่อง (ย้อนหลัง ${fmt(tf.hours||72,0)} ชม. · ตรวจทั้งหมด ${fmt(tf.scanned||0,0)} เรื่อง) · ` +
    Object.entries(st).map(([k,v])=>`${k} ${v}`).join(" / ");
  const dist = {};
  items.forEach(t=>{ const k=t.district||"ไม่ระบุ"; (dist[k] ||= {n:0, prov:t.province}).n++; });
  const rows = Object.entries(dist).sort((a,b)=>b[1].n-a[1].n);
  $("#tfDist").innerHTML = `<thead><tr><th>เขต/อำเภอ</th><th>จังหวัด</th><th class="num">เรื่อง</th></tr></thead><tbody>` +
    (rows.length ? rows.map(([k,v])=>`<tr class="tf-row" data-d="${esc(k)}"><td>${esc(k)}</td><td>${esc(v.prov)}</td><td class="num"><b>${v.n}</b></td></tr>`).join("")
                 : `<tr><td colspan="3" class="muted">ไม่มีเรื่องแจ้ง 🎉</td></tr>`) + "</tbody>";
  $("#tfList").innerHTML = items.slice(0,300).map((t,i)=>`<div class="tf-item" data-i="${i}">
      ${t.photo?`<img loading="lazy" src="${safeUrl(t.photo)}" alt="">`:""}
      <div class="d"><span class="pill" style="background:${tfColor(t.state)}">${esc(t.state||"-")}</span>
        <b>${esc(t.district)}</b> ${esc(t.subdistrict)} <span class="muted">· ${esc(t.time)}</span><br>${esc(t.desc)}</div></div>`).join("")
    || `<div class="note">ไม่มีเรื่องแจ้งปัญหาในช่วงนี้</div>`;
  $("#tfList").querySelectorAll(".tf-item").forEach(el=>el.addEventListener("click",()=>{
    const t = items[Number(el.dataset.i)];
    if(!t || !hasLL(t) || !map) return;
    document.querySelector('#tabs button[data-tab=map]').click();
    $("#lyTraffy").checked = true; syncLayers();
    setTimeout(()=>{ map.setView([t.lat,t.lon], 16); L.popup({maxWidth:260}).setLatLng([t.lat,t.lon]).setContent(tfPopup(t)).openOn(map); }, 120);
  }));
}

function renderBma(){
  const b = DATA.bma || {};
  const st = (DATA.status||{}).bma;
  if(b.configured===false){ $("#bmaInfo").textContent="ปิดการดึงข้อมูล กทม. อยู่ (BMA_FLOOD_ENABLED)"; return; }
  if(!b.points){ $("#bmaInfo").textContent = st && !st.ok ? "ยังดึงข้อมูล กทม. ไม่ได้: "+st.error : "ยังไม่มีข้อมูล (รอรอบแรก)"; $("#bmaTable").innerHTML=""; return; }
  const sel = $("#bmaShow").value;
  const pts = b.points.filter(p=>match(p,["name","road","district"]))
    .filter(p=> sel==="wet" ? bmaWet(p) : sel==="ok" ? (p.state!=="down" && p.state!=="unknown") : true);
  const c = b.count||{};
  $("#bmaInfo").innerHTML = `น้ำท่วม <b style="color:${BMA.flood[1]}">${c.flood||0}</b> · ท่วมขังเล็กน้อย <b style="color:${BMA.minor[1]}">${c.minor||0}</b> · ปกติ ${c.normal||0} · ขัดข้อง ${c.down||0} จุด` +
    ` <span class="muted">· ดึงเมื่อ ${esc((b.at||"").replace("T"," "))}${st&&!st.ok?" (รอบล่าสุดดึงไม่ได้ ใช้ข้อมูลเดิม)":""} · <a href="${safeUrl(b.source)}" target="_blank" rel="noopener">สำนักการระบายน้ำ กทม.</a></span>`;
  $("#bmaTable").innerHTML = `<thead><tr><th>จุดวัด</th><th>ถนน</th><th>เขต</th><th class="num">ระดับน้ำ (ซม.)</th><th>สถานะ</th><th>เริ่มท่วม</th><th>เวลาวัด</th></tr></thead><tbody>` +
    (pts.length ? pts.map((p,i)=>`<tr class="bma-row" data-i="${i}"><td><b>${esc(p.name)}</b></td><td>${esc(p.road)}</td><td>${esc(p.district)}</td>
      <td class="num"><b>${fmt(p.cm,1)}</b></td><td>${pill(BMA,p.state)}</td><td>${esc((p.since||"").slice(5,16).replace("T"," "))}</td><td>${esc((p.time||"").slice(11,16))}</td></tr>`).join("")
      : `<tr><td colspan="7" class="muted">ไม่มีจุดน้ำท่วมถนนตอนนี้ 🎉</td></tr>`) + "</tbody>";
  $("#bmaTable").querySelectorAll(".bma-row").forEach(el=>el.addEventListener("click",()=>{
    const p = pts[Number(el.dataset.i)];
    if(!p || !hasLL(p) || !map) return;
    document.querySelector('#tabs button[data-tab=map]').click();
    $("#lyBma").checked = true; syncLayers();
    setTimeout(()=>{ map.setView([p.lat,p.lon], 16); L.popup().setLatLng([p.lat,p.lon]).setContent(bmaPopup(p)).openOn(map); }, 120);
  }));
}

function renderCanal(){
  const b = DATA.bma_canal || {};
  const box = $("#canalTable"); if(!box) return;
  if(!b.points){ const st=(DATA.status||{}).bma_canal; $("#canalInfo").textContent = st&&!st.ok ? "ยังดึงข้อมูลคลองไม่ได้: "+st.error : "ยังไม่มีข้อมูลคลอง"; box.innerHTML=""; return; }
  const c=b.count||{};
  $("#canalInfo").innerHTML = `ถึงระดับวิกฤต <b style="color:${CANAL.critical[1]}">${c.critical||0}</b> · เฝ้าระวัง <b style="color:${CANAL.warning[1]}">${c.warning||0}</b> · ปกติ ${c.normal||0} · ขัดข้อง ${c.down||0} สถานี <span class="muted">· <a href="${safeUrl(b.source)}" target="_blank" rel="noopener">สำนักการระบายน้ำ กทม.</a></span>`;
  const pts = b.points.filter(p=>p.state==="critical"||p.state==="warning").filter(p=>match(p,["name","full","district"]));
  box.innerHTML = `<thead><tr><th>สถานี (คลอง)</th><th>เขต</th><th class="num">ในคลอง</th><th class="num">เฝ้าระวัง</th><th class="num">วิกฤต</th><th>สถานะ</th><th>เวลา</th></tr></thead><tbody>` +
    (pts.length ? pts.map((p,i)=>`<tr class="bma-row" data-i="${i}"><td><b>${esc(p.name)}</b></td><td>${esc(p.district)}</td><td class="num"><b>${fmt(p.wl_in,2)}</b></td><td class="num">${fmt(p.warn,2)}</td><td class="num">${fmt(p.crit,2)}</td><td>${pill(CANAL,p.state)}</td><td>${esc(String(p.time||"").slice(-5))}</td></tr>`).join("")
      : `<tr><td colspan="7" class="muted">ไม่มีคลองที่ถึงเกณฑ์เฝ้าระวัง 🎉</td></tr>`) + "</tbody>";
  box.querySelectorAll(".bma-row").forEach(el=>el.addEventListener("click",()=>{
    const p = pts[Number(el.dataset.i)]; if(!p || !hasLL(p) || !map) return;
    document.querySelector('#tabs button[data-tab=map]').click();
    $("#lyCanal").checked = true; syncLayers();
    setTimeout(()=>{ map.setView([p.lat,p.lon], 15); L.popup().setLatLng([p.lat,p.lon]).setContent(canalPopup(p)).openOn(map); }, 120);
  }));
}

function renderFc(){
  const m = DATA.main||{};
  const card = i=>`<a href="${safeUrl(i.url)}" target="_blank" rel="noopener">
      <img loading="lazy" src="${safeUrl(i.thumb)}" alt=""><span>${esc(i.name||"")} · ${esc(i.time)}${i.tz==="UTC"?" UTC":""}</span></a>`;
  $("#fcImgs").innerHTML = (m.forecast||[]).length ? m.forecast.map(card).join("") : `<div class="note">ยังไม่มีภาพคาดการณ์ฝน</div>`;
  $("#rdImgs").innerHTML = (m.radar||[]).length ? m.radar.map(card).join("") : `<div class="note">ยังไม่มีภาพเรดาร์</div>`;
  const t = DATA.tmd||{};
  const st = (DATA.status||{}).tmd || {};
  const site = `<a href="https://www.tmd.go.th/warning-and-events/warning-storm" target="_blank" rel="noopener">tmd.go.th</a>`;
  const items = t.items||[];
  let head = "";
  if(st.ok===false) head = `<div class="note">⚠ ดึงประกาศจากกรมอุตุฯ ไม่ได้รอบล่าสุด (เว็บช้า/ล่ม) ${items.length?"— แสดงข้อมูลเดิม":""} · ดูที่ ${site}</div>`;
  $("#tmdBox").innerHTML = head + (items.length ? items.map(w=>`<div class="warn"><b>${esc(w.title)}</b>
      <div class="muted">${esc(w.time)}${w.link?` · <a href="${safeUrl(w.link)}" target="_blank" rel="noopener">อ่านต่อ</a>`:""}</div>${esc(w.body)}</div>`).join("")
    : (st.ok===false ? "" : `<div class="note">ไม่มีประกาศเตือนภัยใหม่ในรอบ ${esc(t.max_age_days||14)} วัน
        ${t.feed_latest ? `(ประกาศล่าสุดในฟีดของกรมอุตุฯ: ${esc(t.feed_latest)} — ฟีดนี้อาจไม่อัปเดตแล้ว)` : ""}
        · ดูประกาศล่าสุดที่ ${site}</div>`));
}

/* ---------------- event ---------------- */
document.querySelectorAll("#tabs button").forEach(b=>b.addEventListener("click",()=>{
  document.querySelectorAll("#tabs button").forEach(x=>x.classList.toggle("active",x===b));
  document.querySelectorAll(".panel").forEach(p=>p.classList.toggle("active",p.id==="tab-"+b.dataset.tab));
  if(b.dataset.tab==="map" && map) setTimeout(()=>map.invalidateSize(),50);
}));
let qTimer; $("#q").addEventListener("input",()=>{ clearTimeout(qTimer); qTimer=setTimeout(()=>{ renderAll(); zoomToSearch(); },350); });
document.querySelectorAll(".seg[data-seg=base] button").forEach(b=>b.addEventListener("click",()=>map && setBase(b.dataset.b)));
$("#mSize").addEventListener("input", e=>{ sizeK = Number(e.target.value)||1; $("#mSizeV").textContent = sizeK.toFixed(1)+"x"; renderMap(); });
$("#btnFull").addEventListener("click", ()=>{
  const box = $("#tab-map");   // เต็มจอทั้งแผง ปุ่มควบคุมยังกดได้
  if(document.fullscreenElement) document.exitFullscreen();
  else if(box.requestFullscreen) box.requestFullscreen().catch(()=>box.classList.toggle("pseudo-full"));
  else box.classList.toggle("pseudo-full");
  setTimeout(()=>map && map.invalidateSize(), 150);
});
document.addEventListener("fullscreenchange", ()=>{
  $("#btnFull").textContent = document.fullscreenElement ? "⤡ ออกจากเต็มจอ" : "⛶ เต็มจอ";
  setTimeout(()=>map && map.invalidateSize(), 150);
});
$("#btnHome").addEventListener("click", ()=>map && map.setView([13.2,101.0],6));
/* ตำแหน่งฉัน: ขอ GPS ความแม่นยำสูง แล้ว "ฟังต่อ" สักพัก เพราะค่าแรกมักมาจากเสาสัญญาณ/Wi-Fi (คลาดหลาย กม.)
   ค่าจะค่อยๆ แม่นขึ้นเมื่อ GPS จับดาวเทียมได้ -> อัปเดตหมุดตามค่าที่แม่นที่สุด หยุดเมื่อ <= 30 ม. หรือครบ 25 วินาที */
let locWatch = null, locCircle = null, locBest = null, locTimer = null;
function locStop(){
  if(locWatch !== null){ navigator.geolocation.clearWatch(locWatch); locWatch = null; }
  clearTimeout(locTimer); $("#btnLocate").disabled = false; $("#btnLocate").textContent = "📍 ตำแหน่งฉัน";
}
function locDraw(p, first){
  const ll = [p.coords.latitude, p.coords.longitude], acc = p.coords.accuracy;
  if(locMarker) map.removeLayer(locMarker);
  if(locCircle) map.removeLayer(locCircle);
  locCircle = L.circle(ll, {radius:acc, color:"#22d3ee", weight:1, fillColor:"#22d3ee", fillOpacity:.12}).addTo(map);
  locMarker = L.circleMarker(ll,{radius:9,color:"#fff",weight:3,fillColor:"#22d3ee",fillOpacity:1})
    .bindPopup(`ตำแหน่งของคุณ<br>ความแม่นยำ ±${fmt(acc,0)} ม.` + (acc>500 ? `<br><small>ยังไม่แม่น — เปิด GPS / ตำแหน่งแบบแม่นยำ แล้วออกที่โล่ง</small>` : "")).addTo(map);
  if(first) map.setView(ll, acc > 2000 ? 12 : 15); else map.panTo(ll);
  alertMsg(`📍 ความแม่นยำ ±${fmt(acc,0)} ม.` + (locWatch!==null ? " (กำลังปรับให้แม่นขึ้น…)" : ""));
}
$("#btnLocate").addEventListener("click", ()=>{
  if(!map) return;
  if(!navigator.geolocation){ alertMsg("เบราว์เซอร์นี้หาตำแหน่งไม่ได้"); return; }
  if(!window.isSecureContext){ alertMsg("หาตำแหน่งได้เฉพาะเว็บ https (เช่น github.io) หรือ 127.0.0.1"); return; }
  locStop(); locBest = null;
  $("#btnLocate").disabled = true; $("#btnLocate").textContent = "📍 กำลังหา…";
  locWatch = navigator.geolocation.watchPosition(p=>{
    const first = !locBest;
    if(first || p.coords.accuracy < locBest.coords.accuracy){ locBest = p; locDraw(p, first); }
    if(p.coords.accuracy <= 30){ locStop(); locDraw(locBest, false); }
  }, err=>{
    locStop();
    const why = {1:"ไม่ได้อนุญาตให้เว็บใช้ตำแหน่ง", 2:"หาสัญญาณตำแหน่งไม่ได้", 3:"หมดเวลา"}[err.code] || err.message;
    if(!locBest) alertMsg("หาตำแหน่งไม่ได้: " + why);
  }, {enableHighAccuracy:true, maximumAge:0, timeout:20000});
  locTimer = setTimeout(()=>{ locStop(); if(locBest) locDraw(locBest, false); }, 25000);
});
function alertMsg(t){ $("#updated").textContent = t; }

/* ---------------- เรดาร์ฝน RainViewer ---------------- */
const radar = {frames:[], layers:[], idx:0, timer:null, loadedAt:0, host:"", opacity:0.7};
function rdFmt(t){ return new Date(t*1000).toLocaleString("th-TH",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}); }
async function radarLoad(){
  if(Date.now() - radar.loadedAt < 5*60*1000 && radar.frames.length) return;
  const j = await getRadar();
  if(!j.ok){ $("#rdTime").textContent = "โหลดเรดาร์ไม่ได้"; return; }
  radarClear();
  radar.host = j.host; radar.frames = j.frames; radar.loadedAt = Date.now();
  radar.layers = radar.frames.map(f => L.tileLayer(`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
    opacity:0, maxNativeZoom:7, maxZoom:18, zIndex:300, attribution:'Weather data by <a href="https://www.rainviewer.com/">RainViewer</a>'}));
  const lastPast = radar.frames.map(f=>f.now).lastIndexOf(false);
  $("#rdFrame").max = radar.frames.length-1;
  radarShow(lastPast >= 0 ? lastPast : radar.frames.length-1);
}
function radarClear(){
  radarStop(); radar.layers.forEach(l=>map.removeLayer(l)); radar.layers = []; radar.frames = [];
}
function radarShow(i){
  if(!radar.layers.length) return;
  radar.idx = (i + radar.layers.length) % radar.layers.length;
  radar.layers.forEach((l,k)=>{
    if(k===radar.idx || k===(radar.idx+1)%radar.layers.length){ if(!map.hasLayer(l)) l.addTo(map); } // โหลดเฟรมถัดไปรอไว้
    l.setOpacity(k===radar.idx ? radar.opacity : 0);
  });
  const f = radar.frames[radar.idx];
  $("#rdFrame").value = radar.idx;
  $("#rdTime").textContent = rdFmt(f.time) + (f.now ? " (คาดการณ์)" : "");
}
function radarStop(){ if(radar.timer){ clearInterval(radar.timer); radar.timer=null; } $("#rdPlay").textContent="▶ เล่น"; }
function radarPlay(){
  if(radar.timer){ radarStop(); return; }
  $("#rdPlay").textContent="⏸ หยุด";
  radar.timer = setInterval(()=>radarShow(radar.idx+1), 700);
}
$("#lyRadar").addEventListener("change", async e=>{
  if(!map) return;
  $("#radarBar").hidden = !e.target.checked;
  if(e.target.checked){ try{ await radarLoad(); }catch(err){ $("#rdTime").textContent="โหลดเรดาร์ไม่ได้"; } }
  else radarClear();
});
$("#rdPlay").addEventListener("click", radarPlay);
$("#rdFrame").addEventListener("input", e=>{ radarStop(); radarShow(Number(e.target.value)); });
$("#rdOpacity").addEventListener("input", e=>{ radar.opacity = Number(e.target.value); radarShow(radar.idx); });
/* เรดาร์เล็กในแท็บพยากรณ์ (แยกจากแผนที่ใหญ่) */
const fcr = {map:null, layers:[], frames:[], idx:0, timer:null, loadedAt:0, playing:true};
async function fcRadarInit(){
  if(typeof L==="undefined") return;
  if(!fcr.map){
    fcr.map = L.map("fcMap",{zoomControl:true, attributionControl:true}).setView([13.2,101.0],5);
    L.tileLayer(ESRI+"World_Street_Map/MapServer/tile/{z}/{y}/{x}",{maxZoom:10, attribution:ATTR}).addTo(fcr.map);
  }
  setTimeout(()=>fcr.map.invalidateSize(),60);
  if(Date.now()-fcr.loadedAt < 5*60*1000 && fcr.layers.length){ fcRadarRun(); return; }
  try{
    const j = await getRadar();
    if(!j.ok) throw new Error(j.error||"");
    fcr.layers.forEach(l=>fcr.map.removeLayer(l));
    fcr.frames = j.frames.filter(f=>!f.now);
    fcr.layers = fcr.frames.map(f=>L.tileLayer(`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`,{opacity:0, maxNativeZoom:7, maxZoom:10, zIndex:300}).addTo(fcr.map));
    fcr.loadedAt = Date.now(); fcr.idx = fcr.layers.length-1; fcShow(fcr.idx); fcRadarRun();
  }catch(e){ $("#fcRdTime").textContent = "โหลดเรดาร์ไม่ได้"; }
}
function fcShow(i){
  if(!fcr.layers.length) return;
  fcr.idx = (i+fcr.layers.length)%fcr.layers.length;
  fcr.layers.forEach((l,k)=>l.setOpacity(k===fcr.idx?0.75:0));
  $("#fcRdTime").textContent = rdFmt(fcr.frames[fcr.idx].time);
}
function fcRadarRun(){
  clearInterval(fcr.timer); fcr.timer=null;
  const visible = document.querySelector("#tab-fc").classList.contains("active");
  if(fcr.playing && visible) fcr.timer = setInterval(()=>fcShow(fcr.idx+1), 800);
  $("#fcRdPlay").textContent = fcr.playing ? "⏸ หยุด" : "▶ เล่น";
}
$("#fcRdPlay").addEventListener("click", ()=>{ fcr.playing=!fcr.playing; fcRadarRun(); });
$("#fcRdOpen").addEventListener("click", ()=>{
  document.querySelector('#tabs button[data-tab=map]').click();
  const cb=$("#lyRadar"); if(!cb.checked){ cb.checked=true; cb.dispatchEvent(new Event("change")); }
});
document.querySelectorAll("#tabs button").forEach(b=>b.addEventListener("click",()=>{
  if(b.dataset.tab==="fc") fcRadarInit(); else fcRadarRun();   // ออกจากแท็บ -> หยุดวน ประหยัดเครื่อง
}));

/* ---------------- รถติด (TomTom) — ใช้ได้เฉพาะเว็บที่มี server (key อยู่ฝั่ง server) ---------------- */
const TR_COLOR = {0:"#94a3b8",1:"#facc15",2:"#f97316",3:"#ef4444",4:"#7f1d1d"};
const TR_QUICK = ["วิภาวดีรังสิต","พหลโยธิน","พระราม 2","บางนา-ตราด","รามอินทรา","แจ้งวัฒนะ","ลาดพร้าว","สุขุมวิท"];
let flowLayer = null, trLast = null;
function trPin(txt, bg){ return L.divIcon({className:"", html:`<div class="tr-pin" style="border:2px solid ${bg}">${esc(txt)}</div>`, iconSize:null}); }
function trCard(it, i){
  const c = TR_COLOR[it.magnitude] || TR_COLOR[0];
  const jam = it.cat === 6;
  return `<div class="tr-item" data-i="${i}" style="border-left-color:${c}">
    <div class="h"><span class="pill" style="background:${c};color:${it.magnitude===1?'#111':'#fff'}">${esc(it.category)} · ${esc(it.magnitude_text)}</span>
      ${it.length_km ? `<span class="big">${fmt(it.length_km,1)} กม.</span>` : ""}
      ${it.delay_min ? `<span class="big" style="color:${c}">+${fmt(it.delay_min,0)} นาที</span>` : ""}
      ${it.on_road ? `<span class="tag">บนถนนที่ค้น</span>` : `<span class="tag">ถนนใกล้เคียง</span>`}</div>
    <div class="route">${jam ? "🚗 ท้ายแถว" : "จาก"}: <b>${esc(it.tail||"-")}</b><br>${jam ? "🚦 หัวแถว (จุดที่ติด)" : "ถึง"}: <b>${esc(it.head||"-")}</b></div>
    ${it.events.length ? `<div class="muted">${it.events.map(esc).join(" · ")}</div>` : ""}
  </div>`;
}
function trDraw(res){
  layers.tr.clearLayers();
  (res.items||[]).forEach((it,i)=>{
    const c = TR_COLOR[it.magnitude] || TR_COLOR[0];
    const line = L.polyline(it.line, {color:c, weight: it.on_road ? 8 : 5, opacity:.9}).addTo(layers.tr);
    line.bindPopup(trCard(it,i).replace('class="tr-item"','class="tr-item" style="cursor:default"'), {maxWidth:280});
  });
}
function trFocus(it){
  document.querySelector('#tabs button[data-tab=map]').click();
  setTimeout(()=>{
    const b = L.latLngBounds(it.line); map.fitBounds(b.pad(0.25), {maxZoom:16});
    const c = TR_COLOR[it.magnitude] || TR_COLOR[0];
    if(it.line.length > 1){
      L.marker(it.line[0], {icon:trPin("ท้ายแถว", c)}).addTo(layers.tr);
      L.marker(it.line[it.line.length-1], {icon:trPin("หัวแถว", c)}).addTo(layers.tr);
    }
  }, 150);
}
async function trSearch(q){
  if(!TR_OK){ return; }
  q = (q||"").trim(); if(!q) return;
  $("#trQ").value = q; $("#trBtn").disabled = true; $("#trInfo").textContent = "กำลังค้นหา…"; $("#trList").innerHTML = "";
  try{
    const r = await fetch(TR_API.traffic(q)); const j = await r.json();
    if(!j.ok){ $("#trInfo").textContent = "⚠ " + (j.error || "ค้นหาไม่สำเร็จ"); return; }
    trLast = j;
    const onRoad = j.items.filter(i=>i.on_road && i.cat===6);
    const km = onRoad.reduce((a,i)=>a+i.length_km,0);
    $("#trInfo").innerHTML = `<b>${esc(j.road.name)}</b> ${esc(j.road.area)} · พบ ${j.total} เหตุการณ์ในบริเวณ` +
      (onRoad.length ? ` · <b style="color:#ef4444">รถติดบนถนนนี้ ${onRoad.length} ช่วง รวม ${fmt(km,1)} กม.</b>` : " · ไม่พบรถติดบนถนนนี้ขณะนี้ 👍") +
      ` <span class="muted">(ข้อมูล ${esc(j.at.slice(11,16))} น.${j.cached ? " · ผลล่าสุดใน 5 นาที" : ""})</span>`;
    $("#trList").innerHTML = j.items.map(trCard).join("") || `<div class="note">ไม่มีเหตุรถติดในบริเวณนี้</div>`;
    $("#trList").querySelectorAll(".tr-item").forEach(el=>el.addEventListener("click",()=>trFocus(j.items[Number(el.dataset.i)])));
    if(map) trDraw(j);
    trUsage();
  }catch(e){ $("#trInfo").textContent = "⚠ ค้นหาไม่สำเร็จ"; }
  finally{ $("#trBtn").disabled = false; }
}
async function trUsage(){
  if(!TR_OK) return;
  try{ const u = await fetch(TR_API.usage).then(r=>r.json());
    if(STATIC){ $("#trUsage").textContent = u.ok ? ` · โควตาวันนี้ (เว็บสาธารณะ): รถติด ${u.traffic.used}/${u.traffic.limit}, เส้นทาง ${u.route.used}/${u.route.limit}` : ""; return; }
    $("#trUsage").textContent = u.configured ? ` · โควตาเดือนนี้: หาที่ ${u.geocode.used}/${u.geocode.limit}, รถติด ${u.incident.used}/${u.incident.limit}, เส้นทาง ${u.route.used}/${u.route.limit}` : " · ยังไม่ได้ใส่ TOMTOM_API_KEY";
  }catch(e){}
}
$("#trQuick").innerHTML = TR_QUICK.map(t=>`<button type="button">${esc(t)}</button>`).join("");
$("#trQuick").querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>trSearch(b.textContent)));
$("#trForm").addEventListener("submit", e=>{ e.preventDefault(); trSearch($("#trQ").value); });
/* ---- หาเส้นทางเลี่ยงรถติด ---- */
const RT_COLORS = ["#2563eb","#a855f7","#0d9488"];
let rtLast = null;
function rtCard(r, i){
  const col = r.best ? "#22c55e" : RT_COLORS[i % 3];
  return `<div class="rt-card ${r.best?"best":""}" data-i="${i}" style="border-left-color:${col}">
    <div class="h"><span class="t">${fmt(r.minutes,0)} นาที</span><span>${fmt(r.km,1)} กม.</span>
      ${r.best ? `<span class="pill" style="background:#22c55e">แนะนำ · เร็วสุด</span>` : (r.saves_min===0?"":"")}
      ${r.delay_min ? `<span style="color:#f97316">ติดรวม +${fmt(r.delay_min,0)} นาที</span>` : `<span style="color:#22c55e">ไม่ค่อยติด</span>`}
      ${r.arrive ? `<span class="muted">ถึงประมาณ ${esc(r.arrive)} น.</span>` : ""}</div>
    <div>ผ่าน: <b>${r.via.map(esc).join(" → ") || "-"}</b></div>
    ${r.best && rtLast && rtLast.routes.length>1 ? `<div class="muted">เร็วกว่าเส้นที่ช้าสุด ${fmt(r.saves_min,0)} นาที</div>` : ""}
    <details><summary>ดูเส้นทางทีละขั้น (${r.steps.length})</summary><ol>${r.steps.map(x=>`<li>${esc(x.text)} <span class="muted">(${fmt(x.km,1)} กม.)</span></li>`).join("")}</ol></details>
  </div>`;
}
function rtDraw(j, focus){
  layers.tr.clearLayers();
  j.routes.forEach((r,i)=>{
    const col = r.best ? "#22c55e" : RT_COLORS[i % 3];
    const on = focus===undefined ? r.best : focus===i;
    L.polyline(r.line, {color:col, weight: on ? 8 : 5, opacity: on ? .95 : .45}).addTo(layers.tr)
      .bindPopup(`${fmt(r.minutes,0)} นาที · ${fmt(r.km,1)} กม. · ผ่าน ${r.via.map(esc).join(" → ")}`);
    if(on) r.jams.forEach(jm=>L.polyline(jm.line,{color: TR_COLOR[jm.magnitude]||"#ef4444", weight:9, opacity:.9}).addTo(layers.tr)
      .bindPopup(`ช่วงรถติด ช้า +${fmt(jm.delay_min,0)} นาที${jm.speed?` · วิ่งได้ ~${fmt(jm.speed,0)} กม./ชม.`:""}`));
  });
  L.marker([j.from.lat,j.from.lon],{icon:trPin("ต้นทาง","#2563eb")}).addTo(layers.tr);
  L.marker([j.to.lat,j.to.lon],{icon:trPin("ปลายทาง","#ef4444")}).addTo(layers.tr);
}
async function rtSearch(){
  const a = $("#rtFrom").value.trim(), b = $("#rtTo").value.trim(); if(!a || !b) return;
  $("#rtBtn").disabled = true; $("#rtInfo").textContent = "กำลังคำนวณเส้นทางจากสภาพจราจรตอนนี้…"; $("#rtList").innerHTML = "";
  try{
    const j = await fetch(TR_API.route(a,b)).then(r=>r.json());
    if(!j.ok){ $("#rtInfo").textContent = "⚠ " + (j.error||"หาเส้นทางไม่สำเร็จ"); return; }
    rtLast = j;
    $("#rtInfo").innerHTML = `<b>${esc(j.from.name)}</b> → <b>${esc(j.to.name)}</b> · ${j.routes.length} เส้นทาง (จราจร ${esc(j.at.slice(11,16))} น.) · กดการ์ดเพื่อดูบนแผนที่`
      + (j.warn ? `<div class="warn" style="margin-top:6px">⚠ ${esc(j.warn)}</div>` : "");
    $("#rtList").innerHTML = j.routes.map(rtCard).join("");
    $("#rtList").querySelectorAll(".rt-card").forEach(el=>el.addEventListener("click",ev=>{
      if(ev.target.closest("details")) return;
      const i = Number(el.dataset.i);
      document.querySelector('#tabs button[data-tab=map]').click();
      setTimeout(()=>{ rtDraw(j, i); map.fitBounds(L.latLngBounds(j.routes[i].line).pad(0.1)); }, 150);
    }));
    if(map) rtDraw(j);
    trUsage();
  }catch(e){ $("#rtInfo").textContent = "⚠ หาเส้นทางไม่สำเร็จ"; }
  finally{ $("#rtBtn").disabled = false; }
}
$("#rtForm").addEventListener("submit", e=>{ e.preventDefault(); rtSearch(); });
$("#rtSwap").addEventListener("click", ()=>{ const t=$("#rtFrom").value; $("#rtFrom").value=$("#rtTo").value; $("#rtTo").value=t; });
$("#rtMe").addEventListener("click", ()=>{
  if(!navigator.geolocation || !window.isSecureContext){ $("#rtInfo").textContent="หาตำแหน่งได้เฉพาะ https หรือ 127.0.0.1"; return; }
  $("#rtInfo").textContent = "กำลังหาตำแหน่ง…";
  navigator.geolocation.getCurrentPosition(p=>{ $("#rtFrom").value = `${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`;
    $("#rtInfo").textContent = `ใช้ตำแหน่งฉัน (±${fmt(p.coords.accuracy,0)} ม.)`; },
    ()=>{ $("#rtInfo").textContent = "หาตำแหน่งไม่ได้ — พิมพ์ต้นทางเองได้"; }, {enableHighAccuracy:true, timeout:15000, maximumAge:30000});
});

if(STATIC && PROXY){ trUsage(); }
else if(STATIC){
  $("#rtForm").hidden = true;
  $("#trForm").hidden = true; $("#trQuick").hidden = true; $("#lyFlowBox").hidden = true;
  $("#trInfo").innerHTML = `<div class="note">ค้นหารถติดใช้ได้บนเว็บในเครื่อง/วงแลนของหน่วยงาน (ต้องใช้ key TomTom ฝั่ง server ซึ่งไม่เปิดบนเว็บสาธารณะเพื่อกันโควตาหมด)</div>`;
}else{ trUsage(); }
$("#lyFlow").addEventListener("change", e=>{
  if(!map) return;
  if(e.target.checked){
    flowLayer = flowLayer || L.tileLayer(TR_API.tile, {maxZoom:18, minZoom:5, zIndex:350, opacity:.9,
      attribution:"Traffic &copy; TomTom"});
    flowLayer.addTo(map);
  }else if(flowLayer){ map.removeLayer(flowLayer); }
});

// เปิดค้างไว้ -> รีเฟรชเฟรมใหม่ทุก 5 นาที
setInterval(()=>{ if($("#lyRadar").checked && map){ const playing=!!radar.timer; radar.loadedAt=0;
  radarLoad().then(()=>{ if(playing) radarPlay(); }).catch(()=>{}); } }, 5*60*1000);
$("#wlLevel").addEventListener("change", renderWl);
document.querySelectorAll(".seg[data-seg=sat] button").forEach(b=>b.addEventListener("click",()=>{
  satPeriod = b.dataset.p; satUserPicked = true;
  document.querySelectorAll(".seg[data-seg=sat] button").forEach(x=>x.classList.toggle("active", x.dataset.p===satPeriod));
  renderKpis(); renderSat(); if(map) loadSat(true);
}));
["#lyWl","#lyRain","#lyDam","#lySat","#lyTraffy","#lyBma","#lyCanal"].forEach(s=>$(s).addEventListener("change", syncLayers));
$("#tfState").addEventListener("change", renderTraffy);
$("#bmaShow").addEventListener("change", renderBma);
$("#onlyRisk").addEventListener("change", renderMap);
if(STATIC){ $("#btnRefresh").style.display="none"; }
$("#btnRefresh").addEventListener("click", async ()=>{
  const b=$("#btnRefresh"); b.disabled=true;
  try{
    const r = await fetch("/api/refresh",{method:"POST"}); const j = await r.json();
    $("#updated").textContent = j.msg;
    setTimeout(load, 20000);
  }catch(e){ $("#updated").textContent = "สั่งดึงไม่ได้"; }
  setTimeout(()=>b.disabled=false, 60000);
});

load();
setInterval(load, 60*1000);   // อ่านจาก cache ในเครื่อง เบา ถี่ได้ -> เห็นข้อมูลใหม่ภายใน 1 นาที
