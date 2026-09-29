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
import math
import os
import re
import xml.etree.ElementTree as ET
import threading
import urllib.error
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
TMD_MAX_AGE_DAYS = 14    # แสดงเฉพาะประกาศที่ออกไม่เกินกี่วัน


def _parse_thai_dt(v):
    """อ่านวันที่หลายรูปแบบ: 15/4/2568 5:17:23 (พ.ศ.), 2026-09-25 05:00, RSS pubDate"""
    from email.utils import parsedate_to_datetime
    t = str(v or "").strip()
    if not t:
        return None
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?", t)
    if m:
        d, mo, y = int(m[1]), int(m[2]), int(m[3])
        if y > 2400:
            y -= 543                      # พ.ศ. -> ค.ศ.
        try:
            return datetime(y, mo, d, int(m[4] or 0), int(m[5] or 0), int(m[6] or 0))
        except ValueError:
            return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?", t)
    if m:
        y = int(m[1]) - (543 if int(m[1]) > 2400 else 0)
        try:
            return datetime(y, int(m[2]), int(m[3]), int(m[4] or 0), int(m[5] or 0))
        except ValueError:
            return None
    try:
        dt = parsedate_to_datetime(t)
        return dt.replace(tzinfo=None) if dt else None
    except (TypeError, ValueError, IndexError):
        return None


# เว็บบางแห่ง (เช่น tmd.go.th) ตั้ง SSL ไม่ครบ: ไม่ส่งใบรับรองตัวกลาง (intermediate) มาด้วย
# วิธีแก้แบบปลอดภัย: อ่าน URL ของใบตัวกลางจากใบรับรองของเว็บ (AIA) -> ดาวน์โหลดมาเติม
# แล้วตรวจ chain เต็มจนถึง root ที่เครื่องเชื่อถือตามปกติ (ไม่ได้ปิดการตรวจ SSL)
_AIA_HOSTS = ("tmd.go.th", "www.tmd.go.th", "data.tmd.go.th")
_aia_ctx: dict = {}


def _aia_context(host: str):
    import socket
    import ssl
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import Encoding
    from cryptography.x509.oid import AuthorityInformationAccessOID, ExtensionOID

    if host in _aia_ctx:
        return _aia_ctx[host]
    peek = ssl.create_default_context()
    peek.check_hostname = False
    peek.verify_mode = ssl.CERT_NONE          # ใช้แค่ "หยิบใบรับรองมาอ่าน" ไม่ได้ส่งข้อมูลใดๆ
    with socket.create_connection((host, 443), timeout=CFG["HTTP_TIMEOUT"]) as sock:
        with peek.wrap_socket(sock, server_hostname=host) as tls:
            der = tls.getpeercert(binary_form=True)
    leaf = x509.load_der_x509_certificate(der)
    aia = leaf.extensions.get_extension_for_oid(ExtensionOID.AUTHORITY_INFORMATION_ACCESS).value
    urls = [d.access_location.value for d in aia
            if d.access_method == AuthorityInformationAccessOID.CA_ISSUERS][:2]
    pems = []
    for u in urls:
        with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}),
                                    timeout=CFG["HTTP_TIMEOUT"]) as r:
            raw = r.read()
        try:
            cert = x509.load_der_x509_certificate(raw)
        except ValueError:
            cert = x509.load_pem_x509_certificate(raw)
        pems.append(cert.public_bytes(Encoding.PEM).decode())
    if not pems:
        raise RuntimeError("ไม่พบ URL ใบรับรองตัวกลาง (AIA)")
    ctx = ssl.create_default_context()        # ยังตรวจ hostname + chain ถึง root ตามปกติ
    ctx.load_verify_locations(cadata="".join(pems))
    _aia_ctx[host] = ctx
    return ctx


def _get_text(url: str) -> str:
    import ssl
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/xml,text/xml,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=CFG["HTTP_TIMEOUT"]) as r:
            return r.read().decode("utf-8-sig", errors="replace")
    except urllib.error.URLError as e:
        host = urllib.parse.urlsplit(url).hostname or ""
        if not (isinstance(e.reason, ssl.SSLCertVerificationError) and host in _AIA_HOSTS):
            raise
    ctx = _aia_context(host)
    with urllib.request.urlopen(req, timeout=CFG["HTTP_TIMEOUT"], context=ctx) as r:
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
    # ฟีดบางตัวของกรมอุตุฯ ไม่อัปเดตแล้ว (ค้างของปี 2565-2568) -> เก็บเฉพาะประกาศใหม่
    for it in items:
        it["_dt"] = _parse_thai_dt(it.get("time"))
    dated = [it for it in items if it["_dt"]]
    latest = max((it["_dt"] for it in dated), default=None)
    cutoff = datetime.now() - timedelta(days=TMD_MAX_AGE_DAYS)
    fresh = [it for it in items if it["_dt"] is None or it["_dt"] >= cutoff]
    fresh.sort(key=lambda it: (it["_dt"] is not None, it["_dt"] or datetime.min), reverse=True)
    for it in items:
        it.pop("_dt", None)
    return {"configured": True, "mode": mode, "at": _now(), "items": fresh[:20],
            "feed_total": len(items), "max_age_days": TMD_MAX_AGE_DAYS,
            "feed_latest": latest.strftime("%Y-%m-%d %H:%M") if latest else ""}


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

# ---------------------------------------------------------------- กทม. น้ำท่วมถนน (สำนักการระบายน้ำ)
# ต้นทาง: หน้า https://weather.bangkok.go.th/Flood/  (ไม่มี API ทางการ ใช้ endpoint เดียวกับหน้าเว็บ)
# เซิร์ฟเวอร์ กทม. มีตัวกันยิงถี่ (ตอบ 403) -> ดึงห่างอย่างน้อย BMA_EVERY_MINUTES และยิงครั้งเดียวต่อรอบ
BMA_EVERY_MINUTES = 20      # เดิม 10 — กทม. บล็อก IP ที่เรียกถี่ (29 ก.ย.) จึงลดเหลือ 20 นาที
_BMA_MS = re.compile(r"/Date\((-?\d+)\)/")


def _bma_time(v) -> str:
    m = _BMA_MS.search(str(v or ""))
    if not m:
        return ""
    return datetime.fromtimestamp(int(m.group(1)) / 1000).strftime("%Y-%m-%dT%H:%M:%S")


def _bma_state(txt: str) -> str:
    t = str(txt or "")
    if "ขัดข้อง" in t or "ปิดระบบ" in t:
        return "down"
    if "เล็กน้อย" in t:
        return "minor"
    if "ท่วม" in t:
        return "flood"
    if "ปกติ" in t:
        return "normal"
    return "unknown"


BMA_STALE_MIN = 60     # เวลาวัดล่าสุดเก่ากว่านี้ = ข้อมูลที่ได้ "ค้าง" (Worker อาจส่งชุดเก่าที่จำไว้เพราะเว็บ กทม. ไม่ตอบ)


def _age_min(t: str) -> float | None:
    """นาทีตั้งแต่เวลา ISO (เวลาเครื่อง) หรือ 'dd/mm/พ.ศ. HH:MM' ถึงตอนนี้"""
    s = str(t or "").strip()
    try:
        if "/" in s:
            d, hm = (s.split(" ") + ["00:00"])[:2]
            dd, mm, yy = [int(x) for x in d.split("/")]
            hh, mi = [int(x) for x in hm.split(":")[:2]]
            dt = datetime(yy - 543 if yy > 2400 else yy, mm, dd, hh, mi)
        else:
            dt = datetime.fromisoformat(s[:19])
    except Exception:  # noqa: BLE001
        return None
    return (datetime.now() - dt).total_seconds() / 60


def _newest(times) -> tuple[str, float | None]:
    """(เวลาใหม่สุด, อายุเป็นนาที) จากรายการเวลา"""
    best, age = "", None
    for t in times:
        a = _age_min(t)
        if a is not None and (age is None or a < age):
            best, age = t, a
    return best, age


def fetch_bma() -> dict:
    """จุดวัดน้ำท่วมถนน กทม. (ระดับน้ำบนผิวถนน หน่วย ซม.)"""
    if not CFG.get("BMA_FLOOD_ENABLED", True):
        return {"configured": False, "points": []}
    old = load_cache().get("bma") or {}
    if old.get("points") is not None and _minutes_since(old.get("at")) < BMA_EVERY_MINUTES:
        return old
    url = CFG.get("BMA_FLOOD_URL") or "https://weather.bangkok.go.th/Flood/PageMap/GetData?id=0"
    proxy = (CFG.get("BMA_PROXY_URL") or "").strip()
    js, via, errs = None, "", []
    if proxy:
        try:
            js, via = _get_json(proxy), "proxy"
        except Exception as e:  # noqa: BLE001
            errs.append(f"proxy {type(e).__name__}: {e}"[:120])
    if js is not None:     # Worker ส่งชุดเก่า (เว็บ กทม. ไม่ตอบ Worker) -> ลองดึงตรงจากเครื่องนี้อีกทาง
        rows0 = js.get("dtTbl") if isinstance(js, dict) else None
        _, a0 = _newest(_bma_time(r.get("site_timestamp")) for r in (rows0 or []) if isinstance(r, dict))
        if a0 is not None and a0 > BMA_STALE_MIN:
            try:
                js2 = _get_json(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/140.0 Safari/537.36 FloodReal/1.0",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://weather.bangkok.go.th/Flood/",
            })
                rows2 = js2.get("dtTbl") if isinstance(js2, dict) else None
                _, a2 = _newest(_bma_time(r.get("site_timestamp")) for r in (rows2 or []) if isinstance(r, dict))
                if a2 is not None and a2 < a0:
                    js, via = js2, "direct (ตัวกลางส่งข้อมูลเก่า)"
                else:
                    via = "proxy (ต้นทางเก่า ดึงตรงก็เก่า)"
            except Exception as e:  # noqa: BLE001
                via = f"proxy (ข้อมูลเก่า · ดึงตรงไม่ได้: {type(e).__name__})"[:80]
    if js is None:
        try:
            js, via = _get_json(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/140.0 Safari/537.36 FloodReal/1.0",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://weather.bangkok.go.th/Flood/",
            }), "direct"
        except Exception as e:  # noqa: BLE001
            errs.append(f"direct {type(e).__name__}: {e}"[:120])
            raise RuntimeError(" | ".join(errs)) from None
    rows = js.get("dtTbl") if isinstance(js, dict) else js
    if not isinstance(rows, list):
        raise ValueError("รูปแบบข้อมูล กทม. เปลี่ยนไป (ไม่พบ dtTbl)")
    pts = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        lat, lon = _num(r.get("latitude")), _num(r.get("longitude"))
        state = _bma_state(r.get("chkStatustxt"))
        tunnel = r.get("typesite") not in (None, 1, "1")
        pts.append({
            "code": str(r.get("flood_code") or "")[:20],
            "name": str(r.get("shortname") or r.get("flood_shortname") or r.get("flood_name") or "").strip()[:120],
            "road": str(r.get("road_name") or "").strip()[:80],
            "district": str(r.get("districtName") or "").strip()[:40],
            "lat": lat, "lon": lon,
            "cm": _num(r.get("flood")),
            "max_cm": _num(r.get("flood_max")),
            "state": state,
            "status_txt": str(r.get("chkStatustxt") or "")[:30],
            "since": _bma_time(r.get("flood_start")) if state in ("flood", "minor") else "",
            "time": _bma_time(r.get("site_timestamp")),
            "tunnel": bool(tunnel),
        })
    if not pts:
        raise ValueError("กทม. ส่งข้อมูลว่าง")
    order = {"flood": 0, "minor": 1, "normal": 2, "unknown": 3, "down": 4}
    pts.sort(key=lambda p: (order.get(p["state"], 9), -(p["cm"] or 0)))
    count = {k: sum(1 for p in pts if p["state"] == k) for k in order}
    nt, na = _newest(p["time"] for p in pts)
    return {"configured": True, "at": _now(), "via": via, "points": pts, "count": count,
            "hist": _bma_hist(old.get("hist"), pts),
            "newest": nt, "stale_min": round(na) if (na is not None and na > BMA_STALE_MIN) else 0,
            "source": "https://weather.bangkok.go.th/Flood/"}


BMA_HIST_HOURS = 49      # เก็บภาพย้อนหลังไว้เทียบ "น้ำลด/เพิ่ม" (ชั่วโมงละ 1 ภาพ)


def _bma_hist(old, pts: list) -> list:
    """ภาพระดับน้ำรายชั่วโมง [{t, p:{code: cm}}] เก็บเฉพาะจุดที่ท่วม (จุดที่ไม่อยู่ = ไม่ท่วม)"""
    hist = [h for h in (old or []) if isinstance(h, dict) and h.get("t")]
    now = datetime.now()
    snap = {"t": now.strftime("%Y-%m-%dT%H:%M:%S"),
            "p": {p["code"]: round(p["cm"] or 0, 1) for p in pts
                  if p.get("code") and p.get("state") in ("flood", "minor")}}
    if hist and _minutes_since(hist[-1]["t"]) < 55:
        hist[-1] = snap                      # ชั่วโมงเดียวกัน -> ทับด้วยค่าล่าสุด
    else:
        hist.append(snap)
    cutoff = (now - timedelta(hours=BMA_HIST_HOURS)).strftime("%Y-%m-%dT%H:%M:%S")
    return [h for h in hist if h["t"] >= cutoff][-60:]


# ---------------------------------------------------------------- ช่วงถนน ~120 ม. รอบจุดวัด กทม. (จาก OpenStreetMap)
# ตำแหน่งจุดวัดไม่ค่อยเปลี่ยน -> หาเส้นถนนครั้งเดียวแล้วเก็บไว้ (เติมเฉพาะจุดใหม่ วันละครั้ง)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
SEG_FILE = os.path.join(DATA_DIR, "bma_segments.json")
SEG_HALF_M = 60


def _xy(lat, lon, lat0):
    return lon * 111320 * math.cos(math.radians(lat0)), lat * 110574


def _clip_segment(geom: list, lat: float, lon: float, half: float = SEG_HALF_M):
    """ตัดเส้นถนน (list [lat,lon]) ให้เหลือ ±half เมตร รอบจุดที่ใกล้ (lat,lon) ที่สุด คืน (ระยะห่างจุด, เส้น)"""
    if len(geom) < 2:
        return None
    P = [_xy(a, b, lat) for a, b in geom]
    px, py = _xy(lat, lon, lat)
    best = (1e18, 0, 0.0)
    cum = [0.0]
    for i in range(len(P) - 1):
        (x1, y1), (x2, y2) = P[i], P[i + 1]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
        d = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
        if d < best[0]:
            best = (d, i, t)
        cum.append(cum[-1] + math.sqrt(L2))
    d, i, t = best
    at = cum[i] + t * (cum[i + 1] - cum[i])
    lo, hi = max(0.0, at - half), min(cum[-1], at + half)

    def point_at(m):
        for k in range(len(cum) - 1):
            if cum[k] <= m <= cum[k + 1]:
                seg = cum[k + 1] - cum[k]
                f = 0.0 if seg == 0 else (m - cum[k]) / seg
                return [round(geom[k][0] + f * (geom[k + 1][0] - geom[k][0]), 6),
                        round(geom[k][1] + f * (geom[k + 1][1] - geom[k][1]), 6)]
        return [round(geom[-1][0], 6), round(geom[-1][1], 6)]
    line = [point_at(lo)] + [[round(a, 6), round(b, 6)] for (a, b), c in zip(geom, cum) if lo < c < hi] + [point_at(hi)]
    return d, line


def _overpass_segments(points: list) -> dict:
    """ถาม Overpass ครั้งเดียวสำหรับหลายจุด -> {code: [[lat,lon],...]}"""
    parts = "".join(f"way(around:40,{p['lat']:.6f},{p['lon']:.6f})[highway][highway!~\"footway|path|steps|cycleway|service|track\"];"
                    for p in points)
    q = f"[out:json][timeout:90];({parts});out geom;"
    req = urllib.request.Request(OVERPASS_URL, data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": UA + " (flood map; contact via github Mapoko11)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        js = json.loads(r.read().decode("utf-8"))
    ways = [[[g["lat"], g["lon"]] for g in (w.get("geometry") or [])] for w in js.get("elements") or []
            if w.get("type") == "way"]
    out = {}
    for p in points:
        cands = [c for c in (_clip_segment(g, p["lat"], p["lon"]) for g in ways) if c]
        if cands:
            d, line = min(cands, key=lambda c: c[0])
            if d <= 45:
                out[p["code"]] = line
    return out


def fetch_bma_segments() -> dict:
    """เส้นถนนรอบจุดวัด กทม. (ใช้วาดช่วงถนนน้ำท่วม) — ใช้ไฟล์เดิม เติมเฉพาะจุดที่ยังไม่มี วันละครั้ง"""
    try:
        with open(SEG_FILE, "r", encoding="utf-8") as f:
            seg = json.load(f)
    except (OSError, ValueError):
        seg = {}
    segs = seg.get("segs") or {}
    old = load_cache().get("bma_seg") or {}
    if not segs and old.get("segs"):
        segs = dict(old["segs"])
    pts = [p for p in ((load_cache().get("bma") or {}).get("points") or [])
           if p.get("code") and p.get("lat") and p.get("lon") and not p.get("tunnel")]
    missing = [p for p in pts if p["code"] not in segs and p["code"] not in (seg.get("none") or [])]
    missing.sort(key=lambda p: p.get("state") not in ("flood", "minor"))   # จุดที่กำลังท่วมก่อน
    tried = seg.get("tried", "")
    if missing and _minutes_since(tried) > 24 * 60:
        seg["tried"] = _now()
        try:
            got = _overpass_segments(missing[:300])
        except Exception:  # noqa: BLE001 - Overpass ใช้ไม่ได้ (เช่น firewall) -> ลองเอาจากเว็บ github.io
            got = {}
            fb = (CFG.get("FLOODBOARD_FALLBACK_URL") or "").strip()
            if fb:
                try:
                    got = ((_get_json(fb) or {}).get("bma_seg") or {}).get("segs") or {}
                except Exception:  # noqa: BLE001
                    got = {}
        else:
            seg["none"] = sorted(set(seg.get("none") or []) | {p["code"] for p in missing[:300] if p["code"] not in got})
        segs.update(got)
        seg["segs"] = segs
        tmp = SEG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(seg, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, SEG_FILE)
    return {"configured": True, "at": _now(), "count": len(segs), "segs": segs}



# ---------------------------------------------------------------- กทม. ระดับน้ำในคลอง (สำนักการระบายน้ำ)
# ต้นทาง: หน้า https://weather.bangkok.go.th/water  (POST /water/PageMap/GoogleMap) — ดึงผ่าน Worker เป็นหลัก
CANAL_STALE_MINUTES = 30      # เว็บ กทม. ถือว่า "การสื่อสารขัดข้อง" ถ้าข้อมูลเก่ากว่า 30 นาที


def _post_form_json(url: str, form: dict, headers: dict | None = None):
    data = urllib.parse.urlencode(form).encode()
    h = {"User-Agent": UA, "Accept": "application/json",
         "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=CFG["HTTP_TIMEOUT"]) as r:
        return json.loads(r.read().decode("utf-8-sig"))


def _canal_state(r: dict) -> str:
    age = _num(r.get("datediffnow"))
    lv = [(_num(r.get(a)), _num(r.get(w)), _num(r.get(c))) for a, w, c in (
        ("wl_in", "warning", "critical"),
        ("wl_out01", "warning_out01", "critical_out01"),
        ("wl_out02", "warning_out02", "critical_out02"))]
    if (age is not None and age > CANAL_STALE_MINUTES) or all(v is None for v, _, _ in lv):
        return "down"
    if any(v is not None and c is not None and v >= c for v, _, c in lv):
        return "critical"
    if any(v is not None and w is not None and v >= w for v, w, _ in lv):
        return "warning"
    return "normal"


def fetch_bma_canal() -> dict:
    """ระดับน้ำในคลอง กทม. (ม.รทก.) + เกณฑ์เฝ้าระวัง/วิกฤต ของแต่ละสถานี"""
    if not CFG.get("BMA_FLOOD_ENABLED", True):
        return {"configured": False, "points": []}
    old = load_cache().get("bma_canal") or {}
    if old.get("points") is not None and _minutes_since(old.get("at")) < BMA_EVERY_MINUTES:
        return old
    proxy = (CFG.get("BMA_PROXY_URL") or "").strip()
    rows, via, errs = None, "", []
    if proxy:
        try:
            rows, via = _get_json(proxy.rstrip("/") + "-canal"), "proxy"
        except Exception as e:  # noqa: BLE001
            errs.append(f"proxy {type(e).__name__}: {e}"[:120])
    if isinstance(rows, list):     # Worker ส่งชุดเก่า -> ลองดึงตรงจากเครื่องนี้อีกทาง
        _, a0 = _newest(str(r.get("site_timestampTH") or "") for r in rows if isinstance(r, dict))
        if a0 is not None and a0 > BMA_STALE_MIN:
            try:
                rows2 = _post_form_json("https://weather.bangkok.go.th/water/PageMap/GoogleMap",
                                        {"payload": "TEST_DATA_GOES_HERE"}, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 FloodReal/1.0",
                    "X-Requested-With": "XMLHttpRequest", "Referer": "https://weather.bangkok.go.th/water/"})
                _, a2 = _newest(str(r.get("site_timestampTH") or "") for r in (rows2 if isinstance(rows2, list) else []) if isinstance(r, dict))
                if a2 is not None and a2 < a0:
                    rows, via = rows2, "direct (ตัวกลางส่งข้อมูลเก่า)"
                else:
                    via = "proxy (ต้นทางเก่า ดึงตรงก็เก่า)"
            except Exception as e:  # noqa: BLE001
                via = f"proxy (ข้อมูลเก่า · ดึงตรงไม่ได้: {type(e).__name__})"[:80]
    if rows is None:
        try:
            rows, via = _post_form_json("https://weather.bangkok.go.th/water/PageMap/GoogleMap",
                                        {"payload": "TEST_DATA_GOES_HERE"}, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 FloodReal/1.0",
                "X-Requested-With": "XMLHttpRequest", "Referer": "https://weather.bangkok.go.th/water/"}), "direct"
        except Exception as e:  # noqa: BLE001
            errs.append(f"direct {type(e).__name__}: {e}"[:120])
            raise RuntimeError(" | ".join(errs)) from None
    if not isinstance(rows, list):
        raise ValueError("รูปแบบข้อมูลคลอง กทม. เปลี่ยนไป")
    pts = []
    for r in rows:
        if not isinstance(r, dict) or r.get("adjust") not in (1, "1"):
            continue                      # adjust 0/2 = สถานีปิดปรับปรุง (หน้าเว็บ กทม. ก็ไม่แสดงบนแผนที่)
        gates = [r.get(f"watergate0{i}") for i in range(1, 7)]
        pts.append({
            "code": str(r.get("water_code") or "")[:20],
            "name": str(r.get("water_shortname") or r.get("water_name") or "").strip().rstrip("*").strip()[:120],
            "full": str(r.get("water_name") or "").strip().rstrip("*").strip()[:160],
            "district": str(r.get("district_name") or "").strip()[:40],
            "lat": _num(r.get("latitude")), "lon": _num(r.get("longitude")),
            "wl_in": _num(r.get("wl_in")), "wl_out1": _num(r.get("wl_out01")), "wl_out2": _num(r.get("wl_out02")),
            "warn": _num(r.get("warning")), "crit": _num(r.get("critical")),
            "warn_out1": _num(r.get("warning_out01")), "crit_out1": _num(r.get("critical_out01")),
            "bank_l": _num(r.get("left_bank")), "bank_r": _num(r.get("right_bank")),
            "max_today": _num(r.get("max_in_day")),
            "gates": [g for g in gates if g not in (None, "", "-")][:6],
            "time": str(r.get("site_timestampTH") or "")[:20],
            "age_min": _num(r.get("datediffnow")),
            "state": _canal_state(r),
            "status_txt": str(r.get("txtStatus") or "")[:40],
        })
    if not pts:
        raise ValueError("กทม. ส่งข้อมูลคลองว่าง")
    order = {"critical": 0, "warning": 1, "normal": 2, "down": 3}
    pts.sort(key=lambda p: (order.get(p["state"], 9), p["name"]))
    count = {k: sum(1 for p in pts if p["state"] == k) for k in order}
    nt, na = _newest(p["time"] for p in pts)
    return {"configured": True, "at": _now(), "via": via, "points": pts, "count": count,
            "newest": nt, "stale_min": round(na) if (na is not None and na > BMA_STALE_MIN) else 0,
            "source": "https://weather.bangkok.go.th/water"}



# ---------------------------------------------------------------- กล้อง CCTV (iTIC Foundation / กรมทางหลวง ผ่าน Longdo Traffic)
CCTV_URL = "https://camera.longdo.com/feed/?command=json"
CCTV_EVERY_MINUTES = 60      # รายชื่อกล้องแทบไม่เปลี่ยน ดึงชั่วโมงละครั้งพอ (ภาพจริงเบราว์เซอร์โหลดจากต้นทางเอง)


def _https(u) -> str:
    u = str(u or "").strip()
    return u if u.startswith("https://") and len(u) < 400 else ""


def fetch_cctv() -> dict:
    if not CFG.get("CCTV_ENABLED", True):
        return {"configured": False, "cams": []}
    old = load_cache().get("cctv") or {}
    if old.get("cams") is not None and _minutes_since(old.get("at")) < CCTV_EVERY_MINUTES:
        return old
    rows = _get_json(CFG.get("CCTV_URL") or CCTV_URL)
    if not isinstance(rows, list):
        raise ValueError("รูปแบบข้อมูลกล้องเปลี่ยนไป")
    cams = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        lat, lon = _num(r.get("latitude")), _num(r.get("longitude"))
        img, hls, page = _https(r.get("imgurl")), _https(r.get("hls_url")), _https(r.get("link") or r.get("vdourl"))
        if lat is None or lon is None or not (img or hls or page):
            continue
        cams.append({
            "id": str(r.get("camid") or "")[:40],
            "name": str(r.get("title") or "").strip()[:160],
            "org": str(r.get("organization") or "").strip()[:60],
            "lat": lat, "lon": lon, "img": img, "hls": hls, "page": page,
            "bkk": str(r.get("geocode") or "").startswith("10"),
        })
    if not cams:
        raise ValueError("ไม่มีกล้องในฟีด")
    return {"configured": True, "at": _now(), "cams": cams, "count": len(cams),
            "source": "https://traffic.longdo.com/cameralist"}



# ---------------------------------------------------------------- Floodboard (floodboard.org) — เส้นถนนที่มีน้ำ (open data, CORS)
FLOODBOARD_URL = "https://floodboard.org/api/export/roads.geojson"
FLOODBOARD_EVERY_MINUTES = 10


def _r5(c):
    if isinstance(c, (list, tuple)):
        if c and isinstance(c[0], (int, float)):
            return [round(float(c[0]), 5), round(float(c[1]), 5)]
        return [_r5(x) for x in c]
    return c


def fetch_floodboard() -> dict:
    if not CFG.get("FLOODBOARD_ENABLED", True):
        return {"configured": False, "features": []}
    old = load_cache().get("floodboard") or {}
    if old.get("features") is not None and _minutes_since(old.get("at")) < FLOODBOARD_EVERY_MINUTES:
        return old
    try:
        js = _get_json(CFG.get("FLOODBOARD_URL") or FLOODBOARD_URL)
    except Exception as e:  # noqa: BLE001
        # บางเครือข่าย (เช่น firewall องค์กรที่ตรวจ SSL) เข้า floodboard.org ไม่ได้
        # -> ใช้ข้อมูลที่เว็บ github.io ของเราดึงไว้แล้ว (ช้ากว่าประมาณ 15–30 นาที) ไม่ปิดการตรวจ SSL
        fb = (CFG.get("FLOODBOARD_FALLBACK_URL") or "").strip()
        if not fb:
            raise
        prev = (_get_json(fb) or {}).get("floodboard") or {}
        if prev.get("features") is None:
            raise RuntimeError(f"ดึง Floodboard ไม่ได้ และไม่มีข้อมูลสำรอง ({type(e).__name__})") from None
        return {**prev, "via": "github.io"}
    feats = []
    for f in (js or {}).get("features") or []:
        g, p = f.get("geometry") or {}, f.get("properties") or {}
        if g.get("type") not in ("LineString", "MultiLineString"):
            continue
        upd = _num(p.get("updated"))
        verdict = p.get("verdict") if isinstance(p.get("verdict"), dict) else {}
        feats.append({"type": "Feature", "geometry": {"type": g["type"], "coordinates": _r5(g.get("coordinates"))},
                      "properties": {
                          "name": str(p.get("name") or p.get("nameEn") or "").strip()[:100],
                          "depth": _num(p.get("depthCm")),
                          "closedAll": bool(p.get("closedAll")), "closedSmall": bool(p.get("closedSmall")),
                          "cleared": bool(p.get("cleared")), "conf": _num(p.get("conf")),
                          "estimated": bool(p.get("estimated")),
                          "updated": datetime.fromtimestamp(upd / 1000).strftime("%Y-%m-%dT%H:%M:%S") if upd else "",
                          "verdict": {str(k)[:12]: str(v)[:12] for k, v in list(verdict.items())[:5]},
                          "sources": [str(x)[:20] for x in (p.get("sources") or [])][:6]}})
    return {"configured": True, "at": _now(), "features": feats, "count": len(feats),
            "source": "https://floodboard.org/"}


SOURCES = {
    "waterlevel": fetch_waterlevel,
    "rain": fetch_rain,
    "main": fetch_main,
    "gistda": fetch_gistda,
    "tmd": fetch_tmd,
    "traffy": fetch_traffy,
    "bma": fetch_bma,
    "bma_canal": fetch_bma_canal,
    "cctv": fetch_cctv,
    "floodboard": fetch_floodboard,
    "bma_seg": fetch_bma_segments,
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
