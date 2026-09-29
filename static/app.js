/* Flood real — หน้าเว็บ (อ่านจาก /api/data อย่างเดียว) */
"use strict";
/* STATIC = true เมื่อเป็นเว็บบน GitHub Pages (ไม่มี server) -> อ่านไฟล์ข้อมูลตรง + เรียก RainViewer เอง */
const STATIC = !!window.FLOOD_STATIC;
const PROXY = String(window.FLOOD_PROXY || "").replace(/\/$/, "");   // Cloudflare Worker (เว็บ github.io) — ซ่อน key TomTom
const TR_OK = !STATIC || !!PROXY;                                    // ใช้ค้นรถติด/เส้นทางได้ไหม
const TR_API = {
  traffic: q => STATIC ? `${PROXY}/traffic?q=${encodeURIComponent(q)}` : `/api/traffic?q=${encodeURIComponent(q)}`,
  route: (a,b,av) => (STATIC ? `${PROXY}/route` : `/api/route`) + `?from=${encodeURIComponent(a)}&to=${encodeURIComponent(b)}` + (av ? `&avoid=${encodeURIComponent(av)}` : ""),
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
const SRC_NAME = {waterlevel:"ระดับน้ำ",rain:"ฝน",main:"เขื่อน/คาดการณ์",gistda:"GISTDA",tmd:"กรมอุตุฯ",traffy:"Traffy",bma:"ถนน กทม.",bma_canal:"คลอง กทม.",bma_seg:"เส้นถนน OSM",cctv:"กล้อง CCTV",floodboard:"Floodboard"};
const CANAL = {critical:["ถึงระดับวิกฤต","#ef4444"],warning:["เฝ้าระวัง","#f59e0b"],normal:["ปกติ","#22c55e"],down:["ขัดข้อง","#64748b"]};
const BMA = {flood:["น้ำท่วม","#ef4444"],minor:["ท่วมขังเล็กน้อย","#f59e0b"],normal:["ปกติ","#22c55e"],down:["ขัดข้อง","#64748b"],unknown:["ไม่ทราบ","#64748b"]};
function bmaWet(p){ return p.state==="flood" || p.state==="minor"; }
function bmaColor(p){ const c=p.cm||0; return p.state==="minor" ? "#eab308" : c>=50 ? "#7f1d1d" : c>=30 ? "#dc2626" : c>=10 ? "#f97316" : "#eab308"; }
/* ลำดับเลขจุดน้ำท่วม (ท่วมก่อน แล้วลึกมาก→น้อย) ใช้ตรงกันทั้งแผนที่และตาราง */
function bmaNumbers(){
  const wet = ((DATA.bma||{}).points||[]).filter(bmaWet).sort((a,b)=>(a.state===b.state?0:a.state==="flood"?-1:1) || (b.cm||0)-(a.cm||0));
  const m = {}; wet.forEach((p,i)=>m[p.code]=i+1); return m;
}
/* เทียบกับภาพย้อนหลัง h ชั่วโมง -> {at, d:{code:{kind, then, now}}, n:{new,up,down,gone,same}} */
function bmaDiff(h){
  const b = DATA.bma||{}, hist = b.hist||[]; if(!h || !hist.length || !b.points) return null;
  const target = Date.now() - h*3600e3;
  let best=null, bd=1e18;
  hist.forEach(x=>{ const d=Math.abs(new Date(x.t).getTime()-target); if(d<bd){bd=d;best=x;} });
  if(!best || bd > Math.max(90*60e3, h*3600e3*0.25)) return {at:null};
  const d={}, n={new:0,up:0,down:0,gone:0,same:0};
  b.points.forEach(p=>{
    if(p.state==="down"||p.state==="unknown") return;
    const now = bmaWet(p) ? (p.cm||0) : 0, then = best.p[p.code] || 0;
    if(!now && !then) return;
    const kind = !then ? "new" : !now ? "gone" : now-then>=2 ? "up" : then-now>=2 ? "down" : "same";
    d[p.code] = {kind, then, now}; n[kind]++;
  });
  return {at:best.t, d, n};
}
const DIFF_TXT = {new:["ท่วมใหม่","#dc2626"], up:["น้ำสูงขึ้น","#f97316"], same:["เท่าเดิม","#64748b"], down:["น้ำลด","#0ea5e9"], gone:["ไม่ท่วมแล้ว","#22c55e"]};
function diffBadge(x){ if(!x) return ""; const [t,c]=DIFF_TXT[x.kind];
  const dv = x.kind==="up"||x.kind==="down" ? ` ${x.now-x.then>0?"▲+":"▼"}${fmt(x.now-x.then,0)}` : x.kind==="new"?" ▲":x.kind==="gone"?" ▼":"";
  return `<span class="pill" style="background:${c}">${t}${dv}</span>`; }
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
  for(const f of [renderKpis, renderStatus, renderMap, renderWl, renderRain, renderDam, renderSat, renderTraffy, renderBma, renderCanal, renderNb, renderCam, renderFc]){
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
  map.on("popupclose", camStop);   // ปิด popup กล้อง -> หยุดวิดีโอ ไม่กินเน็ต
  setBase(basemap);
  ["wl","rain","dam","sat","tf","roads","bma","canal","cctv","tr"].forEach(n => layers[n] = L.layerGroup());
  layers.tr.addTo(map);
  $("#legend").innerHTML =
    "<b>ระดับน้ำ:</b> " + [5,4,3,2,1].map(l=>`<span><i class="dot" style="background:${WL[l][1]}"></i>${WL[l][0]}</span>`).join(" ") +
    " &nbsp; <b>ฝน:</b> " + [4,3,2,1].map(l=>`<span><i class="dot" style="background:${RAIN[l][1]}"></i>${RAIN[l][0]}</span>`).join(" ") +
    " &nbsp; <span>▲ = เขื่อน</span> &nbsp; <b>Traffy:</b> " +
    Object.entries(TF_COLOR).map(([k,c])=>`<span><i class="dot" style="background:${c};border-radius:2px"></i>${k}</span>`).join(" ") +
    " &nbsp; <b>คลอง กทม.:</b> " + ["critical","warning","normal"].map(k=>`<span><i class="dot" style="background:${CANAL[k][1]};border-radius:2px"></i>${CANAL[k][0]}</span>`).join(" ") +
    " &nbsp; <b>เส้นถนนมีน้ำ:</b> " + [["#a855f7","ไม่ระบุ/ตื้น"],["#f97316","10–29 ซม."],["#dc2626","30–49 ซม."],["#7f1d1d","≥50 ซม./ปิด"]].map(([c,t])=>`<span><i class="dot" style="background:${c};border-radius:1px;height:4px"></i>${t}</span>`).join(" ") +
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
  ((DATA.floodboard||{}).features||[]).filter(f=>!f.properties.cleared)
    .filter(f=>match(f.properties,["name"]))
    .forEach(f=>{
      L.geoJSON(f, {style:{color:roadColor(f.properties), weight:7*sizeK, opacity:.85, lineCap:"round"}})
        .bindPopup(roadPopup(f.properties)).addTo(layers.roads);
    });

  ((DATA.cctv||{}).cams||[]).filter(hasLL).filter(c=>match(c,["name","org"]))
    .forEach(c=>{
      const icon = L.divIcon({className:"", html:`<div class="cam-pin" style="font-size:${Math.round(14*sizeK)}px">📷</div>`, iconSize:null, iconAnchor:[10,10]});
      L.marker([c.lat,c.lon],{icon}).bindPopup(()=>camPopup(c),{maxWidth:360, minWidth:280}).addTo(layers.cctv);
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

  const bmaNo = bmaNumbers();
  ((DATA.bma||{}).points||[]).filter(hasLL).filter(p=>p.state!=="down" && p.state!=="unknown")
    .filter(p=>match(p,["name","road","district"]))
    .filter(p=>!risk || bmaWet(p))
    .sort((a,b)=>(bmaWet(a)?1:0)-(bmaWet(b)?1:0))
    .forEach(p=>{
      const c = (BMA[p.state]||BMA.unknown)[1];
      let mk;
      if(bmaWet(p)){
        const col = bmaColor(p), no = bmaNo[p.code] || "";
        const seg = ((DATA.bma_seg||{}).segs||{})[p.code];
        if(seg && seg.length > 1) L.polyline(seg, {color:col, weight:9*sizeK, opacity:.9, lineCap:"round"}).bindPopup(bmaPopup(p)).addTo(layers.bma);
        const sz = Math.round(22*sizeK);
        const icon = L.divIcon({className:"", html:`<div class="bma-no" style="background:${col};width:${sz}px;height:${sz}px;font-size:${Math.round(11*sizeK)}px">${no}</div>`,
          iconSize:[sz,sz], iconAnchor:[sz/2,sz/2]});
        mk = L.marker([p.lat,p.lon],{icon, zIndexOffset:500, title:`${no}. ${p.name} ${fmt(p.cm,0)} ซม.`});
      } else {
        mk = L.circleMarker([p.lat,p.lon],{radius:4*sizeK, color:"#fff", weight:1, fillColor:c, fillOpacity:.9});
      }
      mk.bindPopup(bmaPopup(p)).addTo(layers.bma);
    });
  loadSat();
  syncLayers();
}

/* ---------------- กล้อง CCTV (iTIC) ---------------- */
let camHls = null;
function camPopup(c){
  const box = document.createElement("div"); box.className = "cam-pop";
  box.innerHTML = `<b>📷 ${esc(c.name)}</b><br><small>${esc(c.org)} · ภาพจาก iTIC Foundation / Longdo Traffic</small>
    <div class="cam-view"><div class="cam-msg">กำลังโหลดภาพ… (เซิร์ฟเวอร์กล้องอาจช้า 10–20 วินาที)</div></div>
    <div class="cam-btns">${c.hls?`<button class="btn btn-ghost cam-live">▶ วิดีโอสด</button>`:""}
    ${c.page?`<a class="btn btn-ghost" href="${safeUrl(c.page)}" target="_blank" rel="noopener">เปิดหน้ากล้อง ↗</a>`:""}</div>`;
  const view = box.querySelector(".cam-view");
  if(c.img){
    const im = new Image(); im.alt = ""; im.referrerPolicy = "no-referrer";
    im.onload = ()=>{ view.innerHTML = ""; view.appendChild(im); };
    im.onerror = ()=>{ view.innerHTML = `<div class="cam-msg">กล้องนี้ไม่มีภาพนิ่งตอนนี้${c.hls?" — ลองกด ▶ วิดีโอสด":""}</div>`; };
    im.src = c.img + (c.img.includes("?")?"&":"?") + "t=" + Date.now();
  } else view.innerHTML = `<div class="cam-msg">กล้องนี้มีแต่วิดีโอ กด ▶ วิดีโอสด</div>`;
  const live = box.querySelector(".cam-live");
  if(live) live.addEventListener("click", ()=>camPlay(c, view));
  return box;
}
function camStop(){ if(camHls){ try{ camHls.destroy(); }catch(e){} camHls = null; } }
async function camPlay(c, view){
  camStop();
  const v = document.createElement("video"); v.muted = true; v.autoplay = true; v.playsInline = true; v.controls = true;
  view.innerHTML = ""; view.appendChild(v);
  const fail = ()=>{ view.innerHTML = `<div class="cam-msg">เปิดวิดีโอสดไม่ได้ (กล้องอาจปิดอยู่)</div>`; };
  if(v.canPlayType("application/vnd.apple.mpegurl")){ v.src = c.hls; v.onerror = fail; return; }
  try{
    if(!window.Hls) await new Promise((ok,no)=>{ const sc=document.createElement("script");
      sc.src="https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js"; sc.onload=ok; sc.onerror=no; document.head.appendChild(sc); });
    if(!window.Hls || !Hls.isSupported()) return fail();
    camHls = new Hls({maxBufferLength:10}); camHls.loadSource(c.hls); camHls.attachMedia(v);
    camHls.on(Hls.Events.ERROR, (_,d)=>{ if(d && d.fatal){ camStop(); fail(); } });
  }catch(e){ fail(); }
}

/* ---------------- นนทบุรี: รวมข้อมูลที่มีอยู่แล้ว (ThaiWater / Traffy / คลอง กทม. / กล้อง iTIC) ---------------- */
function renderNb(){
  const box = $("#nbBox"); if(!box) return;
  const nb = s=>/นนทบุรี/.test(s||"");
  const wl = (DATA.waterlevel||[]).filter(w=>nb(w.province)).sort((a,b)=>(b.bank_pct||0)-(a.bank_pct||0));
  const rain = (DATA.rain||[]).filter(r=>nb(r.province)).sort((a,b)=>(b.rain||0)-(a.rain||0));
  const tf = ((DATA.traffy||{}).items||[]).filter(t=>nb(t.province) && tfOpen(t));
  const cams = ((DATA.cctv||{}).cams||[]).filter(c=>nb(c.name));
  box.innerHTML = `<div class="nb-grid">
    <div><b>ระดับน้ำ (ThaiWater)</b>${wl.length ? wl.map(w=>`<div>${esc(w.name)} <small class="muted">${esc(w.amphoe)}</small> — <b>${fmt(w.bank_pct,0)}%</b> ตลิ่ง ${pill(WL,w.level)}</div>`).join("") : `<div class="muted">ไม่มีสถานี</div>`}</div>
    <div><b>ฝน 24 ชม.</b>${rain.length ? rain.map(r=>`<div>${esc(r.name)} <small class="muted">${esc(r.amphoe)}</small> — <b>${fmt(r.rain)}</b> มม.</div>`).join("") : `<div class="muted">ไม่มีสถานี</div>`}</div>
    <div><b>แจ้งปัญหาค้าง (Traffy)</b><div>${tf.length} เรื่อง</div>
      <b>กล้อง CCTV</b><div>${cams.length} ตัว <button class="btn btn-ghost" id="nbCams">📷 ดูกล้องนนทบุรี</button></div></div>
  </div>
  <small class="muted">นนทบุรียังไม่มีสถานีวัดน้ำท่วมบนถนนแบบ กทม. ที่เปิดให้ดึงข้อมูล · ดูเพิ่มที่ <a href="https://nonthaburi.thaiwater.net/" target="_blank" rel="noopener">ศูนย์ข้อมูลน้ำจังหวัดนนทบุรี</a></small>`;
  const b = $("#nbCams"); if(b) b.addEventListener("click", ()=>{ $("#camProv").value="นนทบุรี"; renderCam.last=""; document.querySelector('#tabs button[data-tab=cam]').click(); renderCam(); });
}

function renderCam(){
  const all = (DATA.cctv||{}).cams || [];
  const grid = $("#camGrid"); if(!grid) return;
  if(!all.length){ $("#camInfo").textContent = "ยังไม่มีรายชื่อกล้อง"; grid.innerHTML=""; return; }
  const q = $("#camQ").value.trim().toLowerCase().replace(/\s+/g,"");
  const prov = $("#camProv").value;
  const list = all.filter(c=> (!prov || String(c.name).includes(prov)) && (!$("#camLive").checked || c.hls) &&
      (!q || String(c.name+c.org).toLowerCase().replace(/\s+/g,"").includes(q)));
  const show = list.slice(0, 24);
  const key = prov + "|" + show.map(c=>c.id).join(",") + "|" + ((DATA.cctv||{}).at||"");
  if(key === renderCam.last) return;   // ข้อมูลรีเฟรชทุกนาที: ถ้ารายการเดิม ไม่วาดใหม่ (ภาพ/วิดีโอที่เปิดอยู่ไม่หาย)
  renderCam.last = key; camStop();
  $("#camInfo").textContent = `พบ ${list.length} กล้อง` + (list.length>show.length ? ` (แสดง ${show.length} ตัวแรก พิมพ์ค้นให้แคบลง)` : "");
  grid.innerHTML = show.map((c,i)=>`<div class="cam-card" data-i="${i}">
      <div class="cam-view">${c.img?`<img loading="lazy" referrerpolicy="no-referrer" alt="" src="${safeUrl(c.img)}">`:`<div class="cam-msg">มีแต่วิดีโอ</div>`}</div>
      <div class="cam-t">${esc(c.name.replace(/^\([^)]*\)\s*/,""))}</div>
      <div class="cam-btns">${c.hls?`<button class="btn btn-ghost cam-live">▶ วิดีโอสด</button>`:""}
        <button class="btn btn-ghost cam-map">🗺️ แผนที่</button>
        ${c.page?`<a class="btn btn-ghost" href="${safeUrl(c.page)}" target="_blank" rel="noopener">↗</a>`:""}</div></div>`).join("")
    || `<div class="note">ไม่พบกล้องที่ตรงกับคำค้น</div>`;
  grid.querySelectorAll(".cam-card").forEach(el=>{
    const c = show[Number(el.dataset.i)], view = el.querySelector(".cam-view"), img = view.querySelector("img");
    if(img) img.onerror = ()=>{ view.innerHTML = `<div class="cam-msg">ไม่มีภาพตอนนี้${c.hls?" — ลอง ▶ วิดีโอสด":""}</div>`; };
    const lv = el.querySelector(".cam-live"); if(lv) lv.addEventListener("click", ()=>camPlay(c, view));
    el.querySelector(".cam-map").addEventListener("click", ()=>{
      camStop(); document.querySelector('#tabs button[data-tab=map]').click();
      $("#lyCctv").checked = true; syncLayers();
      setTimeout(()=>{ map.setView([c.lat,c.lon], 16); L.popup({maxWidth:360,minWidth:280}).setLatLng([c.lat,c.lon]).setContent(camPopup(c)).openOn(map); }, 150);
    });
  });
}

/* ---------------- เส้นถนนมีน้ำ (Floodboard) ---------------- */
function roadColor(p){
  if(p.closedAll || (p.depth||0) >= 50) return "#7f1d1d";
  if((p.depth||0) >= 30 || p.closedSmall) return "#dc2626";
  if((p.depth||0) >= 10) return "#f97316";
  return "#a855f7";   // มีน้ำ แต่ไม่ทราบความลึก / ตื้น
}
const VERDICT_TH = {ok:"ผ่านได้", caution:"ระวัง", avoid:"เลี่ยง", no:"ห้ามผ่าน", closed:"ปิด"};
const VEH_TH = {car:"รถเก๋ง", motorbike:"มอเตอร์ไซค์", truck:"รถสูง/กระบะ", pickup:"กระบะ"};
function roadPopup(p){
  const v = Object.entries(p.verdict||{}).map(([k,x])=>`${esc(VEH_TH[k]||k)}: <b>${esc(VERDICT_TH[x]||x)}</b>`).join(" · ");
  return `<b>🌊 ${esc(p.name||"ถนน")}</b><br>ความลึก ${p.depth!=null?`<b>${fmt(p.depth,0)} ซม.</b>`:"ไม่ระบุ"}${p.closedAll?" · <b style='color:#ef4444'>ปิดถนน</b>":p.closedSmall?" · <b style='color:#f97316'>รถเล็กห้ามผ่าน</b>":""}
    ${v?`<br>${v}`:""}<br><small>ความมั่นใจ ${p.conf!=null?fmt(p.conf*100,0)+"%":"-"}${p.estimated?" (ประมาณ)":""} · แหล่ง: ${esc((p.sources||[]).join(", "))}<br>
    อัปเดต ${esc(String(p.updated||"-").replace("T"," ").slice(0,16))} · ข้อมูลจาก <a href="https://floodboard.org/" target="_blank" rel="noopener">Floodboard</a></small>`;
}

/* ---------------- จุดน้ำท่วมสำหรับ "เลี่ยงน้ำ" ตอนหาเส้นทาง ---------------- */
function floodHotspots(){
  const out = [];
  ((DATA&&DATA.bma||{}).points||[]).filter(p=>hasLL(p) && bmaWet(p) && (p.cm||0) >= 10).forEach(p=>{
    const d = 0.0012;
    out.push({box:[p.lat-d, p.lon-d, p.lat+d, p.lon+d], name:p.name, depth:p.cm, lat:p.lat, lon:p.lon});
  });
  ((DATA&&DATA.floodboard||{}).features||[]).forEach(f=>{
    const p = f.properties||{};
    if(p.cleared || !(p.closedAll || p.closedSmall || (p.depth||0) >= 10)) return;
    const pts = JSON.stringify(f.geometry.coordinates).match(/-?\d+\.?\d*,-?\d+\.?\d*/g) || [];
    let s=90,w=180,n=-90,e=-180;
    pts.forEach(t=>{ const [lo,la]=t.split(",").map(Number); s=Math.min(s,la); n=Math.max(n,la); w=Math.min(w,lo); e=Math.max(e,lo); });
    const pad = 0.0006;
    if(n < s || n-s > 0.04 || e-w > 0.04) return;
    out.push({box:[s-pad, w-pad, n+pad, e+pad], name:p.name, depth:p.depth, lat:(s+n)/2, lon:(w+e)/2});
  });
  return out;
}
function routeFloodHits(line, spots){
  const hit = new Set();
  const inBox = (la,lo)=>spots.forEach((h,k)=>{ const b=h.box; if(la>=b[0]&&la<=b[2]&&lo>=b[1]&&lo<=b[3]) hit.add(k); });
  for(let i=0;i<line.length;i++){
    inBox(line[i][0], line[i][1]);
    if(i+1<line.length) for(let t=1;t<4;t++) inBox(line[i][0]+(line[i+1][0]-line[i][0])*t/4, line[i][1]+(line[i+1][1]-line[i][1])*t/4);
  }
  return [...hit].map(k=>spots[k]);
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
  const df = bmaDiff(Number(($("#bmaCmp")||{}).value||0)), x = df && df.d ? df.d[p.code] : null;
  return `<b>🚗 ${esc(p.name)}</b><br>${esc(p.road)} · เขต${esc(p.district)}<br>${x?`เทียบ ${esc(String(df.at).slice(5,16).replace("T"," "))}: ${diffBadge(x)} (เดิม ${fmt(x.then,0)} ซม.)<br>`:""}
    ระดับน้ำบนถนน <b>${fmt(p.cm,1)} ซม.</b> ${pill(BMA,p.state)}${p.max_cm!=null&&bmaWet(p)?`<br>สูงสุดรอบนี้ ${fmt(p.max_cm,1)} ซม.`:""}
    ${p.since?`<br>เริ่มท่วม ${esc(p.since.replace("T"," "))}`:""}<br>
    <small>วัดเมื่อ ${esc((p.time||"-").replace("T"," "))} · สำนักการระบายน้ำ กทม.</small>`;
}

function loadSat(force){
  if(!$("#lySat").checked) return;   // ไม่ได้เลือกชั้นดาวเทียม -> ไม่โหลดไฟล์ใหญ่ (หน้าเว็บเปิดเร็วขึ้น)
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
  const m = {wl:"#lyWl", rain:"#lyRain", dam:"#lyDam", sat:"#lySat", tf:"#lyTraffy", roads:"#lyRoads", bma:"#lyBma", canal:"#lyCanal", cctv:"#lyCctv"};
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
  const sel = $("#bmaShow").value, no = bmaNumbers();
  const df = bmaDiff(Number($("#bmaCmp").value||0));
  const pts = b.points.filter(p=>match(p,["name","road","district"]))
    .filter(p=> sel==="wet" ? (bmaWet(p) || (df && df.d && df.d[p.code])) : sel==="ok" ? (p.state!=="down" && p.state!=="unknown") : true)
    .sort((a,b)=>(no[a.code]||999)-(no[b.code]||999));
  $("#bmaDiff").innerHTML = !df ? "" : !df.at ? `<span class="muted">ยังไม่มีข้อมูลย้อนหลังพอสำหรับช่วงนี้ (ระบบเริ่มเก็บชั่วโมงละครั้งตั้งแต่อัปเดตนี้)</span>` :
    `เทียบกับ <b>${esc(String(df.at).slice(5,16).replace("T"," "))}</b>: ` + ["gone","down","same","up","new"].map(k=>`<span class="pill" style="background:${DIFF_TXT[k][1]}">${df.n[k]} จุด${DIFF_TXT[k][0]}</span>`).join(" ");
  const c = b.count||{};
  $("#bmaInfo").innerHTML = `น้ำท่วม <b style="color:${BMA.flood[1]}">${c.flood||0}</b> · ท่วมขังเล็กน้อย <b style="color:${BMA.minor[1]}">${c.minor||0}</b> · ปกติ ${c.normal||0} · ขัดข้อง ${c.down||0} จุด` +
    ` <span class="muted">· ดึงเมื่อ ${esc((b.at||"").replace("T"," "))}${st&&!st.ok?" (รอบล่าสุดดึงไม่ได้ ใช้ข้อมูลเดิม)":""} · <a href="${safeUrl(b.source)}" target="_blank" rel="noopener">สำนักการระบายน้ำ กทม.</a></span>`;
  $("#bmaTable").innerHTML = `<thead><tr><th>#</th><th>จุดวัด</th><th>ถนน</th><th>เขต</th><th class="num">ระดับน้ำ (ซม.)</th><th>สถานะ</th>${df&&df.at?"<th>เทียบ</th>":""}<th>เริ่มท่วม</th><th>เวลาวัด</th></tr></thead><tbody>` +
    (pts.length ? pts.map((p,i)=>`<tr class="bma-row" data-i="${i}"><td>${no[p.code]?`<span class="bma-no" style="background:${bmaColor(p)}">${no[p.code]}</span>`:""}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.road)}</td><td>${esc(p.district)}</td>
      <td class="num"><b>${fmt(p.cm,1)}</b></td><td>${pill(BMA,p.state)}</td>${df&&df.at?`<td>${diffBadge(df.d[p.code])}</td>`:""}<td>${esc((p.since||"").slice(5,16).replace("T"," "))}</td><td>${esc((p.time||"").slice(11,16))}</td></tr>`).join("")
      : `<tr><td colspan="9" class="muted">ไม่มีจุดน้ำท่วมถนนตอนนี้ 🎉</td></tr>`) + "</tbody>";
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
  // เรดาร์ RainViewer ละเอียดสุดประมาณระดับจังหวัด (ซูม 7) -> ถ้าซูมใกล้มากให้ถอยออกมาให้เห็นกลุ่มฝน
  if(e.target.checked && map.getZoom() > 8){ saveView(); map.setZoom(8); }
  if(e.target.checked){ try{ await radarLoad(); }catch(err){ $("#rdTime").textContent="โหลดเรดาร์ไม่ได้"; } }
  else radarClear();
});
$("#rdPlay").addEventListener("click", radarPlay);
$("#btnBack").addEventListener("click", restoreView);
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
/* ---------------- Windy (หน้าต่างฝังแบบทางการ ฟรี) — โหลดเมื่อเปิดแท็บพยากรณ์ครั้งแรกเท่านั้น ---------------- */
let windyOv = "radar";
function windyLoad(){
  const box = $("#windyBox"); if(!box) return;
  const prod = (windyOv==="radar") ? "radar" : "ecmwf";
  const url = "https://embed.windy.com/embed2.html?lat=13.75&lon=100.55&detailLat=13.75&detailLon=100.55&zoom=7&level=surface"
    + `&overlay=${windyOv}&product=${prod}&menu=&message=true&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=`
    + "&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1";
  box.innerHTML = `<iframe title="Windy" src="${url}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}
document.querySelectorAll("#wdSeg button").forEach(b=>b.addEventListener("click",()=>{
  windyOv = b.dataset.ov;
  document.querySelectorAll("#wdSeg button").forEach(x=>x.classList.toggle("active", x===b));
  windyLoad();
}));

let prevTab = "map";
document.querySelectorAll("#tabs button").forEach(b=>b.addEventListener("click", ev=>{
  // ผู้ใช้กดออกจากแท็บรถติดเอง -> ล้างเส้น/หมุดรถติด-เส้นทางที่ค้างบนแผนที่หลัก (การกดโดยโปรแกรม เช่น กดการ์ดแล้วเด้งไปดูบนแผนที่ ไม่ล้าง)
  if(ev.isTrusted && prevTab==="traffic" && b.dataset.tab!=="traffic" && typeof layers!=="undefined" && layers.tr) layers.tr.clearLayers();
  prevTab = b.dataset.tab;
  if(b.dataset.tab==="fc") fcRadarInit(); else fcRadarRun();   // ออกจากแท็บ -> หยุดวน ประหยัดเครื่อง
  if(b.dataset.tab==="fc" && !windyLoad.done){ windyLoad.done = true; windyLoad(); }   // Windy โหลดครั้งแรกที่เปิดแท็บ
}));

/* ---------------- รถติด (TomTom) — ใช้ได้เฉพาะเว็บที่มี server (key อยู่ฝั่ง server) ---------------- */
const TR_COLOR = {0:"#94a3b8",1:"#facc15",2:"#f97316",3:"#ef4444",4:"#7f1d1d"};
/* สีตามความรุนแรงรถติด: 🔴 แดง = ติดหนัก/หยุดนิ่ง, วิ่งได้ <10 กม./ชม., หรือคิวยาว ≥1 กม. ที่ติดปานกลางขึ้นไป/วิ่ง <15 กม./ชม.
                         🟠 ส้ม = ติดเบา-ปานกลาง เคลื่อนที่ช้า (วิ่ง <25 กม./ชม.) · ⚪ เทา = ไม่ทราบ */
function trSevColor(mag, lenKm, speed){
  const sp = (typeof speed === "number") ? speed : null, len = lenKm || 0;
  if(mag >= 3 || (sp !== null && sp < 10) || (len >= 1 && (mag >= 2 || (sp !== null && sp < 15)))) return "#ef4444";
  if(mag >= 1 || (sp !== null && sp < 25)) return "#f97316";
  return "#94a3b8";
}
const TR_QUICK = ["วิภาวดีรังสิต","พหลโยธิน","พระราม 2","บางนา-ตราด","รามอินทรา","แจ้งวัฒนะ","ลาดพร้าว","สุขุมวิท"];
let flowLayer = null, trLast = null;
function trPin(txt, bg){ return L.divIcon({className:"", html:`<div class="tr-pin" style="border:2px solid ${bg}">${esc(txt)}</div>`, iconSize:null}); }
/* ป้ายเหตุการณ์: TomTom มักขึ้น "ปิดถนน" ทั้งที่แค่รถหยุดนิ่ง -> เทียบกับข้อมูลน้ำท่วมจริงก่อน แล้วค่อยตั้งป้าย */
const TR_MAG = {0:"ไม่ทราบ",1:"เล็กน้อย",2:"ปานกลาง",3:"ติดหนัก",4:"หยุดนิ่ง"};
const TR_NEAR_M = 150;
const TR_CLOSE_RE = /ก่อสร้าง|ซ่อม|งานถนน|ขบวน|พิธี|กิจกรรม|อุบัติเหตุ|ชน|construction|roadworks|event|accident|parade/i;
function trFloodSpots(){
  const out = [];
  ((DATA&&DATA.bma||{}).points||[]).filter(p=>hasLL(p) && bmaWet(p) && (p.cm||0) >= 5)
    .forEach(p=>out.push({lat:p.lat, lon:p.lon, depth:p.cm, src:"เซนเซอร์ กทม.", name:p.name}));
  ((DATA&&DATA.floodboard||{}).features||[]).forEach(f=>{
    const p = f.properties||{};
    if(p.cleared || !(p.closedAll || p.closedSmall || (p.depth||0) >= 5)) return;
    const pts = JSON.stringify(f.geometry.coordinates).match(/-?\d+\.?\d*,-?\d+\.?\d*/g) || [];
    pts.forEach(t=>{ const [lo,la]=t.split(",").map(Number); out.push({lat:la, lon:lo, depth:p.depth, src:"Floodboard", name:p.name}); });
  });
  ((DATA&&DATA.traffy||{}).items||[]).filter(t=>hasLL(t) && tfOpen(t) && (t.types||[]).some(x=>/น้ำท่วม/.test(x)))
    .forEach(t=>out.push({lat:t.lat, lon:t.lon, depth:null, src:"Traffy แจ้ง", name:t.address||t.district}));
  return out;
}
function trDistM(a1,o1,a2,o2){ const k=111320; return Math.hypot((o2-o1)*k*Math.cos(a1*Math.PI/180), (a2-a1)*k); }
function trFloodNear(line, spots){
  if(!line || !line.length || !spots.length) return null;
  let s=90,w=180,n=-90,e=-180; line.forEach(([la,lo])=>{ s=Math.min(s,la); n=Math.max(n,la); w=Math.min(w,lo); e=Math.max(e,lo); });
  const pad = 0.0015, cand = spots.filter(p=>p.lat>=s-pad && p.lat<=n+pad && p.lon>=w-pad && p.lon<=e+pad);
  if(!cand.length) return null;
  let best = null;
  for(let i=0;i<line.length;i++){
    const nxt = line[i+1] || line[i];
    for(let t=0;t<(i+1<line.length?3:1);t++){
      const la = line[i][0]+(nxt[0]-line[i][0])*t/3, lo = line[i][1]+(nxt[1]-line[i][1])*t/3;
      cand.forEach(p=>{ const d = trDistM(la,lo,p.lat,p.lon);
        if(d <= TR_NEAR_M && (!best || (p.depth||0) > (best.depth||0) || (!best.depth && d < best.d))) best = {...p, d}; });
    }
  }
  return best;
}
function trClassify(it, spots){
  const raw = `TomTom ระบุ: ${it.category}${it.magnitude_text ? " · " + it.magnitude_text : ""}`;
  const ev = (it.events||[]).join(" ");
  const fl = trFloodNear(it.line, spots);
  if(fl) return {kind:"flood", icon:"🌊", color:"#0284c7",
    label:`น้ำท่วมขัง${fl.depth ? ` ~${fmt(fl.depth,0)} ซม.` : ""}`,
    note:`ยืนยันจาก ${fl.src}${fl.name ? ` (${fl.name})` : ""} ห่าง ~${fmt(fl.d,0)} ม. · ${raw}`};
  if(it.cat === 11) return {kind:"flood", icon:"🌊", color:"#0284c7", label:"น้ำท่วม (TomTom)", note:"ยังไม่มีข้อมูล กทม./Floodboard ยืนยันจุดนี้"};
  if(it.cat === 7 || it.cat === 8){
    if(TR_CLOSE_RE.test(ev)) return {kind:"closed", icon:"⛔", color:"#7f1d1d", label: it.cat===8 ? "ปิดถนน" : "ปิดช่องจราจร", note:"มีสาเหตุระบุ: " + ev};
    return {kind:"jam", icon:"🚦", color:TR_COLOR[4], label:"รถหยุดนิ่ง / ติดสะสม",
      note:`${raw} — แต่ไม่พบงานก่อสร้าง อุบัติเหตุ หรือน้ำท่วมยืนยัน มักเป็นรถติดสะสมหน้าไฟแดง/คอขวด`};
  }
  if(it.cat === 6) return {kind:"jam", icon:"🚗", color:trSevColor(it.magnitude, it.length_km, null), label:`รถติด · ${TR_MAG[it.magnitude]||""}`, note:""};
  return {kind:"other", icon:"⚠️", color:TR_COLOR[it.magnitude]||TR_COLOR[0], label:it.category + (it.magnitude ? ` · ${TR_MAG[it.magnitude]||""}` : ""), note:""};
}
function trCard(it, i){
  const k = it.k || trClassify(it, []);
  const c = k.color;
  const jam = k.kind === "jam";
  return `<div class="tr-item" data-i="${i}" style="border-left-color:${c}">
    <div class="h"><span class="pill" style="background:${c};color:#fff">${k.icon} ${esc(k.label)}</span>
      ${it.length_km ? `<span class="big">${fmt(it.length_km,1)} กม.</span>` : ""}
      ${it.delay_min ? `<span class="big" style="color:${c}">+${fmt(it.delay_min,0)} นาที</span>` : ""}
      ${it.on_road ? `<span class="tag">บนถนนที่ค้น</span>` : `<span class="tag">ถนนใกล้เคียง</span>`}</div>
    <div class="route">${jam ? "🚗 ท้ายแถว (ปลายคิว รถเข้ามาต่อ)" : "จาก"}: <b>${esc(it.tail||"-")}</b><br>${jam ? "🚦 หัวแถว (จุดที่ติด ต้นเหตุ)" : "ถึง"}: <b>${esc(it.head||"-")}</b></div>
    ${k.note ? `<div class="muted tr-note">ℹ️ ${esc(k.note)}</div>` : (it.events.length ? `<div class="muted">${it.events.map(esc).join(" · ")}</div>` : "")}
  </div>`;
}
function trDraw(res){
  layers.tr.clearLayers();
  (res.items||[]).forEach((it,i)=>{
    const c = (it.k && it.k.color) || TR_COLOR[it.magnitude] || TR_COLOR[0];
    const line = L.polyline(it.line, {color:c, weight: it.on_road ? 8 : 4, opacity: it.on_road ? .95 : .35, dashArray: it.on_road ? null : "6 6"}).addTo(layers.tr);
    line.bindPopup(trCard(it,i).replace('class="tr-item"','class="tr-item" style="cursor:default"'), {maxWidth:280});
  });
}
function trFocus(it){
  document.querySelector('#tabs button[data-tab=map]').click();
  setTimeout(()=>{
    const b = L.latLngBounds(it.line); map.fitBounds(b.pad(0.25), {maxZoom:16});
    const c = TR_COLOR[it.magnitude] || TR_COLOR[0];
    if(it.line.length > 1){
      L.marker(it.line[0], {icon:trPin("🚗 ท้ายแถว (ปลายคิว)", c)}).addTo(layers.tr);
      L.marker(it.line[it.line.length-1], {icon:trPin("🚦 หัวแถว (จุดที่ติด)", c)}).addTo(layers.tr);
    }
  }, 150);
}
/* ---- แผนที่เล็กในแท็บรถติด: เห็นผลทันทีไม่ต้องสลับไปแท็บแผนที่ (มีสีความเร็วรถ TomTom ซ้อน) ---- */
let trMini = null, trMiniLy = null;
function trMiniShow(draw){
  const el = $("#trMap"); if(!el) return;
  el.style.display = "block";
  if(!trMini){
    trMini = L.map("trMap", {zoomControl:true, preferCanvas:true}).setView([13.76,100.55], 12);
    L.tileLayer(ESRI+"World_Street_Map/MapServer/tile/{z}/{y}/{x}", {maxZoom:18, attribution:ATTR + " | จราจร: TomTom"}).addTo(trMini);
    L.tileLayer(TR_API.tile, {maxZoom:18, opacity:.75, zIndex:300}).addTo(trMini);
    trMiniLy = L.layerGroup().addTo(trMini);
  }
  trMiniLy.clearLayers();
  const b = draw(trMiniLy);
  setTimeout(()=>{ trMini.invalidateSize(); if(b && b.isValid()) trMini.fitBounds(b.pad(0.12), {maxZoom:16}); }, 60);
}
function trMiniFocus(line, color){
  if(!trMini || !line || !line.length) return false;
  $("#trMap").scrollIntoView({behavior:"smooth", block:"center"});
  trMini.fitBounds(L.latLngBounds(line).pad(0.3), {maxZoom:17});
  if(line.length > 1){
    L.marker(line[0], {icon:trPin("🚗 ท้ายแถว (ปลายคิว)", color)}).addTo(trMiniLy);
    L.marker(line[line.length-1], {icon:trPin("🚦 หัวแถว (จุดที่ติด)", color)}).addTo(trMiniLy);
  }
  return true;
}
/* ---- ค้นช่วงถนน "A ถึง B": ใช้เส้นทาง TomTom (มีช่วงรถติดรายช่วง) บอกว่ารถสะสมจากตรงไหนถึงตรงไหน ---- */
const TR_SPLIT = /\s+ถึง\s+|\s*(?:→|->)\s*|\s+-\s+/;
function trCum(line){ const c=[0]; for(let i=1;i<line.length;i++) c.push(c[i-1] + trDistM(line[i-1][0],line[i-1][1],line[i][0],line[i][1])); return c; }
function trNearestIdx(line, pt){ let bi=0, bd=Infinity; line.forEach((p,i)=>{ const d=trDistM(p[0],p[1],pt[0],pt[1]); if(d<bd){bd=d; bi=i;} }); return bi; }
function trStepAt(steps, km){ let t=""; (steps||[]).forEach(s=>{ if(s.km <= km + 0.05) t = s.text; }); return t; }
/* จุดสังเกตใกล้ตำแหน่ง: ใช้ชื่อกล้อง CCTV / เซนเซอร์ กทม. ที่เรามีอยู่แล้ว (ไม่เสียโควตา TomTom) */
function trLandmark(pt, maxM=450){
  if(!pt) return null;
  let best = null;
  const cand = [];
  ((DATA&&DATA.cctv||{}).cams||[]).forEach(c=>{ if(hasLL(c) && c.name) cand.push({lat:c.lat, lon:c.lon, name:c.name}); });
  ((DATA&&DATA.bma||{}).points||[]).forEach(p=>{ if(hasLL(p) && p.name) cand.push({lat:p.lat, lon:p.lon, name:(p.road ? p.road + " " : "") + p.name}); });
  cand.forEach(c=>{
    if(Math.abs(c.lat-pt[0]) > 0.006 || Math.abs(c.lon-pt[1]) > 0.006) return;
    const d = trDistM(pt[0],pt[1],c.lat,c.lon);
    if(d <= maxM && (!best || d < best.d)) best = {...c, d};
  });
  return best;
}
function trLmTxt(lm){ return lm ? `ใกล้ ${esc(lm.name.replace(/^\s*(กล้อง|CCTV)\s*/i,""))} <span class="muted">(~${fmt(Math.round(lm.d/10)*10,0)} ม.)</span>` : ""; }
/* จุดที่ผู้ใช้ยืนยัน/ลากหมุดแล้ว: จำไว้ในเบราว์เซอร์นี้ ครั้งหน้าค้นชื่อเดิมจะได้จุดนี้เลยโดยไม่ต้องลากซ้ำ */
const TR_MEM_KEY = "flood_places_v1";
const trMemKey = t => String(t||"").toLowerCase().replace(/\s+/g,"").replace(/ถนน|ถ\./g,"");
function trMemGet(){ try{ return JSON.parse(localStorage.getItem(TR_MEM_KEY)||"{}"); }catch(e){ return {}; } }
function trMemSet(k, v){ try{ const m = trMemGet(); if(v) m[k] = v; else delete m[k]; localStorage.setItem(TR_MEM_KEY, JSON.stringify(m)); }catch(e){} }
let trTyped = {A:"", B:""}, trUsedMem = {A:false, B:false};
function trRemember(tag, lat, lon){
  const t = trTyped[tag]; if(!t || /^\d+\.?\d*,\d/.test(t)) return;
  trMemSet(trMemKey(t), {lat, lon, name:t}); trUsedMem[tag] = true;
}
let trAlt = {A:[], B:[]};       // ตัวเลือกจุดใกล้เคียงของ A/B (เก็บไว้ตอนผู้ใช้เลือกจุดเอง/ลากหมุด)
const trPtStr = (p, label) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}@${label}`;
function trPicker(tag, pt, alts){
  if(!alts || alts.length < 2) return "";
  const cur = alts.findIndex(x=>Math.abs(x.lat-pt.lat)<1e-5 && Math.abs(x.lon-pt.lon)<1e-5);
  return `<label class="tr-pick">${tag}: <select data-pick="${tag}">` +
    alts.map((x,i)=>`<option value="${i}"${i===cur?" selected":""}>${esc((x.kind?x.kind+" ":"")+x.name+(x.area?" · "+x.area:""))}</option>`).join("") +
    (cur < 0 ? `<option selected>📍 จุดที่ลากเอง</option>` : "") + `</select></label> `;
}
/* ---- กล้อง CCTV ใกล้เส้นทาง/ถนนที่ค้น (ใช้ฟีด iTIC ที่มีอยู่แล้ว ไม่เสียโควตา TomTom) ---- */
function trPtLine(c, line){                 // ระยะ (ม.) จากกล้องถึงเส้น + ตำแหน่งตามแนวเส้น (ม. จากต้นเส้น)
  const kx = 111320*Math.cos(c.lat*Math.PI/180), ky = 110570;
  let best = {d:Infinity, along:0}, acc = 0;
  for(let i=0;i<Math.max(1,line.length-1);i++){
    const a = line[i], b = line[i+1] || a;
    const ax=(a[1]-c.lon)*kx, ay=(a[0]-c.lat)*ky, bx=(b[1]-c.lon)*kx, by=(b[0]-c.lat)*ky;
    const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy, t = L2 ? Math.max(0,Math.min(1,-(ax*dx+ay*dy)/L2)) : 0;
    const d = Math.hypot(ax+t*dx, ay+t*dy), seg = Math.sqrt(L2);
    if(d < best.d) best = {d, along: acc + t*seg};
    acc += seg;
  }
  return best;
}
function trCamsNear(lines, opt={}){
  const maxM = opt.maxM || 200, limit = opt.limit || 12, nk = opt.nameKey ? trMemKey(opt.nameKey) : "";
  const cams = ((DATA&&DATA.cctv||{}).cams||[]).filter(hasLL);
  const ls = (lines||[]).filter(l=>l && l.length);
  if(!cams.length || (!ls.length && !nk)) return [];
  const out = [];
  cams.forEach(c=>{
    let best = null;
    ls.forEach(l=>{
      let s=90,w=180,n=-90,e=-180; l.forEach(([la,lo])=>{ s=Math.min(s,la); n=Math.max(n,la); w=Math.min(w,lo); e=Math.max(e,lo); });
      const pad = 0.004;
      if(c.lat < s-pad || c.lat > n+pad || c.lon < w-pad || c.lon > e+pad) return;
      const r = trPtLine(c, l);
      if(r.d <= maxM && (!best || r.d < best.d)) best = r;
    });
    const bb = opt.bbox, inBB = !bb || (c.lon>=bb[0] && c.lon<=bb[2] && c.lat>=bb[1] && c.lat<=bb[3]);
    const byName = nk && inBB && trMemKey(c.name).includes(nk);
    if(best) out.push({c, d:best.d, along:best.along, byName});
    else if(byName) out.push({c, d:null, along:1e9, byName});
  });
  out.sort((x,y)=> (x.along - y.along) || ((x.d||0) - (y.d||0)));
  return out.slice(0, limit);
}
function trCamsRender(list, title, jamLines, isRoute){
  const box = $("#trCams"); if(!box) return;
  camStop(); box.style.display = "block";
  if(!list.length){ box.innerHTML = `<div class="tr-cams-h">📷 กล้อง CCTV ${esc(title)}</div><div class="muted">ไม่มีกล้องใกล้ช่วงนี้ (ฟีดกล้องที่เรามีครอบคลุมบางจุดเท่านั้น)</div>`; return; }
  const nearJam = c => (jamLines||[]).some(l=>trPtLine(c, l).d <= 250);
  box.innerHTML = `<div class="tr-cams-h">📷 กล้อง CCTV ${esc(title)} <span class="muted">(${list.length} ตัว${isRoute ? " · เรียงจาก A ไป B" : ""})</span></div><div class="cam-grid">` +
    list.map((o,i)=>{ const c = o.c, jm = nearJam(c);
      return `<div class="cam-card" data-i="${i}">
      <div class="cam-view">${c.img?`<img loading="lazy" referrerpolicy="no-referrer" alt="" src="${safeUrl(c.img)}${c.img.includes("?")?"&":"?"}t=${Date.now()}">`:`<div class="cam-msg">มีแต่วิดีโอ</div>`}</div>
      <div class="cam-t">${esc(c.name.replace(/^\([^)]*\)\s*/,""))}</div>
      <div class="muted cam-sub">${isRoute && o.along < 1e8 ? `กม. ${fmt(o.along/1000,1)} จาก A · ` : ""}${o.d!=null ? `ห่างเส้นทาง ~${fmt(Math.round(o.d/10)*10,0)} ม.` : "ตรงชื่อถนน"}${jm ? ` <span class="cam-tag">🚦 ใกล้ช่วงรถติด</span>` : ""}</div>
      <div class="cam-btns">${c.hls?`<button class="btn btn-ghost cam-live">▶ วิดีโอสด</button>`:""}
        <button class="btn btn-ghost cam-map">🗺️ ดูบนแผนที่</button>
        ${c.page?`<a class="btn btn-ghost" href="${safeUrl(c.page)}" target="_blank" rel="noopener">↗</a>`:""}</div></div>`; }).join("") + `</div>`;
  box.querySelectorAll(".cam-card").forEach(el=>{
    const c = list[Number(el.dataset.i)].c, view = el.querySelector(".cam-view"), img = view.querySelector("img");
    if(img) img.onerror = ()=>{ view.innerHTML = `<div class="cam-msg">ไม่มีภาพตอนนี้${c.hls?" — ลอง ▶ วิดีโอสด":""}</div>`; };
    const lv = el.querySelector(".cam-live"); if(lv) lv.addEventListener("click", ()=>camPlay(c, view));
    el.querySelector(".cam-map").addEventListener("click", ()=>{
      if(!trMini) return; $("#trMap").scrollIntoView({behavior:"smooth", block:"center"});
      trMini.setView([c.lat,c.lon], 17); L.popup({maxWidth:360,minWidth:280}).setLatLng([c.lat,c.lon]).setContent(camPopup(c)).openOn(trMini);
    });
  });
}
function trCamMarkers(ly, list){
  list.forEach(o=>L.marker([o.c.lat,o.c.lon], {icon:L.divIcon({className:"", html:`<div class="cam-pin" style="font-size:16px">📷</div>`, iconSize:null, iconAnchor:[10,10]}), zIndexOffset:500})
    .addTo(ly).bindPopup(()=>camPopup(o.c), {maxWidth:360, minWidth:280}));
}
/* ยกเลิก A/B: ล้างผลค้นหา แผนที่เล็ก กล้อง และช่องค้นหา เริ่มใหม่ได้ทันที */
function trClearAll(){
  $("#trInfo").innerHTML = ""; $("#trList").innerHTML = "";
  const cb = $("#trCams"); if(cb){ camStop(); cb.style.display = "none"; cb.innerHTML = ""; }
  if(trMiniLy) trMiniLy.clearLayers();
  const mp = $("#trMap"); if(mp) mp.style.display = "none";
  if(typeof layers !== "undefined" && layers.tr) layers.tr.clearLayers();
  $("#trQ").value = ""; trTyped = {A:"", B:""}; trUsedMem = {A:false, B:false}; trAlt = {A:[], B:[]};
  $("#trQ").focus();
}
function trMemCount(){ return Object.keys(trMemGet()).length; }
/* รายการจุดที่จำไว้เป็น dropdown: เลือกเพื่อดูตำแหน่งบนแผนที่เล็กก่อน แล้วค่อยกด "ยกเลิกจุดนี้" */
function trMemRow(){
  const m = trMemGet(), ks = Object.keys(m);
  if(!ks.length) return "";
  const used = k => ["A","B"].filter(t=>trUsedMem[t] && trMemKey(trTyped[t])===k).map(t=>` · ใช้อยู่ที่ ${t}`).join("");
  return `<div class="tr-picks">📌 จุดที่จำไว้ (${ks.length}): <select id="trMemSel"><option value="">— เลือกเพื่อดูตำแหน่ง / ยกเลิก —</option>` +
    ks.map(k=>`<option value="${esc(k)}">${esc(m[k].name || k)} (${m[k].lat.toFixed(4)}, ${m[k].lon.toFixed(4)})${esc(used(k))}</option>`).join("") +
    `</select> <span id="trMemAct"></span></div>`;
}
let trMemMk = null;
function trMemBind(a, b){
  const sel = $("#trMemSel"); if(!sel) return;
  const act = $("#trMemAct");
  const usedNow = k => ["A","B"].some(t=>trUsedMem[t] && trMemKey(trTyped[t])===k);
  const dropMk = ()=>{ if(trMemMk && trMini){ trMiniLy.removeLayer(trMemMk); } trMemMk = null; };
  sel.addEventListener("change", ()=>{
    dropMk(); act.innerHTML = "";
    const k = sel.value; if(!k) return;
    const pt = trMemGet()[k]; if(!pt) return;
    if(trMini){
      trMemMk = L.marker([pt.lat, pt.lon], {icon:trPin("📌 จุดที่จำไว้: " + (pt.name||k), "#a855f7"), zIndexOffset:2000}).addTo(trMiniLy);
      $("#trMap").scrollIntoView({behavior:"smooth", block:"center"});
      trMini.setView([pt.lat, pt.lon], 17);
    }
    act.innerHTML = `<button type="button" class="tr-rev" id="trMemDel">🗑 ยกเลิกจุดนี้</button> <button type="button" class="tr-rev" id="trMemAll">🧹 ล้างทั้งหมด</button>`;
    $("#trMemDel").addEventListener("click", ()=>{
      const wasUsed = usedNow(k);
      trMemSet(k, null);
      ["A","B"].forEach(t=>{ if(trMemKey(trTyped[t])===k) trUsedMem[t] = false; });
      if(wasUsed){ trSegment(trTyped.A || a, trTyped.B || b, true).catch(e=>{ $("#trInfo").textContent = "⚠ " + (e && e.message || e); }); return; }
      dropMk(); const o = [...sel.options].find(x=>x.value===k); if(o) o.remove();
      sel.value = ""; act.innerHTML = ""; if(sel.options.length < 2) sel.closest(".tr-picks").remove();
    });
    $("#trMemAll").addEventListener("click", ()=>{
      if(!confirm(`ยกเลิกจุดที่จำไว้ทั้งหมด ${trMemCount()} จุด?`)) return;
      const any = ["A","B"].some(t=>trUsedMem[t]);
      try{ localStorage.removeItem(TR_MEM_KEY); }catch(e){}
      trUsedMem = {A:false, B:false};
      if(any){ trSegment(trTyped.A || a, trTyped.B || b, true).catch(e=>{ $("#trInfo").textContent = "⚠ " + (e && e.message || e); }); return; }
      dropMk(); sel.closest(".tr-picks").remove();
    });
  });
}

async function trSegment(a, b, keep=false){
  if(!keep) trAlt = {A:[], B:[]};
  $("#trInfo").textContent = `กำลังดูสภาพจราจรช่วง ${a.split("@")[1]||a} → ${b.split("@")[1]||b}…`;
  const j = await fetch(TR_API.route(a, b)).then(r=>r.json());
  if(!j.ok){ $("#trInfo").textContent = "⚠ " + (j.error || "หาช่วงถนนไม่สำเร็จ"); return; }
  if((j.from.alts||[]).length) trAlt.A = j.from.alts;
  if((j.to.alts||[]).length) trAlt.B = j.to.alts;
  const r = j.routes[0];                                  // เส้นทางหลักของ TomTom (ปกติคือถนนที่ตั้งใจ)
  const cum = trCum(r.line), totKm = cum[cum.length-1]/1000 || r.km;
  const spots = trFloodSpots();
  let jams = (r.jams||[]).map(jm=>{
    const i0 = trNearestIdx(r.line, jm.line[0]), i1 = trNearestIdx(r.line, jm.line[jm.line.length-1]);
    const s = cum[Math.min(i0,i1)]/1000, e = cum[Math.max(i0,i1)]/1000;
    const len = trCum(jm.line).pop()/1000;
    return {...jm, s, e: Math.max(e, s+len*0.9), len};
  }).sort((x,y)=>x.s-y.s);
  // ต่อช่วงที่ห่างกันไม่ถึง 200 ม. เป็นคิวเดียว (TomTom มักแบ่งคิวยาวเป็นหลายท่อน)
  const merged = [];
  jams.forEach(x=>{
    const p = merged[merged.length-1];
    if(p && x.s - p.e < 0.2){ p.e = Math.max(p.e, x.e); p.len += x.len; p.line = p.line.concat(x.line);
      p.delay_min = (p.delay_min||0) + (x.delay_min||0); p.magnitude = Math.max(p.magnitude, x.magnitude);
      p.speed = p.speed && x.speed ? Math.min(p.speed, x.speed) : (p.speed || x.speed); p.parts++; }
    else merged.push({...x, line:x.line.slice(), parts:1});
  });
  jams = merged.map(x=>({...x, len: Math.max(x.len, x.e - x.s), flood: trFloodNear(x.line, spots),
    tailLm: trLandmark(x.line[0]), headLm: trLandmark(x.line[x.line.length-1]), tailTxt: trStepAt(r.steps, x.s)}))
    .map(x=>({...x, col: x.flood ? "#0284c7" : trSevColor(x.magnitude, x.len, x.speed)}));
  const jamKm = jams.reduce((t,x)=>t+x.len,0);
  const atB = jams.filter(x=>totKm - x.e <= 0.3).pop();     // คิวที่หัวแถวอยู่ที่ B
  const head = `<b>A</b> ${esc(j.from.name)} → <b>B</b> ${esc(j.to.name)} · ${fmt(totKm,1)} กม. ผ่าน ${r.via.map(esc).join(" → ")||"-"}`;
  let qTxt;
  if(atB){
    const toA = atB.s;
    qTxt = `<div class="tr-queue">🚦 <b>หัวแถว (จุดที่ติด) อยู่ที่ B (${esc(j.to.name)})</b> สะสมย้อนไป <b style="color:#ef4444">${fmt(atB.len,1)} กม.</b><br>` +
      (toA <= 0.2 ? `🚗 ท้ายแถว (ปลายคิว): <b>ยาวถึง A (${esc(j.from.name)}) แล้ว</b> หรือเลยไปอีก`
                  : `🚗 ท้ายแถว (ปลายคิว) อยู่ที่: ${atB.tailLm ? trLmTxt(atB.tailLm) : `กม. ${fmt(atB.s,1)} จาก A`} — <b>ยังไม่ถึง A อีก ${fmt(toA,1)} กม.</b>`) +
      `${atB.speed ? `<br>ในคิววิ่งได้ ~${fmt(atB.speed,0)} กม./ชม.` : ""}${atB.delay_min ? ` · เสียเวลาเพิ่ม ~${fmt(atB.delay_min,0)} นาที` : ""}</div>`;
  } else if(jams.length){
    qTxt = `<div class="tr-queue">✅ <b>หน้า B (${esc(j.to.name)}) ไม่มีคิวสะสม</b> · แต่มีรถติดระหว่างทาง ${jams.length} ช่วง รวม ${fmt(jamKm,1)} กม. (ดูรายการด้านล่าง)</div>`;
  } else {
    qTxt = `<div class="tr-queue">✅ <b>ช่วง A → B รถไม่ติด</b> ใช้เวลา ~${fmt(r.minutes,0)} นาที</div>`;
  }
  $("#trInfo").innerHTML = head + qTxt +
    `<span class="muted">ใช้เวลาทั้งช่วง ${fmt(r.minutes,0)} นาที${r.delay_min ? ` (ช้ากว่าปกติ +${fmt(r.delay_min,0)} นาที)` : ""} · ข้อมูล ${esc(j.at.slice(11,16))} น. · ทิศทางขาไป A → B</span>` +
    `<br><button type="button" class="tr-rev" id="trRev">⇄ ดูทิศกลับ ${esc(j.to.name)} → ${esc(j.from.name)}</button>` +
    ` <button type="button" class="tr-rev" id="trClear">✖ ยกเลิก A/B (ล้างผล เริ่มใหม่)</button>` +
    (j.warn ? `<br><small style="color:#f97316">⚠ ${esc(j.warn)}</small>` : "") +
    (totKm > 12 ? `<br><small style="color:#f97316">⚠ A→B ยาว ${fmt(totKm,1)} กม. ผิดปกติสำหรับช่วงแยก — น่าจะได้ตำแหน่ง A/B ผิด ลองเลือกจุดใหม่หรือพิมพ์ให้ชัดขึ้น เช่น "แยกเกษตร บางเขน"</small>` : "") +
    `<div class="tr-picks">📍 ตำแหน่งไม่ตรง? ${trPicker("A", j.from, trAlt.A)}${trPicker("B", j.to, trAlt.B)}<small class="muted">หรือลากหมุด A/B บนแผนที่ไปวางเอง (ระบบจะจำจุดที่คุณวางไว้)</small>` +
      `</div>` + trMemRow() +
    `<small class="muted">จุดสังเกตอ้างอิงจากชื่อกล้อง CCTV/เซนเซอร์ กทม. ที่อยู่ใกล้</small>`;
  $("#trClear").addEventListener("click", trClearAll);
  trMemBind(a, b);
  $("#trInfo").querySelectorAll("select[data-pick]").forEach(sel=>sel.addEventListener("change", ()=>{
    const tag = sel.dataset.pick, alt = trAlt[tag][Number(sel.value)]; if(!alt) return;
    const pick = trPtStr(alt, alt.name);
    trRemember(tag, alt.lat, alt.lon);
    trSegment(tag==="A" ? pick : a, tag==="B" ? pick : b, true).catch(()=>{ $("#trInfo").textContent = "⚠ หาช่วงถนนไม่สำเร็จ"; });
  }));
  $("#trRev").addEventListener("click", ()=>{ const t = trAlt.A; trAlt.A = trAlt.B; trAlt.B = t;
    [trTyped.A, trTyped.B] = [trTyped.B, trTyped.A]; [trUsedMem.A, trUsedMem.B] = [trUsedMem.B, trUsedMem.A];
    trSegment(b, a, true).catch(()=>{ $("#trInfo").textContent = "⚠ หาช่วงถนนไม่สำเร็จ"; }); });
  $("#trList").innerHTML = jams.map((x,k)=>{
    const c = x.col;
    return `<div class="tr-item" data-k="${k}" style="border-left-color:${c}">
      <div class="h"><span class="pill" style="background:${c};color:#fff">${x.flood ? `🌊 น้ำท่วมขัง${x.flood.depth?` ~${fmt(x.flood.depth,0)} ซม.`:""} + รถติด` : `🚗 รถติด · ${TR_MAG[x.magnitude]||""}`}</span>
        <span class="big">${fmt(x.len,1)} กม.</span>${x.delay_min?`<span class="big" style="color:${c}">+${fmt(x.delay_min,0)} นาที</span>`:""}
        ${x.speed?`<span class="tag">วิ่งได้ ~${fmt(x.speed,0)} กม./ชม.</span>`:""}</div>
      <div class="route">🚗 ท้ายแถว (ปลายคิว): ${x.tailLm ? trLmTxt(x.tailLm) + " · " : ""}กม. ${fmt(x.s,1)} จาก A${!x.tailLm && x.tailTxt?` <span class="muted">(หลัง: ${esc(x.tailTxt)})</span>`:""}<br>
        🚦 หัวแถว (จุดที่ติด): ${x.headLm ? trLmTxt(x.headLm) + " · " : ""}${totKm - x.e <= 0.3 ? "<b>ที่ B</b>" : `ห่าง B ${fmt(Math.max(0,totKm-x.e),1)} กม.`}</div>
      ${x.flood?`<div class="muted tr-note">ℹ️ ยืนยันจาก ${esc(x.flood.src)}${x.flood.name?` (${esc(x.flood.name)})`:""} ห่าง ~${fmt(x.flood.d,0)} ม.</div>`:""}
    </div>`; }).join("") || `<div class="note">ไม่มีช่วงรถติดระหว่าง ${esc(j.from.name)} ถึง ${esc(j.to.name)}</div>`;
  $("#trList").querySelectorAll(".tr-item").forEach(el=>el.addEventListener("click",()=>{
    const x = jams[Number(el.dataset.k)]; trMiniFocus(x.line, x.col) || trFocus(x); }));
  const camList = trCamsNear([r.line], {maxM:200, limit:12});
  trMiniShow(ly=>{
    L.polyline(r.line, {color:"#22c55e", weight:6, opacity:.55}).addTo(ly);
    trCamMarkers(ly, camList);
    jams.forEach(x=>{
      const c = x.col;
      L.polyline(x.line, {color:c, weight:9, opacity:.95}).addTo(ly)
        .bindPopup(`รถติดสะสม ${fmt(x.len,1)} กม. · กม. ${fmt(x.s,1)}–${fmt(x.e,1)}${x.delay_min?` · +${fmt(x.delay_min,0)} นาที`:""}${x.flood?"<br>🌊 มีน้ำท่วมขังช่วงนี้":""}`);
      if(x.line.length > 1) L.circleMarker(x.line[0], {radius:6, color:"#fff", weight:2, fillColor:c, fillOpacity:1}).addTo(ly).bindTooltip("🚗 ท้ายแถว (ปลายคิว)");
    });
    [["A", j.from, "#2563eb", "ต้นทาง"], ["B", j.to, "#ef4444", "ปลายทาง"]].forEach(([tag, pt, col, th])=>{
      L.marker([pt.lat,pt.lon], {icon:trPin(`${tag} ${th}: ${pt.name}`, col), draggable:true, zIndexOffset:1000, title:"ลากเพื่อย้ายจุด"}).addTo(ly)
        .on("dragend", ev=>{ const ll = ev.target.getLatLng(), lbl = `${tag} (ลากเอง)`;
          const pick = trPtStr({lat:ll.lat, lon:ll.lng}, lbl);
          trRemember(tag, ll.lat, ll.lng);
          trSegment(tag==="A" ? pick : a, tag==="B" ? pick : b, true).catch(()=>{ $("#trInfo").textContent = "⚠ หาช่วงถนนไม่สำเร็จ"; }); });
    });
    return L.latLngBounds(r.line);
  });
  trCamsRender(camList, "ตามเส้นทาง A → B", jams.map(x=>x.line), true);
  trUsage();
}
async function trSearch(q){
  if(!TR_OK){ return; }
  q = (q||"").trim(); if(!q) return;
  const seg = q.split(TR_SPLIT).map(t=>t.trim()).filter(Boolean);
  { const cb = $("#trCams"); if(cb){ camStop(); cb.style.display = "none"; cb.innerHTML = ""; } }
  if(seg.length === 2){
    $("#trQ").value = q; $("#trBtn").disabled = true; $("#trList").innerHTML = "";
    const mem = trMemGet(), ma = mem[trMemKey(seg[0])], mb = mem[trMemKey(seg[1])];
    trTyped = {A:seg[0], B:seg[1]}; trUsedMem = {A:!!ma, B:!!mb};
    try{ await trSegment(ma ? trPtStr(ma, seg[0]) : seg[0], mb ? trPtStr(mb, seg[1]) : seg[1]); }
    catch(e){ $("#trInfo").textContent = "⚠ หาช่วงถนนไม่สำเร็จ"; }
    finally{ $("#trBtn").disabled = false; }
    return;
  }
  $("#trQ").value = q; $("#trBtn").disabled = true; $("#trInfo").textContent = "กำลังค้นหา…"; $("#trList").innerHTML = "";
  try{
    const r = await fetch(TR_API.traffic(q)); const j = await r.json();
    if(!j.ok){ $("#trInfo").textContent = "⚠ " + (j.error || "ค้นหาไม่สำเร็จ"); return; }
    trLast = j;
    // แยก "บนถนนที่ค้น" กับ "ถนนใกล้เคียง" ให้ชัด (ของใกล้เคียงพับเก็บไว้)
    const spots = trFloodSpots();
    j.items.forEach(it=>{ it.k = trClassify(it, spots); });
    const mine = j.items.filter(i=>i.on_road), near = j.items.filter(i=>!i.on_road);
    const jams = mine.filter(i=>i.k.kind==="jam"), floods = mine.filter(i=>i.k.kind==="flood"), others = mine.filter(i=>i.k.kind!=="jam" && i.k.kind!=="flood");
    const km = jams.reduce((a,i)=>a+(i.length_km||0),0);
    const parts = [];
    if(floods.length) parts.push(`<b style="color:#0284c7">🌊 น้ำท่วมขัง ${floods.length} จุด</b>`);
    if(jams.length) parts.push(`<b style="color:#ef4444">รถติด ${jams.length} ช่วง รวม ${fmt(km,1)} กม.</b>`);
    if(others.length) parts.push(`<b style="color:#f97316">${others.map(i=>i.k.label).filter((v,k,a)=>a.indexOf(v)===k).map(esc).join(" / ")} ${others.length} จุด</b>`);
    $("#trInfo").innerHTML = `<b>${esc(j.road.name)}</b> ${esc(j.road.area)} · บนถนนนี้: ` +
      (parts.length ? parts.join(" · ") : "ไม่มีรถติดหรือเหตุขัดข้องขณะนี้ 👍") +
      ` <span class="muted">(ข้อมูล ${esc(j.at.slice(11,16))} น.${j.cached ? " · ผลล่าสุดใน 5 นาที" : ""})</span>` +
      `<br><small class="muted">ป้ายปรับจาก TomTom โดยเทียบข้อมูลน้ำท่วม กทม./Floodboard/Traffy ในรัศมี ${TR_NEAR_M} ม. — "ปิดถนน" จะแสดงเฉพาะเมื่อมีสาเหตุระบุ</small>`;
    const idx = it=>j.items.indexOf(it);
    $("#trList").innerHTML = (mine.length ? mine.map(it=>trCard(it, idx(it))).join("") : `<div class="note">ไม่มีเหตุบนถนน${esc(j.road.name)}ขณะนี้</div>`)
      + (near.length ? `<details class="tr-near"><summary>ถนนใกล้เคียง ${near.length} เหตุการณ์ (กดเพื่อดู)</summary>${near.map(it=>trCard(it, idx(it))).join("")}</details>` : "");
    $("#trList").querySelectorAll(".tr-item").forEach(el=>el.addEventListener("click",()=>{
      const it = j.items[Number(el.dataset.i)]; trMiniFocus(it.line, it.k.color) || trFocus(it); }));
    const camList = trCamsNear(mine.map(i=>i.line), {maxM:250, limit:12, nameKey:j.road.name, bbox:j.bbox});
    trMiniShow(ly=>{
      trCamMarkers(ly, camList);
      j.items.forEach(it=>L.polyline(it.line, {color:it.k.color, weight: it.on_road ? 8 : 4, opacity: it.on_road ? .95 : .35, dashArray: it.on_road ? null : "6 6"})
        .addTo(ly).bindPopup(trCard(it, 0).replace('class="tr-item"','class="tr-item" style="cursor:default"'), {maxWidth:280}));
      const bb = (j.road && j.road.bbox) || j.bbox;   // [minLon,minLat,maxLon,maxLat] (Worker มีแค่ j.bbox)
      const own = mine.flatMap(i=>i.line);
      return own.length ? L.latLngBounds(own) : (bb && bb.length === 4 ? L.latLngBounds([[bb[1],bb[0]],[bb[3],bb[2]]]) : null);
    });
    trCamsRender(camList, `ถนน${j.road.name}`, mine.filter(i=>i.k&&i.k.kind==="jam").map(i=>i.line), false);
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
      ${r.best ? `<span class="pill" style="background:#22c55e">${r.floodRec?"แนะนำ · เลี่ยงน้ำ":"แนะนำ · เร็วสุด"}</span>` : (r.saves_min===0?"":"")}
      ${r.delay_min ? `<span style="color:#f97316">ติดรวม +${fmt(r.delay_min,0)} นาที</span>` : `<span style="color:#22c55e">ไม่ค่อยติด</span>`}
      ${r.arrive ? `<span class="muted">ถึงประมาณ ${esc(r.arrive)} น.</span>` : ""}</div>
    <div>ผ่าน: <b>${r.via.map(esc).join(" → ") || "-"}</b></div>
    ${r.floods ? (r.floods.length ? `<div style="color:#ef4444">🌊 ผ่านจุดน้ำท่วม ${r.floods.length} จุด${r.floods.some(f=>f.depth)?` (ลึกสุด ${fmt(Math.max(...r.floods.map(f=>f.depth||0)),0)} ซม.)`:""}: ${r.floods.slice(0,4).map(f=>esc(f.name)).join(", ")}${r.floods.length>4?" …":""}</div>`
      : `<div style="color:#22c55e">✅ ไม่ผ่านจุดน้ำท่วมที่มีข้อมูล</div>`) : ""}
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
    if(on && r.floods) r.floods.forEach(f=>L.marker([f.lat,f.lon],{icon:trPin(`🌊 ${f.depth?fmt(f.depth,0)+" ซม.":"น้ำ"}`,"#ef4444"), zIndexOffset:900}).addTo(layers.tr)
      .bindPopup(`<b>จุดน้ำท่วมบนเส้นทางนี้</b><br>${esc(f.name)}${f.depth?` · ${fmt(f.depth,0)} ซม.`:""}`));
    if(on) r.jams.forEach(jm=>L.polyline(jm.line,{color: trSevColor(jm.magnitude, trCum(jm.line).pop()/1000, jm.speed), weight:9, opacity:.9}).addTo(layers.tr)
      .bindPopup(`ช่วงรถติด ช้า +${fmt(jm.delay_min,0)} นาที${jm.speed?` · วิ่งได้ ~${fmt(jm.speed,0)} กม./ชม.`:""}`));
  });
  L.marker([j.from.lat,j.from.lon],{icon:trPin("ต้นทาง","#2563eb")}).addTo(layers.tr);
  L.marker([j.to.lat,j.to.lon],{icon:trPin("ปลายทาง","#ef4444")}).addTo(layers.tr);
}
async function rtSearch(){
  const a0 = $("#rtFrom").value.trim(), b0 = $("#rtTo").value.trim(); if(!a0 || !b0) return;
  const rtMem = trMemGet(), rtUse = t => { const m = rtMem[trMemKey(t)]; return m ? trPtStr(m, m.name||t) : t; };   // ใช้จุดที่จำไว้ (ลากหมุดจากแท็บรถติด)
  const a = rtUse(a0), b = rtUse(b0), rtUsed = [a!==a0, b!==b0].filter(Boolean).length;
  $("#rtBtn").disabled = true; $("#rtInfo").textContent = "กำลังคำนวณเส้นทางจากสภาพจราจรตอนนี้…"; $("#rtList").innerHTML = "";
  try{
    const avoidOn = $("#rtAvoid").checked;
    const spots = avoidOn ? floodHotspots() : [];
    const av = spots.slice(0, 80).map(h=>h.box.map(x=>x.toFixed(5)).join(",")).join(";");
    const j = await fetch(TR_API.route(a,b,av)).then(r=>r.json());
    if(!j.ok){ $("#rtInfo").textContent = "⚠ " + (j.error||"หาเส้นทางไม่สำเร็จ"); return; }
    rtLast = j;
    if(avoidOn){   // นับจุดน้ำท่วมที่แต่ละเส้นผ่าน แล้วแนะนำเส้นที่ผ่านน้อยสุด (เท่ากันเลือกเร็วสุด)
      j.routes.forEach(r=>{ r.floods = routeFloodHits(r.line, spots); });
      let rec = 0; j.routes.forEach((r,i)=>{ const q=j.routes[rec]; if(r.floods.length < q.floods.length || (r.floods.length===q.floods.length && r.minutes < q.minutes)) rec = i; });
      j.routes.forEach((r,i)=>{ r.best = i===rec; r.floodRec = true; });
    }
    $("#rtInfo").innerHTML = `<b>${esc(j.from.name)}</b> → <b>${esc(j.to.name)}</b>` + (rtUsed ? ` <span class="muted">(📌 ใช้จุดที่จำไว้ ${rtUsed} จุด)</span>` : "") + ` · ${j.routes.length} เส้นทาง (จราจร ${esc(j.at.slice(11,16))} น.) · กดการ์ดเพื่อดูบนแผนที่`
      + (avoidOn ? `<div>🌊 เลี่ยงน้ำ: รู้จุดน้ำท่วม ${spots.length} จุด · สั่งให้เส้นทางหลบ ${(j.avoided||[]).length} จุดที่อยู่ในแนวทาง</div>` : "")
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
["#lyWl","#lyRain","#lyDam","#lySat","#lyTraffy","#lyRoads","#lyBma","#lyCanal","#lyCctv"].forEach(s=>$(s).addEventListener("change", syncLayers));
$("#lySat").addEventListener("change", ()=>{ if(map) loadSat(); });
/* ติ๊กชั้นถนนน้ำท่วม -> วาดใหม่ด้วยข้อมูลล่าสุด แล้วซูมแผนที่ไปที่จุด/เส้นเหล่านั้นทันที */
let savedView = null;   // มุมแผนที่ก่อนซูมอัตโนมัติ -> ใช้ย้อนกลับ
function saveView(){ if(map && !savedView) savedView = {c: map.getCenter(), z: map.getZoom()}; updBack(); }
function restoreView(){ if(map && savedView){ map.setView(savedView.c, savedView.z); } savedView = null; updBack(); }
function updBack(){ const b=$("#btnBack"); if(b) b.hidden = !savedView; }
[["#lyRoads","roads"],["#lyBma","bma"],["#lyCanal","canal"]].forEach(([sel,key])=>$(sel).addEventListener("change", async ()=>{
  if(!map) return;
  if(!$(sel).checked){   // เอาติ๊กออกครบทุกชั้นน้ำท่วม -> กลับมุมแผนที่เดิม
    if(!["#lyRoads","#lyBma","#lyCanal"].some(x=>$(x).checked)) restoreView();
    return;
  }
  saveView();
  try{ await load(); }catch(e){}                      // ดึงข้อมูลล่าสุดก่อน
  renderMap();
  const g = layers[key];
  let bounds = null;
  g.eachLayer(l=>{ const b = l.getBounds ? l.getBounds() : (l.getLatLng ? L.latLngBounds([l.getLatLng()]) : null);
    if(b && b.isValid()) bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast()); });
  if(bounds && bounds.isValid()) map.fitBounds(bounds.pad(0.05), {maxZoom: 13});
}));
$("#tfState").addEventListener("change", renderTraffy);
$("#bmaShow").addEventListener("change", renderBma);
$("#bmaCmp").addEventListener("change", renderBma);
let camT=null; $("#camQ").addEventListener("input", ()=>{ clearTimeout(camT); camT=setTimeout(renderCam, 350); });
$("#camProv").addEventListener("change", renderCam); $("#camLive").addEventListener("change", renderCam);
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

/* ยอดผู้เข้าชม (เฉพาะเว็บ github.io — ดึงผ่าน Worker, อัปเดตทุก 10 นาที) */
async function loadVisits(){
  if(!STATIC || !PROXY) return;
  try{
    const j = await fetch(`${PROXY}/stats`).then(r=>r.json());
    if(!j.ok) return;
    const el = $("#visits"); el.hidden = false;
    el.textContent = `👀 วันนี้ ${fmt(j.today.visits,0)} คน (${fmt(j.today.views,0)} ครั้ง) · 7 วัน ${fmt(j.week.visits,0)} คน`;
    el.title = "จำนวนผู้เข้าชมจาก Cloudflare Web Analytics · ข้อมูล " + String(j.at||"").replace("T"," ").slice(0,16);
  }catch(e){}
}
loadVisits(); setInterval(loadVisits, 10*60*1000);

load();
setInterval(load, 60*1000);   // อ่านจาก cache ในเครื่อง เบา ถี่ได้ -> เห็นข้อมูลใหม่ภายใน 1 นาที
