"""cam_health.py - ตรวจกล้อง CCTV ที่เสีย (วันละครั้ง) เพื่อซ่อนออกจากหน้าเว็บ

กล้อง "เสีย" = ภาพนิ่งโหลดไม่ได้ (หรือ URL เป็นตัวอย่าง X.X.X.X) และวิดีโอสด (hls) ก็เปิดไม่ได้/ไม่มี
ผลเก็บใน data/cam_health.json = {"at": ..., "checked": N, "bad": [camid, ...]}
"""
from __future__ import annotations

import json
import os
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from config import DATA_DIR

HEALTH_FILE = os.path.join(DATA_DIR, "cam_health.json")
EVERY_HOURS = 24
TIMEOUT = 8
WORKERS = 12
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 FloodReal/1.0"
_lock = threading.Lock()
_running = False


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def load() -> dict:
    try:
        with open(HEALTH_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def age_hours(h: dict) -> float:
    try:
        return (datetime.now() - datetime.strptime(str(h.get("at"))[:19], "%Y-%m-%dT%H:%M:%S")).total_seconds() / 3600
    except (TypeError, ValueError):
        return 9999.0


def due(h: dict) -> bool:
    return age_hours(h) >= EVERY_HOURS


def _img_ok(url: str) -> bool:
    if not url or "X.X.X.X" in url:
        return False
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            ct = (r.headers.get("Content-Type") or "").lower()
            body = r.read(30000)
            return r.status == 200 and ct.startswith("image/") and len(body) >= 2000
    except Exception:  # noqa: BLE001
        return False


def _hls_ok(url: str) -> bool:
    if not url:
        return False
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status == 200 and b"#EXTM3U" in r.read(2048)
    except Exception:  # noqa: BLE001
        return False


def _cam_ok(c: dict) -> bool:
    # ลอง 2 ครั้ง กันเน็ตสะดุดชั่วคราว
    for _ in range(2):
        if _img_ok(c.get("img") or "") or _hls_ok(c.get("hls") or ""):
            return True
    return False


def run(cams: list[dict]) -> dict:
    """ตรวจทุกกล้อง (บล็อกจนเสร็จ) แล้วบันทึกผล"""
    cams = [c for c in cams if c.get("id")]
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        oks = list(ex.map(_cam_ok, cams))
    bad = [c["id"] for c, ok in zip(cams, oks) if not ok]
    res = {"at": _now(), "checked": len(cams), "bad": bad}
    # ถ้าเกือบทุกกล้อง "เสีย" พร้อมกัน แปลว่าเน็ต/ต้นทางมีปัญหา ไม่ใช่กล้องเสียจริง -> ไม่ซ่อน
    if cams and len(bad) > 0.7 * len(cams):
        res["bad"] = []
        res["note"] = "ตรวจไม่ได้ (ล้มเกือบทั้งหมด) ไม่ซ่อนกล้อง"
    tmp = HEALTH_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)
    os.replace(tmp, HEALTH_FILE)
    return res


def run_background(cams: list[dict]) -> None:
    """ตรวจเบื้องหลัง (ไม่หน่วงการดึงข้อมูลหลัก) — ผลจะถูกใช้ในรอบดึงถัดไป"""
    global _running
    with _lock:
        if _running:
            return
        _running = True

    def _job():
        global _running
        try:
            run(cams)
        except Exception:  # noqa: BLE001
            pass
        finally:
            _running = False

    threading.Thread(target=_job, name="cam-health", daemon=True).start()
