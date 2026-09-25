"""
sources.py - ดึงข้อมูลน้ำจากแหล่งจริง แล้วแปลงเป็นรูปแบบเดียวกัน
  1) ThaiWater (สสน.)  : ระดับน้ำ, ฝน 24 ชม., เขื่อน, แผนที่คาดการณ์ฝน   (ไม่ต้องใช้ key)
  2) GISTDA            : พื้นที่น้ำท่วมจากดาวเทียม                           (ต้องใส่ API key)
  3) กรมอุตุนิยมวิทยา  : ประกาศเตือนภัย                                     (ต้องใส่ uid/ukey)

หลักกันพัง:
  - ทุกแหล่งแยก try/except  แหล่งไหนล่ม แหล่งอื่นยังทำงาน และเก็บข้อมูลรอบก่อนไว้ (stale)
  - ใช้แค่ urllib (stdlib) ไม่เพิ่ม dependency
  - เขียน cache ลง .tmp แล้ว os.replace (ไม่มีวันได้ไฟล์ครึ่งเดียว)
"""
from __future__ import annotations

import html
import json
import os
import re
import xml.etree.ElementTree as ET
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from config import CFG, DATA_DIR

CACHE_FILE = os.path.join(DATA_DIR, "latest.json")
UA = "FloodReal/1.0 (+systemL)"
_lock = threading.Lock()

# ---------------------------------------------------------------- helpers


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _get_json(url: str, headers: dict | None = None):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=CFG["HTTP_TIMEOUT"]) as r:
        raw = r.read()
    return json.loads(raw.decode("utf-8-sig"))


def _th(v) -> str:
    """ชื่อที่ API ส่งมาเป็น {"th":..,"en":..} หรือ string ธรรมดา -> string ไทย"""
    if isinstance(v, dict):
        return str(v.get("th") or v.get("en") or "").strip()
    return "" if v is None else str(v).strip()


def _num(v):
    try:
        if v is None or v == "":
            return None
        f = float(v)
        return f if f == f else None  # ตัด NaN
    except (TypeError, ValueError):
        return None


def _items(obj, *path):
    """เดินเข้า dict ตาม path แล้วคืน list (ถ้าไม่ใช่ list คืน [])"""
    cur = obj
    for p in path:
        if not isinstance(cur, dict):
            return []
        cur = cur.get(p)
    return cur if isinstance(cur, list) else []


# ---------------------------------------------------------------- ระดับความรุนแรง
# ระดับน้ำ (% ความจุลำน้ำ) ตามสีของ ThaiWater
WL_LEVELS = [
    (1, "น้อยวิกฤต", "#db802b"),
    (2, "น้อย", "#ffc000"),
    (3, "ปกติ", "#00b050"),
    (4, "มาก", "#003cfa"),
    (5, "ล้นตลิ่ง", "#ff0000"),
]


def wl_level(pct, situation=None) -> int:
    if pct is not None:
        if pct > 100:
            return 5
        if pct > 70:
            return 4
        if pct > 30:
            return 3
        if pct > 10:
            return 2
        return 1
    s = _num(situation)
    if s is not None and 1 <= int(s) <= 5:
        return int(s)
    return 0


# ฝน 24 ชม. (มม.) ตามเกณฑ์กรมอุตุฯ
def rain_level(mm) -> int:
    if mm is None:
        return 0
    if mm > 90:
        return 4      # หนักมาก
    if mm > 35:
        return 3      # หนัก
    if mm > 10:
        return 2      # ปานกลาง
    if mm > 0:
        return 1      # เล็กน้อย
    return 0


# เขื่อน (% ความจุ)
def dam_level(pct) -> int:
    if pct is None:
        return 0
    if pct > 100:
        return 5      # เกินความจุ
    if pct > 80:
        return 4      # มาก
    if pct > 50:
        return 3      # ปกติ
    if pct > 30:
        return 2      # น้อย
    return 1          # วิกฤต


# ---------------------------------------------------------------- ThaiWater


def fetch_waterlevel() -> list[dict]:
    js = _get_json(CFG["THAIWATER_BASE"] + "/waterlevel_load")
    rows = _items(js, "waterlevel_data", "data") or _items(js, "data")
    out = []
    for it in rows:
        st = it.get("station") or {}
        gc = it.get("geocode") or {}
        lat, lon = _num(st.get("tele_station_lat")), _num(st.get("tele_station_long"))
        pct = _num(it.get("storage_percent"))
        out.append({
            "id": st.get("id") or it.get("id"),
            "name": _th(st.get("tele_station_name")),
            "lat": lat, "lon": lon,
            "province": _th(gc.get("province_name")),
            "amphoe": _th(gc.get("amphoe_name")),
            "basin": _th((it.get("basin") or {}).get("basin_name")),
            "river": _th(it.get("river_name")),
            "wl_msl": _num(it.get("waterlevel_msl")),
            "wl_prev": _num(it.get("waterlevel_msl_previous")),
            "bank_pct": pct,
            "diff_bank": _num(it.get("diff_wl_bank")),
            "level": wl_level(pct, it.get("situation_level")),
            "time": str(it.get("waterlevel_datetime") or ""),
            "agency": _th((it.get("agency") or {}).get("agency_shortname")),
        })
    return out


def fetch_rain() -> list[dict]:
    js = _get_json(CFG["THAIWATER_BASE"] + "/rain_24h")
    rows = _items(js, "data") or _items(js, "rain_data", "data")
    out = []
    for it in rows:
        st = it.get("station") or {}
        gc = it.get("geocode") or {}
        mm = _num(it.get("rain_24h"))
        if mm is None:
            continue
        out.append({
            "id": st.get("id") or it.get("id"),
            "name": _th(st.get("tele_station_name")),
            "lat": _num(st.get("tele_station_lat")), "lon": _num(st.get("tele_station_long")),
            "province": _th(gc.get("province_name")),
            "amphoe": _th(gc.get("amphoe_name")),
            "basin": _th((it.get("basin") or {}).get("basin_name")),
            "rain": mm,
            "level": rain_level(mm),
            "time": str(it.get("rainfall_datetime") or ""),
        })
    out.sort(key=lambda r: r["rain"], reverse=True)
    return out


def fetch_main() -> dict:
    """thailand_main = เขื่อน + แผนที่คาดการณ์ฝน + เรดาร์"""
    js = _get_json(CFG["THAIWATER_BASE"] + "/thailand_main")
    dams = []
    for it in _items(js, "dam", "data", "data") or _items(js, "dam", "data"):
        d = it.get("dam") or {}
        pct = _num(it.get("dam_storage_percent"))
        dams.append({
            "id": d.get("id") or it.get("id"),
            "name": _th(d.get("dam_name")),
            "lat": _num(d.get("dam_lat")), "lon": _num(d.get("dam_long")),
            "province": _th((it.get("geocode") or {}).get("province_name")),
            "basin": _th((it.get("basin") or {}).get("basin_name")),
            "storage": _num(it.get("dam_storage")),
            "pct": pct,
            "uses_pct": _num(it.get("dam_uses_water_percent")),
            "inflow": _num(it.get("dam_inflow")),
            "released": _num(it.get("dam_released")),
            "level": dam_level(pct),
            "time": str(it.get("dam_date") or ""),
        })
    dams.sort(key=lambda r: (r["pct"] is None, -(r["pct"] or 0)))

    # media_path ของ ThaiWater เป็น token ต้องแปลงเป็น URL ผ่าน /shared/image?image=<token>
    shared = CFG["THAIWATER_BASE"].rsplit("/public", 1)[0] + "/shared/image?image="

    def to_url(v) -> str:
        v = str(v or "").strip()
        if not v:
            return ""
        if v.startswith("https://"):
            return v
        if v.startswith("http"):
            return ""
        return shared + urllib.parse.quote(v, safe="")

    def media(section):
        out = []
        for it in _items(js, section, "data", "data") or _items(js, section, "data"):
            url = to_url(it.get("media_path"))
            if not url:
                continue
            out.append({
                "url": url, "thumb": to_url(it.get("media_path_thumb")) or url,
                "time": str(it.get("media_datetime") or ""),
                "name": _th(it.get("radar_name")) or _th(it.get("filename")),
                "tz": str(it.get("timezone") or ""),
            })
        return out

    return {"dams": dams, "forecast": media("pre_rain")[:8], "radar": media("radar")[:12]}


# ---------------------------------------------------------------- GISTDA


# ชื่อฟิลด์จริงของ GISTDA (ตรวจจากข้อมูลจริง 25 ก.ย. 2026): pv_tn, ap_tn, tb_tn, f_area (ตร.ม.)
# population / building / school / hospital = สิ่งที่อยู่ในพื้นที่น้ำท่วม
_PROV_KEYS = ("pv_tn", "pv_th", "prov_nam_t", "province", "pv_en")
_SQM_PER_RAI = 1600.0
_IMPACT_KEYS = ("population", "building", "school", "hospital")
_KEEP_PROPS = ("pv_tn", "ap_tn", "tb_tn", "f_area", "file_name") + _IMPACT_KEYS

GISTDA_PERIODS = ("1day", "3days", "7days", "30days")   # 1day = ล่าสุด (realtime)
GISTDA_PAGE = 1000
GISTDA_MAX_FETCH = 60000       # เพดานดึงต่อช่วง (กันวนไม่จบ)
GISTDA_MAX_MAP = 25000         # เพดานรูปที่ส่งไปวาดบนแผนที่ (กันเบราว์เซอร์หน่วง)
GISTDA_EVERY_MINUTES = 60      # GISTDA อัปเดตไม่ถี่ ดึงชั่วโมงละครั้งพอ


def gistda_file(period: str) -> str:
    return os.path.join(DATA_DIR, f"gistda_{period}.json")


def _gistda_one(period: str, key: str) -> list:
    """ดึงทีละหน้า (limit/offset) จนหมดหรือถึงเพดาน"""
    base = CFG["GISTDA_FLOOD_URL"].rsplit("/", 1)[0] + "/" + period
    feats: list = []
    offset = 0
    while len(feats) < GISTDA_MAX_FETCH:
        url = base + "?" + urllib.parse.urlencode({"limit": GISTDA_PAGE, "offset": offset})
        js = _get_json(url, headers={"API-Key": key})
        page = js.get("features") if isinstance(js, dict) else None
        page = page if isinstance(page, list) else []
        feats.extend(page)
        if len(page) < GISTDA_PAGE:
            break
        offset += GISTDA_PAGE
    return feats


def _round_coords(c):
    if isinstance(c, (int, float)):
        return round(c, 5)
    return [_round_coords(x) for x in c]


def _slim(f: dict) -> dict:
    """เก็บเฉพาะฟิลด์ที่ใช้ + ปัดพิกัด 5 ตำแหน่ง (~1 ม.) -> ไฟล์เล็กลงมาก"""
    p = f.get("properties") or {}
    g = f.get("geometry") or {}
    return {"type": "Feature",
            "properties": {k: p.get(k) for k in _KEEP_PROPS if k in p},
            "geometry": {"type": g.get("type"), "coordinates": _round_coords(g.get("coordinates") or [])}}


def _minutes_since(ts: str) -> float:
    try:
        return (datetime.now() - datetime.fromisoformat(ts)).total_seconds() / 60
    except (TypeError, ValueError):
        return 1e9


def fetch_gistda() -> dict:
    """ดึงครบ 4 ช่วงเวลา (ชั่วโมงละครั้ง) ช่วงไหนพังใช้ข้อมูลเดิมของช่วงนั้น
    polygon เก็บแยกไฟล์ data/gistda_<period>.json (ไม่ยัดลง latest.json ให้บวม)"""
    key = (CFG.get("GISTDA_API_KEY") or "").strip()
    if not key:
        return {"configured": False, "periods": {}}
    old_all = ((load_cache().get("gistda") or {}).get("periods") or {})
    periods, errors = {}, []
    for p in GISTDA_PERIODS:
        old = old_all.get(p) or {}
        if (old.get("ok") and old.get("v") == 2 and os.path.exists(gistda_file(p))
                and _minutes_since(old.get("at")) < GISTDA_EVERY_MINUTES):
            periods[p] = old                      # ยังไม่ครบรอบ ใช้ของเดิม
            continue
        try:
            feats = _gistda_one(p, key)
            summary = _gistda_summary(feats)
            shown = [_slim(f) for f in feats[:GISTDA_MAX_MAP] if isinstance(f, dict)]
            tmp = gistda_file(p) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"type": "FeatureCollection", "features": shown}, fh,
                          ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, gistda_file(p))
            periods[p] = {"v": 2, "ok": True, "at": _now(), "count": len(feats),
                          "shown": len(shown), **summary}
        except Exception as e:  # noqa: BLE001
            errors.append(f"{p}: {type(e).__name__}")
            periods[p] = {"count": 0, "provinces": [], "rai": 0, **old, "ok": False,
                          "error": f"{type(e).__name__}: {e}"[:200]}
    if len(errors) == len(GISTDA_PERIODS):
        raise RuntimeError("ดึง GISTDA ไม่ได้ทุกช่วง: " + ", ".join(errors))
    return {"configured": True, "periods": periods}


def _gistda_summary(feats: list) -> dict:
    by_prov: dict[str, dict] = {}
    total = {k: 0.0 for k in _IMPACT_KEYS}
    for f in feats:
        p = (f or {}).get("properties") or {}
        prov = next((str(p[k]) for k in _PROV_KEYS if p.get(k)), "ไม่ระบุ")
        prov = prov[2:] if prov.startswith("จ.") else prov
        rai = (_num(p.get("f_area")) or _num(p.get("_area")) or 0) / _SQM_PER_RAI
        b = by_prov.setdefault(prov, {"province": prov, "count": 0, "rai": 0.0,
                                      "amphoe": set(), **{k: 0.0 for k in _IMPACT_KEYS}})
        b["count"] += 1
        b["rai"] += rai
        if p.get("ap_tn"):
            b["amphoe"].add(str(p["ap_tn"]))
        for k in _IMPACT_KEYS:
            v = _num(p.get(k)) or 0
            b[k] += v
            total[k] += v
    provinces = []
    for b in by_prov.values():
        b["amphoe"] = len(b["amphoe"])
        b["rai"] = round(b["rai"], 1)
        provinces.append(b)
    provinces.sort(key=lambda r: (-r["rai"], -r["count"]))
    return {"provinces": provinces, "rai": round(sum(p["rai"] for p in provinces), 1),
            **{k: round(v) for k, v in total.items()}}


# ---------------------------------------------------------------- TMD


def _walk_dicts(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _walk_dicts(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk_dicts(v)


TMD_EVERY_MINUTES = 30   # เว็บกรมอุตุฯ ช้า/ล่มบ่อย ไม่ต้องยิงทุกรอบ


def _get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/xml,text/xml,*/*"})
    with urllib.request.urlopen(req, timeout=CFG["HTTP_TIMEOUT"]) as r:
        return r.read().decode("utf-8-sig", errors="replace")


def _strip_html(t: str) -> str:
    t = html.unescape(re.sub(r"<[^>]+>", " ", str(t or "")))
    return re.sub(r"\s+", " ", t).strip()


def _tmd_from_json(js) -> list:
    items, seen = [], set()
    for d in _walk_dicts(js):
        low = {k.lower(): v for k, v in d.items() if isinstance(v, (str, int, float))}
        title = low.get("titlethai") or low.get("title") or low.get("headline")
        if not title or title in seen:
            continue
        seen.add(title)
        items.append({
            "title": _strip_html(title),
            "body": _strip_html(low.get("descriptionthai") or low.get("description") or "")[:1500],
            "time": str(low.get("announcedate") or low.get("issuedate") or low.get("date") or ""),
        })
    return items


def _tmd_from_xml(text: str) -> list:
    """อ่าน XML ได้หลายแบบ (RSS <item> หรือ XML ของกรมอุตุฯ) โดยหา element
    ที่มีลูกชื่อคล้าย title แล้วเก็บ title/description/วันที่"""
    root = ET.fromstring(text)
    items, seen = [], set()

    def tag(e):
        return e.tag.rsplit("}", 1)[-1].lower()

    for el in root.iter():
        if tag(el) in ("rss", "channel", "feed", "image"):   # กล่องครอบของ RSS ไม่ใช่ประกาศ
            continue
        kids = {tag(c): (c.text or "").strip() for c in el}
        title = (kids.get("titlethai") or kids.get("title") or kids.get("headline")
                 or kids.get("warningtitle") or "")
        if not title or title in seen:
            continue
        seen.add(title)
        body = (kids.get("descriptionthai") or kids.get("description") or kids.get("detail")
                or kids.get("content") or kids.get("encoded") or "")
        when = (kids.get("announcedate") or kids.get("issuedate") or kids.get("pubdate")
                or kids.get("date") or kids.get("datetime") or "")
        items.append({"title": _strip_html(title), "body": _strip_html(body)[:1500],
                      "time": _strip_html(when), "link": _https(kids.get("link", ""))})
    return items


def fetch_tmd() -> dict:
    """มี uid/ukey -> ใช้ API แบบ key (JSON)  ไม่มี -> ใช้ XML สาธารณะ (ไม่ต้องใช้ key)"""
    old = load_cache().get("tmd") or {}
    if old.get("items") is not None and old.get("configured") and \
            _minutes_since(old.get("at")) < TMD_EVERY_MINUTES:
        return old
    uid, ukey = (CFG.get("TMD_UID") or "").strip(), (CFG.get("TMD_UKEY") or "").strip()
    if uid and ukey:
        url = CFG["TMD_WARNING_URL"] + "?" + urllib.parse.urlencode(
            {"uid": uid, "ukey": ukey, "format": "json"})
        items, mode = _tmd_from_json(_get_json(url)), "api-key"
    else:
        items, mode = _tmd_from_xml(_get_text(CFG["TMD_PUBLIC_XML"])), "public-xml"
    return {"configured": True, "mode": mode, "at": _now(), "items": items[:20]}


# ---------------------------------------------------------------- Traffy Fondue

TRAFFY_PAGE = 1000
TRAFFY_MAX_PAGES = 15
_FLOOD_WORDS = ("น้ำท่วม", "น้ำขัง", "ท่วมขัง")


def _traffy_time(s):
    try:
        return datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


def _is_flood(p: dict) -> bool:
    t = p.get("problem_type_fondue") or p.get("type") or []
    t = t if isinstance(t, list) else [t]
    if any("น้ำท่วม" in str(x) for x in t):
        return True
    desc = str(p.get("description") or "")
    return any(w in desc for w in _FLOOD_WORDS)


def _https(u) -> str:
    return u if isinstance(u, str) and u.startswith("https://") else ""


def fetch_traffy() -> dict:
    """ดึงเรื่องแจ้งล่าสุด (API เรียงใหม่->เก่า) ทีละหน้า จนเลยช่วง TRAFFY_HOURS
    แล้วคัดเฉพาะเรื่องน้ำท่วม/น้ำขัง (ตัวกรองประเภทฝั่ง API ใช้ไม่ได้ จึงกรองเอง)"""
    if not CFG.get("TRAFFY_ENABLED", True):
        return {"configured": False, "items": []}
    hours = float(CFG.get("TRAFFY_HOURS") or 72)
    cutoff = datetime.now() - timedelta(hours=hours)
    items, scanned, seen = [], 0, set()
    for page in range(TRAFFY_MAX_PAGES):
        url = CFG["TRAFFY_URL"] + "?" + urllib.parse.urlencode(
            {"output_format": "json", "limit": TRAFFY_PAGE, "offset": page * TRAFFY_PAGE})
        js = _get_json(url)
        feats = js.get("features") if isinstance(js, dict) else None
        feats = feats if isinstance(feats, list) else []
        oldest = None
        for f in feats:
            p = (f or {}).get("properties") or {}
            ts = _traffy_time(p.get("timestamp"))
            scanned += 1
            if ts is not None:
                oldest = ts if oldest is None or ts < oldest else oldest
            if ts is None or ts < cutoff or not _is_flood(p):
                continue
            tid = str(p.get("ticket_id") or "")
            if tid in seen:
                continue
            seen.add(tid)
            c = ((f.get("geometry") or {}).get("coordinates") or [None, None])
            t = p.get("problem_type_fondue") or []
            items.append({
                "id": tid,
                "lon": _num(c[0]) if len(c) > 1 else None,
                "lat": _num(c[1]) if len(c) > 1 else None,
                "state": str(p.get("state") or ""),
                "types": [str(x) for x in (t if isinstance(t, list) else [t])],
                "desc": str(p.get("description") or "")[:400],
                "address": str(p.get("address") or "")[:200],
                "district": str(p.get("district") or ""),
                "subdistrict": str(p.get("subdistrict") or ""),
                "province": str(p.get("province") or ""),
                "org": ", ".join(map(str, p.get("org"))) if isinstance(p.get("org"), list)
                       else str(p.get("org") or ""),
                "photo": _https(p.get("photo_url")),
                "after_photo": _https(p.get("after_photo")),
                "time": str(p.get("timestamp") or "")[:19],
                "last": str(p.get("last_activity") or "")[:19],
            })
        if len(feats) < TRAFFY_PAGE or (oldest is not None and oldest < cutoff):
            break
    by_state: dict[str, int] = {}
    by_dist: dict[str, dict] = {}
    for it in items:
        by_state[it["state"]] = by_state.get(it["state"], 0) + 1
        key = it["district"] or "ไม่ระบุ"
        d = by_dist.setdefault(key, {"district": key, "province": it["province"], "count": 0, "open": 0})
        d["count"] += 1
        if not any(w in it["state"] for w in ("เสร็จสิ้น", "ยกเลิก", "ไม่เกี่ยวข้อง")):
            d["open"] += 1
    return {"configured": True, "hours": hours, "scanned": scanned, "items": items,
            "by_state": by_state,
            "by_district": sorted(by_dist.values(), key=lambda r: (-r["open"], -r["count"]))}


# ---------------------------------------------------------------- รวมทุกแหล่ง

SOURCES = {
    "waterlevel": fetch_waterlevel,
    "rain": fetch_rain,
    "main": fetch_main,
    "gistda": fetch_gistda,
    "tmd": fetch_tmd,
    "traffy": fetch_traffy,
}


def load_cache() -> dict:
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_cache(d: dict) -> None:
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, CACHE_FILE)


def refresh_all() -> dict:
    """ดึงทุกแหล่ง แหล่งที่พังใช้ข้อมูลรอบก่อน แล้วบันทึก cache"""
    with _lock:
        old = load_cache()
        data = {"updated_at": _now(), "status": {}}
        for name, fn in SOURCES.items():
            try:
                data[name] = fn()
                data["status"][name] = {"ok": True, "at": _now(), "error": ""}
            except Exception as e:  # noqa: BLE001 - แหล่งไหนพังต้องไม่ลามไปแหล่งอื่น
                data[name] = old.get(name)
                prev_at = ((old.get("status") or {}).get(name) or {}).get("at", "")
                data["status"][name] = {"ok": False, "at": prev_at,
                                        "error": f"{type(e).__name__}: {e}"[:300]}
        save_cache(data)
        return data
