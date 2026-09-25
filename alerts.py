"""
alerts.py - ตรวจข้อมูลกับเกณฑ์ แล้วส่งเตือนเข้า Guardian (Telegram) ผ่าน _bus
  - กันเตือนซ้ำ: สถานีเดิมเตือนได้อีกครั้งเมื่อผ่าน ALERT_REPEAT_HOURS
  - bus พัง/ไม่มี = แค่ log ไว้ เว็บยังทำงานต่อได้
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta

from config import CFG, DATA_DIR

STATE_FILE = os.path.join(DATA_DIR, "alert_state.json")

try:
    import bus as _busmod
except Exception:  # noqa: BLE001
    _busmod = None

_bus = None


def get_bus():
    """เปิด bus ครั้งเดียว ถ้าเปิดไม่ได้คืน None (ไม่ทำให้แอปล้ม)"""
    global _bus
    if _bus is None and _busmod is not None:
        try:
            _bus = _busmod.Bus(CFG["BUS_NAME"])
        except Exception as e:  # noqa: BLE001
            print(f"[alerts] เปิด _bus ไม่ได้: {e}")
    return _bus


def _load_state() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(d: dict) -> None:
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


def _fmt(v, nd=1) -> str:
    return "-" if v is None else f"{v:,.{nd}f}"


def find_hits(data: dict) -> list[dict]:
    """คืนรายการที่เกินเกณฑ์ [{key, kind, text, score}] เรียงจากหนักสุด"""
    hits = []
    for w in data.get("waterlevel") or []:
        p = w.get("bank_pct")
        if p is not None and p >= CFG["ALERT_WL_PERCENT"]:
            hits.append({
                "key": f"wl:{w.get('id')}", "kind": "wl", "score": p,
                "text": f"🌊 {w['name']} ({w['amphoe']} {w['province']}) "
                        f"ระดับน้ำ {_fmt(p, 0)}% ของตลิ่ง",
            })
    for r in data.get("rain") or []:
        mm = r.get("rain")
        if mm is not None and mm >= CFG["ALERT_RAIN_MM"]:
            hits.append({
                "key": f"rain:{r.get('id')}", "kind": "rain", "score": mm,
                "text": f"🌧️ {r['name']} ({r['amphoe']} {r['province']}) ฝน 24 ชม. {_fmt(mm)} มม.",
            })
    for d in (data.get("main") or {}).get("dams") or []:
        p = d.get("pct")
        if p is not None and p >= CFG["ALERT_DAM_PERCENT"]:
            hits.append({
                "key": f"dam:{d.get('id')}", "kind": "dam", "score": p,
                "text": f"🏞️ {d['name']} น้ำ {_fmt(p, 0)}% ของความจุ",
            })
    order = {"wl": 0, "dam": 1, "rain": 2}
    hits.sort(key=lambda h: (order[h["kind"]], -h["score"]))
    return hits


def summary_text(data: dict) -> str:
    wl = data.get("waterlevel") or []
    rain = data.get("rain") or []
    dams = (data.get("main") or {}).get("dams") or []
    over = sum(1 for w in wl if w.get("level") == 5)
    much = sum(1 for w in wl if w.get("level") == 4)
    heavy = sum(1 for r in rain if (r.get("rain") or 0) > 90)
    dam_full = sum(1 for d in dams if (d.get("pct") or 0) > 100)
    return (f"ระดับน้ำ: ล้นตลิ่ง {over} / น้ำมาก {much} จาก {len(wl)} สถานี | "
            f"ฝนหนักมาก(>90มม.) {heavy} สถานี | เขื่อนเกินความจุ {dam_full} แห่ง "
            f"(อัปเดต {data.get('updated_at', '-')})")


def check_and_notify(data: dict) -> dict:
    """ตรวจเกณฑ์ + ส่งเตือน (เฉพาะรายการใหม่หรือครบรอบเตือนซ้ำ)"""
    hits = find_hits(data)
    result = {"hits": len(hits), "sent": 0, "error": ""}
    if not CFG["ALERT_ENABLED"] or not hits:
        return result

    now = datetime.now()
    repeat = timedelta(hours=float(CFG["ALERT_REPEAT_HOURS"]))
    state = _load_state()
    new = []
    for h in hits:
        last = state.get(h["key"])
        try:
            due = last is None or now - datetime.fromisoformat(last) >= repeat
        except ValueError:
            due = True
        if due:
            new.append(h)
    if not new:
        return result

    b = get_bus()
    if b is None:
        result["error"] = "ไม่มี _bus (ยังไม่ได้ส่ง)"
        return result

    cap = int(CFG["ALERT_MAX_ITEMS"])
    lines = [h["text"] for h in new[:cap]]
    if len(new) > cap:
        lines.append(f"...และอีก {len(new) - cap} รายการ (ดูในเว็บ)")
    body = "\n".join(lines) + "\n\n" + summary_text(data)
    try:
        b.report(f"⚠️ Flood real — เตือนน้ำ {len(new)} จุด", body, expires_minutes=180)
    except Exception as e:  # noqa: BLE001
        result["error"] = f"ส่งเข้า bus ไม่ได้: {e}"
        return result

    stamp = now.strftime("%Y-%m-%dT%H:%M:%S")
    for h in new:
        state[h["key"]] = stamp
    # ล้างคีย์เก่าเกิน 7 วัน กันไฟล์โต
    cutoff = now - timedelta(days=7)
    for k in list(state):
        try:
            if datetime.fromisoformat(state[k]) < cutoff:
                del state[k]
        except ValueError:
            del state[k]
    _save_state(state)
    result["sent"] = len(new)
    return result


def heartbeat(data: dict) -> None:
    b = get_bus()
    if b is None:
        return
    st = data.get("status") or {}
    bad = [k for k, v in st.items() if not v.get("ok")]
    status = "running" if not bad else "degraded"
    detail = summary_text(data) + (f" | แหล่งที่ดึงไม่ได้: {', '.join(bad)}" if bad else "")
    try:
        b.heartbeat(status, detail[:400],
                    expect_every_minutes=int(CFG["FETCH_EVERY_MINUTES"]) * 3)
    except Exception as e:  # noqa: BLE001
        print(f"[alerts] heartbeat ไม่ได้: {e}")


def stopped() -> None:
    b = get_bus()
    if b is None:
        return
    try:
        b.heartbeat("stopped", "ปิดโปรแกรมแล้ว", expect_every_minutes=0)
    except Exception:  # noqa: BLE001
        pass
