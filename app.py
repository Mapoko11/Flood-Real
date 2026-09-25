"""
app.py - Flood real (systemL) : เว็บเฝ้าดูน้ำท่วมทั้งประเทศไทย
  - ดึงข้อมูลเบื้องหลังทุก FETCH_EVERY_MINUTES นาที (thread เดียว)
  - หน้าเว็บอ่านจาก cache อย่างเดียว -> เว็บเร็ว และไม่ยิง API ภายนอกตามจำนวนคนเปิด
  - เตือนเข้า Guardian/Telegram ผ่าน _bus + รับคำสั่ง run_now / status จาก _bus

เริ่มโปรแกรม:  python app.py     แล้วเปิด http://127.0.0.1:5095
"""
from __future__ import annotations

import atexit
import threading
import time

from flask import Flask, jsonify, render_template, request

import alerts
import sources
from config import CFG

VERSION = "1.5.0"
app = Flask(__name__)
app.json.ensure_ascii = False

_stop = threading.Event()
_kick = threading.Event()          # ปลุก worker ให้ดึงทันที
_last_manual = [0.0]
_worker_state = {"running": False, "last_run": "", "last_alert": {}}


# ---------------------------------------------------------------- worker


def _cycle() -> dict:
    data = sources.refresh_all()
    try:
        _worker_state["last_alert"] = alerts.check_and_notify(data)
    except Exception as e:  # noqa: BLE001
        _worker_state["last_alert"] = {"error": str(e)}
    alerts.heartbeat(data)
    _worker_state["last_run"] = data.get("updated_at", "")
    return data


def _handle_inbox() -> None:
    b = alerts.get_bus()
    if b is None:
        return
    try:
        msgs = b.inbox()
    except Exception as e:  # noqa: BLE001
        print(f"[bus] อ่าน inbox ไม่ได้: {e}")
        return
    for msg in msgs:
        try:
            subj = str(msg.get("subject", "")).strip().lower()
            if msg.get("type") in ("command", "ask"):
                if subj == "run_now":
                    data = _cycle()
                    b.reply(msg, "ดึงข้อมูลใหม่แล้ว\n" + alerts.summary_text(data))
                elif subj in ("status", "สถานะ"):
                    b.reply(msg, alerts.summary_text(sources.load_cache()))
        except Exception as e:  # noqa: BLE001
            print(f"[bus] จัดการจดหมายไม่ได้: {e}")
        finally:
            try:
                b.ack(msg)
            except Exception:  # noqa: BLE001
                pass


def _worker() -> None:
    _worker_state["running"] = True
    every = max(5, int(CFG["FETCH_EVERY_MINUTES"])) * 60
    next_run = 0.0
    while not _stop.is_set():
        if time.time() >= next_run or _kick.is_set():
            _kick.clear()
            try:
                _cycle()
            except Exception as e:  # noqa: BLE001
                print(f"[worker] รอบนี้ผิดพลาด: {e}")
            next_run = time.time() + every
        _handle_inbox()
        _stop.wait(30)
    _worker_state["running"] = False


def start_worker() -> None:
    threading.Thread(target=_worker, name="flood-worker", daemon=True).start()
    atexit.register(lambda: (_stop.set(), alerts.stopped()))


# ---------------------------------------------------------------- routes


@app.get("/")
def index():
    return render_template("index.html", version=VERSION, cfg=CFG)


@app.get("/api/data")
def api_data():
    d = sources.load_cache()
    g = d.get("gistda") or {}
    d["gistda"] = {"configured": g.get("configured", False),
                   "periods": g.get("periods") or {}}   # cache เก่า (ก่อนมีหลายช่วง) จะได้ {} แทน
    d["thresholds"] = {"wl": CFG["ALERT_WL_PERCENT"], "rain": CFG["ALERT_RAIN_MM"],
                       "dam": CFG["ALERT_DAM_PERCENT"]}
    d["worker"] = _worker_state
    return jsonify(d)


@app.get("/api/gistda.geojson")
def api_gistda():
    period = request.args.get("period", "1day")
    if period not in sources.GISTDA_PERIODS:        # กัน path traversal: รับเฉพาะชื่อที่รู้จัก
        return jsonify({"error": "period ไม่ถูกต้อง"}), 400
    try:
        with open(sources.gistda_file(period), "r", encoding="utf-8") as f:
            return app.response_class(f.read(), mimetype="application/json")
    except OSError:
        return jsonify({"type": "FeatureCollection", "features": []})


_radar_cache = {"at": 0.0, "data": None}
_radar_lock = threading.Lock()
RADAR_URL = "https://api.rainviewer.com/public/weather-maps.json"


@app.get("/api/radar")
def api_radar():
    """รายการเฟรมเรดาร์ RainViewer — ให้ server ถือ cache 5 นาที
    (หลายเครื่องเปิดพร้อมกันก็ยิง RainViewer แค่ครั้งเดียว ตามเงื่อนไขห้ามยิงถี่)"""
    with _radar_lock:
        if _radar_cache["data"] is None or time.time() - _radar_cache["at"] > 300:
            try:
                js = sources._get_json(RADAR_URL)
                host = js.get("host") if isinstance(js, dict) else None
                radar = (js or {}).get("radar") or {}
                frames = [{"time": int(f["time"]), "path": str(f["path"]), "now": k == "nowcast"}
                          for k in ("past", "nowcast") for f in (radar.get(k) or [])
                          if isinstance(f, dict) and "time" in f and "path" in f]
                if not (isinstance(host, str) and host.startswith("https://") and frames):
                    raise ValueError("รูปแบบข้อมูล RainViewer ไม่ถูกต้อง")
                _radar_cache.update(at=time.time(), data={"ok": True, "host": host, "frames": frames})
            except Exception as e:  # noqa: BLE001
                if _radar_cache["data"] is None:
                    return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"[:200]}), 502
                _radar_cache["at"] = time.time() - 240      # ลองใหม่ใน 1 นาที ระหว่างนี้ใช้ของเดิม
    return jsonify(_radar_cache["data"])


@app.post("/api/refresh")
def api_refresh():
    # กดได้ทุก 60 วินาที กันยิง API ภายนอกถี่เกิน
    if time.time() - _last_manual[0] < 60:
        return jsonify({"ok": False, "msg": "เพิ่งดึงไป รอ 1 นาทีแล้วลองใหม่"}), 429
    _last_manual[0] = time.time()
    _kick.set()
    return jsonify({"ok": True, "msg": "สั่งดึงข้อมูลใหม่แล้ว รอสักครู่"})


@app.get("/health")
def health():
    st = sources.load_cache().get("status") or {}
    return jsonify({"ok": True, "version": VERSION, "worker": _worker_state["running"],
                    "last_run": _worker_state["last_run"],
                    "sources": {k: v.get("ok") for k, v in st.items()}})


@app.after_request
def _headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def _lan_ips() -> list[str]:
    """IP ของเครื่องนี้ (ไว้บอกเครื่องอื่นว่าเข้าที่ไหน)"""
    import socket
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


if __name__ == "__main__":
    start_worker()
    host, port = CFG["HOST"], int(CFG["PORT"])
    print(f"Flood real {VERSION}")
    print(f"  เครื่องนี้ : http://127.0.0.1:{port}")
    if host == "0.0.0.0":
        for ip in _lan_ips():
            print(f"  เครื่องอื่น: http://{ip}:{port}")
    try:
        from waitress import serve     # server สำหรับใช้งานจริง รองรับหลายคนพร้อมกัน
        print("  server   : waitress")
        serve(app, host=host, port=port, threads=8, ident="FloodReal")
    except ImportError:
        print("  server   : Flask (ยังไม่ได้ติดตั้ง waitress)")
        app.run(host=host, port=port, debug=False, use_reloader=False)
