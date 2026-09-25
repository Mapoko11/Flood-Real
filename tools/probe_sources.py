"""
probe_sources.py - ทดสอบว่าเครื่องที่รันอยู่ (เช่น GitHub Actions) เข้าถึงแหล่งข้อมูลได้ไหม
ไม่แสดง key ใดๆ แสดงแค่ OK/FAIL + จำนวน + เวลา
ใช้:  python tools/probe_sources.py      (GISTDA key อ่านจาก env GISTDA_API_KEY ถ้ามี)
"""
from __future__ import annotations

import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sources  # noqa: E402
from config import CFG  # noqa: E402

key = os.environ.get("GISTDA_API_KEY", "").strip()
if key:
    CFG["GISTDA_API_KEY"] = key


def gistda_one_page():
    if not key:
        return "ข้าม (ไม่มี secret GISTDA_API_KEY)"
    url = CFG["GISTDA_FLOOD_URL"].rsplit("/", 1)[0] + "/3days?" + urllib.parse.urlencode({"limit": 5, "offset": 0})
    js = sources._get_json(url, headers={"API-Key": key})
    return f"{len(js.get('features') or [])} features (หน้าแรก limit 5)"


def traffy_one_page():
    url = CFG["TRAFFY_URL"] + "?" + urllib.parse.urlencode({"output_format": "json", "limit": 20, "offset": 0})
    js = sources._get_json(url)
    return f"{len(js.get('features') or [])} เรื่อง (limit 20)"


def rainviewer():
    js = sources._get_json("https://api.rainviewer.com/public/weather-maps.json")
    return f"{len((js.get('radar') or {}).get('past') or [])} เฟรม"


def tmd():
    t = sources._get_text(CFG["TMD_PUBLIC_XML"])
    return f"{len(sources._tmd_from_xml(t))} ประกาศ"


TESTS = [
    ("ThaiWater ระดับน้ำ", lambda: f"{len(sources.fetch_waterlevel())} สถานี"),
    ("ThaiWater ฝน 24 ชม.", lambda: f"{len(sources.fetch_rain())} สถานี"),
    ("ThaiWater เขื่อน/คาดการณ์", lambda: (lambda m: f"{len(m['dams'])} เขื่อน, {len(m['forecast'])} ภาพคาดการณ์")(sources.fetch_main())),
    ("GISTDA ดาวเทียม", gistda_one_page),
    ("Traffy Fondue", traffy_one_page),
    ("RainViewer", rainviewer),
    ("กรมอุตุฯ XML", tmd),
]

ok_all = True
print(f"{'แหล่งข้อมูล':<28} ผล")
print("-" * 70)
for name, fn in TESTS:
    t0 = time.time()
    try:
        res = fn()
        print(f"{name:<28} OK   {res}  ({time.time() - t0:.1f}s)")
    except Exception as e:  # noqa: BLE001
        ok_all = False
        print(f"{name:<28} FAIL {type(e).__name__}: {str(e)[:120]}  ({time.time() - t0:.1f}s)")
print("-" * 70)
print("สรุป:", "ทุกแหล่งผ่าน" if ok_all else "มีบางแหล่งเข้าไม่ได้")
