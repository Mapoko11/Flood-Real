"""
build_static.py - สร้างเว็บแบบ static (ไม่มี server) สำหรับ GitHub Pages
ขั้นตอน: ดึงข้อมูลทุกแหล่ง -> เขียนโฟลเดอร์ site/ (index.html + static/ + data/*.json)
ใช้:  python tools/build_static.py      (GISTDA key อ่านจาก env GISTDA_API_KEY)
"""
from __future__ import annotations

import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import sources  # noqa: E402
from config import CFG  # noqa: E402

key = os.environ.get("GISTDA_API_KEY", "").strip()
if key:
    CFG["GISTDA_API_KEY"] = key
EVERY = os.environ.get("SITE_EVERY_MINUTES", "30")

import app as webapp  # noqa: E402  (import หลังตั้ง key)

SITE = os.path.join(ROOT, "site")


def seed_from_live_site() -> None:
    """ดึงข้อมูลรอบก่อนจากเว็บที่ออนไลน์อยู่ มาเป็น cache ตั้งต้น
    -> GISTDA (ชั่วโมงละครั้ง) และกรมอุตุฯ (30 นาที) ไม่ถูกยิงซ้ำทุก 15 นาที
    ถ้าดึงไม่ได้ก็แค่ข้าม (รอบนั้นจะดึงสดทั้งหมดแทน)"""
    base = os.environ.get("PREV_SITE_URL", "").rstrip("/")
    if not base:
        return
    try:
        prev = sources._get_json(base + "/data/latest.json")
        periods = ((prev.get("gistda") or {}).get("periods") or {})
        for p in sources.GISTDA_PERIODS:
            if (periods.get(p) or {}).get("ok"):
                fc = sources._get_json(f"{base}/data/gistda_{p}.json")
                with open(sources.gistda_file(p), "w", encoding="utf-8") as f:
                    json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
        seed = {"gistda": {"configured": True, "periods": periods}, "tmd": prev.get("tmd") or {},
                "bma": prev.get("bma") or {}, "bma_canal": prev.get("bma_canal") or {}}
        sources.save_cache(seed)
        print("  seed      ใช้ข้อมูล GISTDA/กรมอุตุฯ/กทม. รอบก่อนจากเว็บที่ออนไลน์")
    except Exception as e:  # noqa: BLE001
        print(f"  seed      ข้าม ({type(e).__name__})")


def main() -> int:
    seed_from_live_site()
    data = sources.refresh_all()
    st = data.get("status") or {}
    for k, v in st.items():
        print(f"  {k:<11} {'OK' if v.get('ok') else 'FAIL ' + v.get('error', '')[:100]}")

    if os.path.isdir(SITE):
        shutil.rmtree(SITE)
    os.makedirs(os.path.join(SITE, "data"))

    # หน้าเว็บ: render template จริง แล้วเปลี่ยน path ให้เป็นแบบ relative + เปิดโหมด STATIC
    html = webapp.app.test_client().get("/").get_data(as_text=True)
    html = html.replace('"/static/', '"static/')
    proxy = json.dumps(os.environ.get("TRAFFIC_PROXY_URL", "").strip())   # Worker ซ่อน key (ไม่ใช่ความลับ)
    html = html.replace("<script src=", f"<script>window.FLOOD_STATIC=true;window.FLOOD_PROXY={proxy};</script>\n<script src=", 1)
    html = html.replace(f"อัปเดตอัตโนมัติทุก {CFG['FETCH_EVERY_MINUTES']} นาที",
                        f"อัปเดตอัตโนมัติทุก ~{EVERY} นาที (GitHub)")
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)

    shutil.copytree(os.path.join(ROOT, "static"), os.path.join(SITE, "static"))

    payload = webapp.build_payload()
    payload["worker"] = {"running": False, "static": True}
    with open(os.path.join(SITE, "data", "latest.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    for p in sources.GISTDA_PERIODS:
        src = sources.gistda_file(p)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(SITE, "data", f"gistda_{p}.json"))

    with open(os.path.join(SITE, ".nojekyll"), "w") as f:
        f.write("")

    ok = sum(1 for v in st.values() if v.get("ok"))
    print(f"site/ พร้อม ({ok}/{len(st)} แหล่งดึงได้)")
    # ล้มเฉพาะเมื่อแหล่งหลัก (ระดับน้ำ) ใช้ไม่ได้ -> ไม่ deploy เว็บว่างทับของเดิม
    return 0 if (st.get("waterlevel") or {}).get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
