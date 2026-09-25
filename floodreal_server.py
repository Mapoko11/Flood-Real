"""
floodreal_server.py - ตัวเปิด Flood real (ใช้ทั้ง run.bat และ Guardian)
  - Guardian เฝ้าจากชื่อไฟล์นี้ในคำสั่ง (watch_bots match: floodreal_server.py)
  - เปิดแบบไม่มีหน้าต่าง (pyw) ได้: ข้อความทั้งหมดไปอยู่ที่ data\\server.log
"""
import os
import sys
from logging.handlers import RotatingFileHandler
import logging

BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE)
sys.path.insert(0, BASE)
os.makedirs(os.path.join(BASE, "data"), exist_ok=True)
LOG = os.path.join(BASE, "data", "server.log")

handler = RotatingFileHandler(LOG, maxBytes=2_000_000, backupCount=2, encoding="utf-8")
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[handler])


class _Tee:
    """เขียนทั้งจอ (ถ้ามี) และไฟล์ log"""
    def __init__(self, stream, fh):
        self.stream, self.fh = stream, fh

    def write(self, s):
        if self.stream:
            try:
                self.stream.write(s)
            except Exception:  # noqa: BLE001
                pass
        self.fh.write(s)
        self.fh.flush()
        return len(s)

    def flush(self):
        if self.stream:
            try:
                self.stream.flush()
            except Exception:  # noqa: BLE001
                pass
        self.fh.flush()


_fh = open(LOG + ".console", "a", encoding="utf-8")
sys.stdout = _Tee(sys.stdout, _fh)      # pythonw: sys.stdout = None -> เขียนลงไฟล์อย่างเดียว
sys.stderr = _Tee(sys.stderr, _fh)

import app  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(app.main())
