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
INCIDENT_URL = "https://api.tomtom.com/traffic/services/5/incidentDetails"
FLOW_TILE_URL = "https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png"

# โควตาฟรีต่อเดือน (เผื่อไว้ 10%) — เกินแล้วหยุดเรียก ไม่ให้เสียเงิน/โดนตัด
MONTHLY_LIMIT = {"search": 2250, "incident": 2250, "tile": 180000}
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


def _find_road(q: str, key: str) -> dict:
    url = SEARCH_URL.format(q=urllib.parse.quote(q)) + "?" + urllib.parse.urlencode({
        "key": key, "countrySet": "TH", "language": "th-TH", "limit": 5, "idxSet": "Str,Geo,POI"})
    js = _get(url, "search")
    res = js.get("results") or []
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
