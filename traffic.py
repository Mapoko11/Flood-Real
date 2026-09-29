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


def _get(url: str, kind: str, raw: bool = False, body: dict | None = None, timeout: float | None = None):
    _use(kind)
    if body is None:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    else:   # POST (เช่น calculateRoute + avoidAreas)
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"User-Agent": UA, "Accept": "*/*", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout or CFG["HTTP_TIMEOUT"]) as r:
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


def _road_at(name, area, typ, lat, lon, src):
    return {"name": name, "area": (area + " · " if area else "") + "ตำแหน่งจาก " + src, "type": typ, "lat": lat, "lon": lon, "src": src,
            "bbox": [lon - 0.012, lat - 0.011, lon + 0.012, lat + 0.011]}


def _find_road(q: str, key: str) -> dict:
    q0 = q
    ll = _parse_latlon(q)            # "lat,lon@ชื่อ" = จุดที่ผู้ใช้ลากหมุด/จำไว้
    if ll:
        return _road_at(ll[2], "", "POI", ll[0], ll[1], "จุดที่คุณปักหมุดไว้")
    m = _PAREN.match(" ".join(str(q or "").split()))
    q, hint = (m.group(1).strip(), m.group(2).strip()) if m and m.group(1).strip() else (q, "")
    is_jn = q.strip().startswith("แยก")
    if is_jn:       # ชื่อ "แยก…" ใช้จุดจาก OSM ก่อน (เป็นจุดตัดจริง ไม่ใช่ซอย/สะพานที่ชื่อคล้าย)
        o = _osm_junction(q, None)
        if o:
            return _road_at(q.strip(), "", "ทางแยก", o["lat"], o["lon"], "OSM")
    ld = _longdo(q, None, hint)
    if ld:
        d = ld[0]
        return _road_at(d["name"], d.get("area", ""), "POI", d["lat"], d["lon"], "Longdo")
    res = _lookup((q + " " + hint).strip(), key)
    if not res:
        raise TrafficError(f"ไม่พบถนน/สถานที่ชื่อ “{q0}”")
    nq = _norm(q)
    def _rk(r):
        a = r.get("address") or {}
        nm = _norm((r.get("poi") or {}).get("name") or a.get("streetName") or "")
        hit = 0 if (nq and nq in nm) else 1           # ชื่อตรงกับที่พิมพ์ก่อน
        if is_jn:                                      # ค้น "แยก…": ไม่เอาซอย/ถนนที่แค่ชื่อคล้ายมาก่อนจุดที่ชื่อตรง
            return (hit, 0 if r.get("type") == "Cross Street" else 1)
        return (0 if r.get("type") == "Street" else 1, hit)
    res.sort(key=_rk)
    r = res[0]
    a = r.get("address") or {}
    vp = r.get("viewport") or {}
    tl, br = vp.get("topLeftPoint") or {}, vp.get("btmRightPoint") or {}
    pos = r.get("position") or {}
    if is_jn or not (tl and br):        # ค้นแยก/ไม่มีขอบเขต -> ใช้กรอบเล็กรอบจุด (ไม่ใช้กรอบทั้งซอย/ถนนที่ใหญ่)
        dl = 0.011 if is_jn else 0.02
        tl = {"lat": pos.get("lat", 0) + dl, "lon": pos.get("lon", 0) - dl}
        br = {"lat": pos.get("lat", 0) - dl, "lon": pos.get("lon", 0) + dl}
    area = ", ".join(x for x in (a.get("municipalitySubdivision"), a.get("municipality"), a.get("countrySubdivision")) if x)
    return {
        "name": a.get("streetName") or r.get("poi", {}).get("name") or a.get("freeformAddress") or q,
        "area": (area + " · " if area else "") + "ตำแหน่งจาก TomTom (Longdo: " + (_LD_STAT["msg"] or "-") + ")",
        "type": r.get("type", ""), "src": "TomTom",
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
    data = _get(url, "tile", raw=True, timeout=8)      # ภาพจราจรช้า -> ตัดที่ 8 วิ ไม่ให้กิน thread นาน
    with _lock:
        _tile_cache[ck] = (time.time(), data)
        if len(_tile_cache) > _TILE_MAX:
            for k in sorted(_tile_cache, key=lambda k: _tile_cache[k][0])[:_TILE_MAX // 2]:
                _tile_cache.pop(k, None)
    return data


# ---------------------------------------------------------------- หาเส้นทางเลี่ยงรถติด (Routing API)

_route_cache: dict = {}


def _parse_latlon(t: str):
    """'lat,lon' หรือ 'lat,lon@ชื่อ' (ผู้ใช้เลือกจุดเองจากตัวเลือก/ลากหมุด) -> (lat, lon, label)"""
    try:
        head, _, label = str(t).partition("@")
        a, b = [float(x) for x in head.split(",")]
        if 5 <= a <= 21 and 97 <= b <= 106:      # อยู่ในไทย
            return a, b, (label.strip()[:80] or "ตำแหน่งปัจจุบัน")
    except ValueError:
        pass
    return None


_TYPE_TH = {"Cross Street": "ทางแยก", "Street": "ถนน", "Geography": "พื้นที่", "POI": "สถานที่",
            "Point Address": "ที่อยู่", "Address Range": "ที่อยู่"}
_TYPE_BONUS = {"Cross Street": 1.5, "Street": 1.0, "Geography": 0.6, "POI": 0.5}


def _cand_name(r: dict, q: str) -> str:
    a = r.get("address") or {}
    return (r.get("poi") or {}).get("name") or a.get("streetName") or a.get("freeformAddress") or q


def _rank_place(pool: list, q: str, bias=None) -> list:
    """เฉพาะผลที่ 'ชื่อตรงกับที่พิมพ์' และอยู่ไม่ไกลจากจุดอ้างอิง (<=40 กม.) เท่านั้นที่ถูกยกขึ้นก่อน
    (ทางแยก > ถนน > สถานที่) ผลอื่นคงลำดับคะแนนเดิมของ TomTom ไว้ — กันยกที่อยู่มั่วๆ ขึ้นมาเป็นอันดับ 1"""
    nq, bias = _norm(q), bias or DEFAULT_BIAS

    def score(r):
        a = r.get("address") or {}
        names = [_cand_name(r, ""), a.get("streetName") or "", a.get("freeformAddress") or ""]
        if nq and any(nq in _norm(n) for n in names) and _dist(r, bias) <= 40:
            return -(2.0 + _TYPE_BONUS.get(r.get("type", ""), 0.0))
        return 0.0
    return sorted(pool, key=score)


def _alts(pool: list, q: str, n: int = 4) -> list:
    out = []
    for r in pool:
        pos = r.get("position") or {}
        if not isinstance(pos.get("lat"), (int, float)):
            continue
        if any(_km(pos["lat"], pos["lon"], o["lat"], o["lon"]) < 0.08 for o in out):    # ซ้ำ (<80 ม.) ข้าม
            continue
        a = r.get("address") or {}
        out.append({"name": _cand_name(r, q), "kind": _TYPE_TH.get(r.get("type", ""), ""),
                    "area": ", ".join(x for x in (a.get("municipalitySubdivision"), a.get("municipality")) if x),
                    "lat": round(pos["lat"], 6), "lon": round(pos["lon"], 6)})
        if len(out) >= n:
            break
    return out


# ---- ตำแหน่ง "ทางแยก" จาก OSM (จุดสัญญาณไฟ/จุดตัดที่ตั้งชื่อ) แม่นกว่า TomTom ที่มักให้จุด "สะพานข้ามแยก"/ที่อยู่ใกล้เคียง ----
OSM_URL = "https://overpass-api.de/api/interpreter"
OSM_BBOX = "13.45,100.25,14.15,100.95"          # กทม. + ปริมณฑล
OSM_FILE = os.path.join(DATA_DIR, "osm_places.json")
_osm_lock = threading.Lock()
_OSM_OK = __import__("re").compile(r"^[฀-๿A-Za-z0-9 .\-]{3,40}$")


def _osm_cache() -> dict:
    try:
        with open(OSM_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _is_jn_node(t: dict) -> bool:
    """จุด OSM นี้เป็น "ทางแยก" จริงไหม (ไม่ใช่ป้ายรถเมล์/สถานีรถไฟฟ้า/ร้านค้าที่ตั้งชื่อตามแยก)"""
    if any(k in t for k in ("public_transport", "railway", "amenity", "shop", "office", "tourism", "building", "station")):
        return False
    return t.get("highway") not in ("bus_stop", "platform")


# ชื่อผล Longdo ที่ "ไม่ใช่ตัวแยก" (ป้ายรถ/สถานี/ร้าน) ให้ไปอยู่ท้าย
_LD_BAD = ("ป้ายรถ", "สถานี", "บริษัท", "ร้าน", "สาขา", "คอนโด", "ตลาด", "โรงแรม", "ธนาคาร", "ปั๊ม", "อาคาร", "ทางออก")


def _osm_junction(q: str, bias=None):
    """คืน {"lat","lon","n"} หรือ None — ใช้เฉพาะชื่อที่ขึ้นต้น 'แยก' · เก็บผลลง data/osm_places.json (เจอ 30 วัน/ไม่เจอ 7 วัน)
    ดึงไม่สำเร็จ (เครือข่าย/Overpass ล่ม) -> None เงียบๆ แล้วใช้ TomTom ต่อ (ไม่ cache ความล้มเหลว)"""
    name = " ".join(str(q or "").split())
    if not name.startswith("แยก") or not _OSM_OK.match(name):
        return None
    key = "j2:" + _norm(name)          # j2 = กรองป้ายรถ/สถานีรถไฟฟ้าออกแล้ว (ผลเก่าที่ปนสถานีจะไม่ถูกใช้)
    with _osm_lock:
        c = _osm_cache().get(key)
    if c and time.time() - c.get("t", 0) < (30 if c.get("hit") else 7) * 86400:
        return c["hit"] if c.get("hit") else None
    variants = {name, name.replace(" ", ""), "แยก " + name[3:].strip()}
    parts = "".join(f'node["name"="{v}"]({OSM_BBOX});node["name:th"="{v}"]({OSM_BBOX});' for v in variants)
    body = urllib.parse.urlencode({"data": f"[out:json][timeout:20];({parts});out tags center 40;"}).encode()
    try:
        req = urllib.request.Request(OSM_URL, data=body, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=25) as r:
            els = json.loads(r.read().decode("utf-8")).get("elements") or []
    except Exception:  # noqa: BLE001
        return None
    els = [e for e in els if _is_jn_node(e.get("tags") or {})]      # ตัดป้ายรถ/สถานีรถไฟฟ้า/ร้านที่ชื่อ "แยก…" ออก
    pts = [(e["lat"], e["lon"]) for e in els if isinstance(e.get("lat"), (int, float)) and isinstance(e.get("lon"), (int, float))]
    hit = None
    if pts:
        b = bias or DEFAULT_BIAS
        ref = min(pts, key=lambda p: _km(b[0], b[1], p[0], p[1]))
        grp = [p for p in pts if _km(ref[0], ref[1], p[0], p[1]) <= 0.3]      # จุดในแยกเดียวกัน (สัญญาณไฟหลายตัว) -> เอาค่ากลาง
        hit = {"lat": round(sum(p[0] for p in grp) / len(grp), 6), "lon": round(sum(p[1] for p in grp) / len(grp), 6), "n": len(pts)}
    with _osm_lock:
        c = _osm_cache()
        c[key] = {"t": time.time(), "hit": hit}
        try:
            os.makedirs(os.path.dirname(OSM_FILE), exist_ok=True)
            with open(OSM_FILE, "w", encoding="utf-8") as fh:
                json.dump(c, fh, ensure_ascii=False)
        except OSError:
            pass
    return hit


_LD_STAT = {"msg": ""}      # ผลเรียก Longdo ล่าสุด (ไว้ดูว่าทำไมไม่เจอ)


def _longdo(q: str, bias=None, hint: str = "") -> list:
    """ผู้สมัคร (dict name/kind/area/lat/lon) จาก Longdo Map Search — ต้องมี LONGDO_API_KEY ไม่งั้นคืน [] · cache 30 วัน · ล้มเหลวเงียบๆ"""
    k = (CFG.get("LONGDO_API_KEY") or "").strip()
    name = " ".join(str(q or "").split())
    if not k or len(name) < 3:
        _LD_STAT["msg"] = "ไม่มี key" if not k else "ชื่อสั้นไป"
        return []
    ck = "ld2:" + _norm(name) + ("|" + _norm(hint) if hint else "")
    with _osm_lock:
        c = _osm_cache().get(ck)
    if c and time.time() - c.get("t", 0) < (30 if c.get("hit") else 3) * 86400:
        _LD_STAT["msg"] = "cache"
        return c.get("hit") or []
    b = bias or DEFAULT_BIAS
    qs = urllib.parse.urlencode({"keyword": name, "lon": b[1], "lat": b[0], "span": "40km", "limit": 10, "key": k, "locale": "th"})
    try:
        req = urllib.request.Request("https://search.longdo.com/mapsearch/json/search?" + qs, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read().decode("utf-8")).get("data") or []
    except Exception as e:  # noqa: BLE001
        _LD_STAT["msg"] = "เรียกไม่สำเร็จ: " + str(e)[:80]
        return []
    nq, nh = _norm(name), _norm(hint)
    # ผลที่ที่อยู่ตรงกับคำในวงเล็บ (เช่น เขต/ย่าน) มาก่อน · ผลที่เป็นป้ายรถ/สถานี/ร้าน ไปท้าย
    data = sorted(data, key=lambda d: (0 if (not nh or nh in _norm(str(d.get("address") or "") + str(d.get("name") or ""))) else 1,
                                       1 if any(w in str(d.get("name") or "") for w in _LD_BAD) else 0))
    out = []
    for d in data:
        lat, lon, nm = d.get("lat"), d.get("lon"), str(d.get("name") or "")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or nq not in _norm(nm):
            continue
        if _km(b[0], b[1], lat, lon) > 40:
            continue
        out.append({"name": nm, "kind": "Longdo", "area": str(d.get("address") or "")[:60], "lat": round(lat, 6), "lon": round(lon, 6)})
        if len(out) >= 3:
            break
    _LD_STAT["msg"] = f"ได้ {len(data)} รายการ ตรงชื่อ {len(out)}"
    with _osm_lock:
        c = _osm_cache()
        c[ck] = {"t": time.time(), "hit": out}
        try:
            with open(OSM_FILE, "w", encoding="utf-8") as fh:
                json.dump(c, fh, ensure_ascii=False)
        except OSError:
            pass
    return out


_PAREN = __import__("re").compile(r"^(.*?)\s*[(（]([^)）]*)[)）]\s*$")


def _place(q: str, key: str, bias=None) -> dict:
    ll = _parse_latlon(q)
    if ll:
        return {"name": ll[2], "lat": ll[0], "lon": ll[1], "alts": []}
    q0 = q
    m = _PAREN.match(" ".join(str(q or "").split()))
    hint = ""
    if m and m.group(1).strip():          # "วัดพระศรีมหาธาตุ (บางเขน)" -> ค้นชื่อหลัก + ใช้ "บางเขน" เป็นตัวช่วยเลือก
        q, hint = m.group(1).strip(), m.group(2).strip()
    qs = (q + " " + hint).strip()
    osm = _osm_junction(q, bias)
    res = _rank_place(_lookup(qs, key, bias=bias), q, bias)
    ld0 = _longdo(q, bias, hint)
    if not res and not osm and not ld0:
        raise TrafficError(f"ไม่พบสถานที่ “{q0}”")
    alts = _alts(res, q)
    ld = ld0
    if ld and not osm:
        alts = ld + [x for x in alts if all(_km(x["lat"], x["lon"], y["lat"], y["lon"]) >= 0.08 for y in ld)]
        return {"name": q.strip(), "lat": ld[0]["lat"], "lon": ld[0]["lon"], "kind": "Longdo", "alts": alts[:5]}
    if ld:
        alts = alts + [y for y in ld if _km(y["lat"], y["lon"], osm["lat"], osm["lon"]) >= 0.08]
    if osm:
        top = {"name": q.strip(), "kind": "ทางแยก (OSM)", "area": "", "lat": osm["lat"], "lon": osm["lon"]}
        alts = [top] + [x for x in alts if _km(x["lat"], x["lon"], osm["lat"], osm["lon"]) >= 0.08]
        return {"name": q.strip(), "lat": osm["lat"], "lon": osm["lon"], "kind": "ทางแยก (OSM)", "alts": alts[:5]}
    r = res[0]
    pos = r.get("position") or {}
    return {"name": _cand_name(r, q), "lat": pos.get("lat"), "lon": pos.get("lon"),
            "kind": _TYPE_TH.get(r.get("type", ""), ""), "alts": alts}


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


def parse_avoid(s: str) -> list:
    """'s,w,n,e;s,w,n,e' -> [(s,w,n,e)] เฉพาะกล่องเล็ก (≤ ~5 กม.) ในไทย สูงสุด 80 กล่อง"""
    out = []
    for part in str(s or "").split(";")[:80]:
        try:
            b = [float(x) for x in part.split(",")]
        except ValueError:
            continue
        if len(b) != 4:
            continue
        so, we, no, ea = b
        if 5 <= so < no <= 21 and 97 <= we < ea <= 106 and no - so <= 0.05 and ea - we <= 0.05:
            out.append((so, we, no, ea))
    return out


def _seg_km(plat, plon, a, b) -> float:
    """ระยะ (กม.) จากจุด p ถึงเส้นตรง a-b (ประมาณแบบระนาบ ใช้ได้ในระยะเมือง)"""
    kx, ky = 111.32 * math.cos(math.radians(plat)), 110.57
    ax, ay, bx, by = a["lon"] * kx, a["lat"] * ky, b["lon"] * kx, b["lat"] * ky
    px, py = plon * kx, plat * ky
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _pick_avoid(boxes: list, a: dict, b: dict, n: int = 10) -> list:
    """เลือกจุดน้ำท่วมที่อยู่ใกล้แนวต้นทาง-ปลายทางที่สุด (TomTom รับได้สูงสุด 10 กล่อง)"""
    corridor = max(3.0, 0.25 * _km(a["lat"], a["lon"], b["lat"], b["lon"]))
    near = []
    for bx in boxes:
        d = _seg_km((bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2, a, b)
        # ไม่หลบกล่องที่คร่อมต้นทาง/ปลายทางเอง (ไม่งั้นหาเส้นทางไม่ได้)
        inside = any(bx[0] <= p["lat"] <= bx[2] and bx[1] <= p["lon"] <= bx[3] for p in (a, b))
        if d <= corridor and not inside:
            near.append((d, bx))
    return [bx for _, bx in sorted(near)[:n]]


def route(src: str, dst: str, avoid: str = "") -> dict:
    src, dst = (src or "").strip(), (dst or "").strip()
    if not (2 <= len(src) <= 100 and 2 <= len(dst) <= 100):
        raise TrafficError("ใส่ต้นทางและปลายทาง (2–100 ตัวอักษร)")
    boxes = parse_avoid(avoid)
    ck = _norm(src) + "|" + _norm(dst) + "|" + str(hash(tuple(boxes)))
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
    chosen = _pick_avoid(boxes, a, b) if boxes else []
    body = {"avoidAreas": {"rectangles": [
        {"southWestCorner": {"latitude": s_, "longitude": w_}, "northEastCorner": {"latitude": n_, "longitude": e_}}
        for s_, w_, n_, e_ in chosen]}} if chosen else None
    try:
        js = _get(url, "route", body=body)
    except TrafficError:
        if not body:
            raise
        js, chosen = _get(url, "route"), []      # หลบไม่ได้ (เช่น ถูกล้อมหมด) -> ใช้เส้นทางปกติ แล้วให้หน้าเว็บเตือนจุดน้ำท่วมแทน
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
              "avoided": [list(bx) for bx in chosen],
              "at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), "cached": False}
    with _lock:
        _route_cache[ck] = (time.time(), result)
        if len(_route_cache) > 100:
            for k in sorted(_route_cache, key=lambda k: _route_cache[k][0])[:50]:
                _route_cache.pop(k, None)
    return result
