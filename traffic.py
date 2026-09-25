"""
traffic.py - ค้นหารถติดตามชื่อถนน ด้วย TomTom (Search + Traffic Incident Details v5)
  - พิมพ์ชื่อถนน -> หาพิกัด/ขอบเขตถนน (Search API) -> ดึงเหตุรถติดในขอบเขตนั้น (Incident Details)
  - แต่ละแถวรถติดบอก: หัวแถว (จุดที่ติด) / ท้ายแถว / ความยาว (กม.) / ช้ากว่าปกติ (นาที)
    (TomTom: geometry เรียงตามทิศรถวิ่ง -> จุดแรก = ท้ายแถว, จุดสุดท้าย = หัวแถว
             from = ชื่อตำแหน่งท้ายแถว, to = ชื่อตำแหน่งหัวแถว)
  - key อยู่ฝั่ง server เท่านั้น / cache ผลค้นหา / นับโควตารายเดือนกันเกินฟรี
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

from config import CFG, DATA_DIR

UA = "FloodReal/1.0 (+systemL traffic)"
SEARCH_URL = "https://api.tomtom.com/search/2/search/{q}.json"
GEOCODE_URL = "https://api.tomtom.com/search/2/geocode/{q}.json"
ROUTE_URL = "https://api.tomtom.com/routing/1/calculateRoute/{locs}/json"
INCIDENT_URL = "https://api.tomtom.com/traffic/services/5/incidentDetails"
FLOW_TILE_URL = "https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png"

# โควตาฟรีต่อเดือน (เผื่อไว้ 10%) — เกินแล้วหยุดเรียก ไม่ให้เสียเงิน/โดนตัด
MONTHLY_LIMIT = {"search": 2250, "geocode": 18000, "incident": 2250, "route": 18000, "tile": 180000}
USAGE_FILE = os.path.join(DATA_DIR, "tomtom_usage.json")

# iconCategory ของ TomTom
CATEGORY = {0: "ไม่ทราบ", 1: "อุบัติเหตุ", 2: "หมอก", 3: "สภาพอันตราย", 4: "ฝน", 5: "น้ำแข็ง",
            6: "รถติด", 7: "ปิดช่องจราจร", 8: "ปิดถนน", 9: "ซ่อมถนน", 10: "ลมแรง",
            11: "น้ำท่วม", 14: "รถเสีย"}
MAGNITUDE = {0: "ไม่ทราบ", 1: "เล็กน้อย", 2: "ปานกลาง", 3: "หนัก", 4: "ปิดถนน/ไม่เคลื่อน"}

_lock = threading.Lock()
_cache: dict = {}            # q -> (time, result)
_tile_cache: dict = {}       # (z,x,y) -> (time, bytes)
_TILE_TTL = 120
_TILE_MAX = 800


class TrafficError(Exception):
    pass


def _key() -> str:
    k = (CFG.get("TOMTOM_API_KEY") or "").strip()
    if not k:
        raise TrafficError("ยังไม่ได้ใส่ TOMTOM_API_KEY ใน config_local.json")
    return k


# ---------------------------------------------------------------- นับโควตา


def _use(kind: str, n: int = 1) -> None:
    """นับการเรียก API รายเดือน ถ้าเกินเพดานให้ error ก่อนยิงจริง"""
    month = datetime.now().strftime("%Y-%m")
    with _lock:
        try:
            with open(USAGE_FILE, "r", encoding="utf-8") as f:
                u = json.load(f)
        except (OSError, ValueError):
            u = {}
        if u.get("month") != month:
            u = {"month": month}
        if u.get(kind, 0) + n > MONTHLY_LIMIT[kind]:
            raise TrafficError(f"ใช้โควตาฟรี TomTom ({kind}) ของเดือนนี้ใกล้หมดแล้ว หยุดเรียกเพื่อกันเสียเงิน")
        u[kind] = u.get(kind, 0) + n
        tmp = USAGE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(u, f)
        os.replace(tmp, USAGE_FILE)


def usage() -> dict:
    try:
        with open(USAGE_FILE, "r", encoding="utf-8") as f:
            u = json.load(f)
    except (OSError, ValueError):
        u = {}
    return {"month": u.get("month", ""), **{k: {"used": u.get(k, 0), "limit": v} for k, v in MONTHLY_LIMIT.items()}}


def _get(url: str, kind: str, raw: bool = False):
    _use(kind)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=CFG["HTTP_TIMEOUT"]) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise TrafficError("TomTom ปฏิเสธ key (ตรวจ key / สิทธิ์ API ที่ติ๊กไว้)") from None
        if e.code == 429:
            raise TrafficError("TomTom จำกัดความถี่ ลองใหม่อีกสักครู่") from None
        raise TrafficError(f"TomTom ตอบ HTTP {e.code}") from None
    return data if raw else json.loads(data.decode("utf-8"))


# ---------------------------------------------------------------- ค้นถนน


DEFAULT_BIAS = (13.7563, 100.5018)   # กรุงเทพฯ — ผู้ใช้หลักอยู่ กทม./ปริมณฑล


def _km(a_lat, a_lon, b_lat, b_lon) -> float:
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _dist(r: dict, bias) -> float:
    pos = r.get("position") or {}
    try:
        return _km(bias[0], bias[1], float(pos["lat"]), float(pos["lon"]))
    except (KeyError, TypeError, ValueError):
        return 1e9


def _lookup(q: str, key: str, bias=None, near_km: float = 150) -> list:
    """หาพิกัดจากชื่อ โดยเอนเอียงไปใกล้ bias (ค่าเริ่มต้น กทม.) กันเจอชื่อซ้ำต่างจังหวัด
    (เช่น 'อนุสาวรีย์ชัย' มีหมู่บ้านชื่อนี้ที่อุดรฯ)
    1) Geocoding API (ฟรี 20K/เดือน) + bias
    2) ถ้าผลที่ใกล้สุดยังไกลเกิน near_km -> Search API (2.5K/เดือน รู้จักสถานที่/POI เช่น อนุสาวรีย์ชัยสมรภูมิ)
    เลือกผลที่ 'ใกล้ bias' ก่อน แล้วค่อยดูคะแนนความตรง"""
    bias = bias or DEFAULT_BIAS
    base = {"key": key, "countrySet": "TH", "language": "th-TH", "limit": 8,
            "lat": f"{bias[0]:.5f}", "lon": f"{bias[1]:.5f}"}
    js = _get(GEOCODE_URL.format(q=urllib.parse.quote(q)) + "?" + urllib.parse.urlencode(base), "geocode")
    res = js.get("results") or []
    if not res or min(_dist(r, bias) for r in res) > near_km:
        js2 = _get(SEARCH_URL.format(q=urllib.parse.quote(q)) + "?" + urllib.parse.urlencode(
            {**base, "idxSet": "Str,Geo,POI,PAD,Addr", "typeahead": "false"}), "search")
        res = (js2.get("results") or []) + res
    near = [r for r in res if _dist(r, bias) <= near_km]
    pool = near or res
    pool.sort(key=lambda r: (-float(r.get("score") or 0) if near else _dist(r, bias)))
    return pool


def _find_road(q: str, key: str) -> dict:
    res = _lookup(q, key)
    if not res:
        raise TrafficError(f"ไม่พบถนน/สถานที่ชื่อ “{q}”")
    # เลือกผลที่เป็นถนนก่อน
    res.sort(key=lambda r: 0 if r.get("type") == "Street" else 1)
    r = res[0]
    a = r.get("address") or {}
    vp = r.get("viewport") or {}
    tl, br = vp.get("topLeftPoint") or {}, vp.get("btmRightPoint") or {}
    pos = r.get("position") or {}
    if not (tl and br):
        tl = {"lat": pos.get("lat", 0) + 0.02, "lon": pos.get("lon", 0) - 0.02}
        br = {"lat": pos.get("lat", 0) - 0.02, "lon": pos.get("lon", 0) + 0.02}
    return {
        "name": a.get("streetName") or r.get("poi", {}).get("name") or a.get("freeformAddress") or q,
        "area": ", ".join(x for x in (a.get("municipalitySubdivision"), a.get("municipality"),
                                      a.get("countrySubdivision")) if x),
        "type": r.get("type", ""),
        "lat": pos.get("lat"), "lon": pos.get("lon"),
        "bbox": [tl["lon"], br["lat"], br["lon"], tl["lat"]],   # minLon,minLat,maxLon,maxLat
    }


def _pad_bbox(b: list, km: float = 1.5) -> list:
    """ขยายขอบเขตเล็กน้อย + บังคับไม่เกินเพดานพื้นที่ของ TomTom (~10,000 ตร.กม.)"""
    dlat = km / 111.0
    dlon = km / (111.0 * max(0.2, math.cos(math.radians((b[1] + b[3]) / 2))))
    b = [b[0] - dlon, b[1] - dlat, b[2] + dlon, b[3] + dlat]
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    half = 0.45                                       # ~50 กม. จากกลาง
    return [max(b[0], cx - half), max(b[1], cy - half), min(b[2], cx + half), min(b[3], cy + half)]


def _norm(t: str) -> str:
    return "".join(str(t or "").lower().replace("ถนน", "").replace("ถ.", "").split())


def search(q: str) -> dict:
    q = (q or "").strip()
    if not (2 <= len(q) <= 80):
        raise TrafficError("พิมพ์ชื่อถนน 2–80 ตัวอักษร")
    ck = _norm(q)
    ttl = float(CFG.get("TRAFFIC_CACHE_MINUTES", 5)) * 60
    with _lock:
        hit = _cache.get(ck)
        if hit and time.time() - hit[0] < ttl:
            return {**hit[1], "cached": True}
    key = _key()
    road = _find_road(q, key)
    bbox = _pad_bbox(road["bbox"])
    fields = ("{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,"
              "events{description,code},startTime,lastReportTime,from,to,length,delay,roadNumbers}}}")
    url = INCIDENT_URL + "?" + urllib.parse.urlencode({
        "key": key, "bbox": ",".join(f"{v:.5f}" for v in bbox), "fields": fields,
        "language": "th-TH", "timeValidityFilter": "present"})
    js = _get(url, "incident")

    words = [_norm(road["name"]), _norm(q)]
    items = []
    for inc in js.get("incidents") or []:
        p = inc.get("properties") or {}
        g = inc.get("geometry") or {}
        coords = g.get("coordinates") or []
        if g.get("type") == "Point":
            coords = [coords]
        pts = [[c[1], c[0]] for c in coords if isinstance(c, list) and len(c) >= 2]   # -> [lat,lon]
        if not pts:
            continue
        text = _norm(" ".join([str(p.get("from") or ""), str(p.get("to") or ""),
                               " ".join(p.get("roadNumbers") or []),
                               " ".join(e.get("description", "") for e in p.get("events") or [])]))
        on_road = any(w and w in text for w in words)
        cat = int(p.get("iconCategory") or 0)
        items.append({
            "id": str(p.get("id") or ""),
            "category": CATEGORY.get(cat, "อื่นๆ"), "cat": cat,
            "magnitude": int(p.get("magnitudeOfDelay") or 0),
            "magnitude_text": MAGNITUDE.get(int(p.get("magnitudeOfDelay") or 0), ""),
            "tail": str(p.get("from") or ""), "head": str(p.get("to") or ""),
            "length_km": round((p.get("length") or 0) / 1000, 2),
            "delay_min": round((p.get("delay") or 0) / 60, 1),
            "events": [e.get("description", "") for e in (p.get("events") or [])][:3],
            "roads": p.get("roadNumbers") or [],
            "since": str(p.get("startTime") or ""), "updated": str(p.get("lastReportTime") or ""),
            "on_road": on_road,
            "line": pts[:400],
        })
    # ถนนที่ค้นก่อน -> รถติด (6) ก่อน -> ติดหนักก่อน -> ยาวก่อน
    items.sort(key=lambda i: (not i["on_road"], i["cat"] != 6, -i["magnitude"], -i["length_km"]))
    result = {"ok": True, "query": q, "road": road, "bbox": bbox, "items": items[:60],
              "total": len(items), "at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), "cached": False}
    with _lock:
        _cache[ck] = (time.time(), result)
        if len(_cache) > 200:                       # ล้าง cache เก่า
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
                _cache.pop(k, None)
    return result


# ---------------------------------------------------------------- ภาพสีความเร็วบนถนน (proxy ซ่อน key)


def flow_tile(z: int, x: int, y: int) -> bytes:
    if not (0 <= z <= 18 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise TrafficError("tile ไม่ถูกต้อง")
    ck = (z, x, y)
    with _lock:
        hit = _tile_cache.get(ck)
        if hit and time.time() - hit[0] < _TILE_TTL:
            return hit[1]
    url = FLOW_TILE_URL.format(z=z, x=x, y=y) + "?" + urllib.parse.urlencode(
        {"key": _key(), "thickness": 8, "tileSize": 256})
    data = _get(url, "tile", raw=True)
    with _lock:
        _tile_cache[ck] = (time.time(), data)
        if len(_tile_cache) > _TILE_MAX:
            for k in sorted(_tile_cache, key=lambda k: _tile_cache[k][0])[:_TILE_MAX // 2]:
                _tile_cache.pop(k, None)
    return data


# ---------------------------------------------------------------- หาเส้นทางเลี่ยงรถติด (Routing API)

_route_cache: dict = {}


def _parse_latlon(t: str):
    try:
        a, b = [float(x) for x in str(t).split(",")]
        if 5 <= a <= 21 and 97 <= b <= 106:      # อยู่ในไทย
            return a, b
    except ValueError:
        pass
    return None


def _place(q: str, key: str, bias=None) -> dict:
    ll = _parse_latlon(q)
    if ll:
        return {"name": "ตำแหน่งปัจจุบัน", "lat": ll[0], "lon": ll[1]}
    res = _lookup(q, key, bias=bias)
    if not res:
        raise TrafficError(f"ไม่พบสถานที่ “{q}”")
    r = res[0]
    a = r.get("address") or {}
    pos = r.get("position") or {}
    name = (r.get("poi") or {}).get("name") or a.get("freeformAddress") or q
    return {"name": name, "lat": pos.get("lat"), "lon": pos.get("lon")}


def _via_streets(instr: list, total_m: float) -> list:
    """ถนนหลักที่เส้นทางผ่าน (เรียงตามระยะที่วิ่งบนถนนนั้น)"""
    dist: dict = {}
    for i, ins in enumerate(instr):
        st = (ins.get("street") or "").strip()
        start = ins.get("routeOffsetInMeters") or 0
        end = instr[i + 1].get("routeOffsetInMeters") if i + 1 < len(instr) else total_m
        if st:
            dist[st] = dist.get(st, 0) + max(0, (end or 0) - start)
    return [k for k, _ in sorted(dist.items(), key=lambda kv: -kv[1])[:3]]


def route(src: str, dst: str) -> dict:
    src, dst = (src or "").strip(), (dst or "").strip()
    if not (2 <= len(src) <= 100 and 2 <= len(dst) <= 100):
        raise TrafficError("ใส่ต้นทางและปลายทาง (2–100 ตัวอักษร)")
    ck = _norm(src) + "|" + _norm(dst)
    with _lock:
        hit = _route_cache.get(ck)
        if hit and time.time() - hit[0] < 180:
            return {**hit[1], "cached": True}
    key = _key()
    a = _place(src, key)
    b = _place(dst, key, bias=(a["lat"], a["lon"]))
    locs = f"{a['lat']:.6f},{a['lon']:.6f}:{b['lat']:.6f},{b['lon']:.6f}"
    url = ROUTE_URL.format(locs=locs) + "?" + urllib.parse.urlencode({
        "key": key, "traffic": "true", "maxAlternatives": 2, "routeType": "fastest",
        "travelMode": "car", "departAt": "now", "instructionsType": "text", "language": "th-TH",
        "computeTravelTimeFor": "all", "sectionType": "traffic"})
    js = _get(url, "route")
    routes = []
    for r in js.get("routes") or []:
        sm = r.get("summary") or {}
        pts = [[p["latitude"], p["longitude"]] for leg in (r.get("legs") or []) for p in (leg.get("points") or [])]
        step = max(1, len(pts) // 800)
        line = pts[::step] + ([pts[-1]] if pts and (len(pts) - 1) % step else [])
        jams = []
        for sec in r.get("sections") or []:
            if sec.get("sectionType") != "TRAFFIC":
                continue
            i0, i1 = sec.get("startPointIndex", 0), sec.get("endPointIndex", 0)
            seg = pts[i0:i1 + 1]
            if len(seg) > 1:
                jams.append({"line": seg[:: max(1, len(seg) // 150)] + [seg[-1]],
                             "delay_min": round((sec.get("delayInSeconds") or 0) / 60, 1),
                             "magnitude": int(sec.get("magnitudeOfDelay") or 0),
                             "speed": sec.get("effectiveSpeedInKmh")})
        instr = ((r.get("guidance") or {}).get("instructions") or [])
        total_m = sm.get("lengthInMeters") or 0
        routes.append({
            "km": round(total_m / 1000, 1),
            "minutes": round((sm.get("travelTimeInSeconds") or 0) / 60),
            "delay_min": round((sm.get("trafficDelayInSeconds") or 0) / 60),
            "free_minutes": round((sm.get("noTrafficTravelTimeInSeconds") or 0) / 60) or None,
            "arrive": str(sm.get("arrivalTime") or "")[11:16],
            "via": _via_streets(instr, total_m),
            "steps": [{"text": i.get("message", ""), "km": round((i.get("routeOffsetInMeters") or 0) / 1000, 1)}
                      for i in instr if i.get("message")][:40],
            "jams": sorted(jams, key=lambda j: -j["delay_min"])[:30],
            "line": line,
        })
    if not routes:
        raise TrafficError("หาเส้นทางไม่ได้ (ลองระบุต้นทาง/ปลายทางให้ชัดขึ้น)")
    best = min(range(len(routes)), key=lambda i: routes[i]["minutes"])
    for i, rt in enumerate(routes):
        rt["best"] = i == best
        rt["saves_min"] = max(0, max(r["minutes"] for r in routes) - rt["minutes"])
    far = _km(a["lat"], a["lon"], b["lat"], b["lon"])
    warn = (f"ต้นทาง/ปลายทางห่างกัน {far:,.0f} กม. — ถ้าไม่ใช่ที่ตั้งใจ ลองพิมพ์ชื่อให้ชัดขึ้น เช่น ใส่เขต/จังหวัด"
            if far > 150 else "")
    result = {"ok": True, "from": a, "to": b, "routes": routes, "best": best, "warn": warn,
              "at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), "cached": False}
    with _lock:
        _route_cache[ck] = (time.time(), result)
        if len(_route_cache) > 100:
            for k in sorted(_route_cache, key=lambda k: _route_cache[k][0])[:50]:
                _route_cache.pop(k, None)
    return result
