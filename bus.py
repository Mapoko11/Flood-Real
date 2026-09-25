"""
bus.py - "ตู้จดหมายกลาง" ให้โปรเจกต์ต่างๆ บนเครื่องเดียวกันคุยกันเอง
เวอร์ชัน 1 (22 ก.ย. 2026) - แนว A: โฟลเดอร์กลาง + ไฟล์ JSON (ไม่มี service ใหม่ให้พัง)

วิธีใช้ (ก๊อปไฟล์นี้ไปวางในโฟลเดอร์โปรเจกต์ แล้ว):
    import bus
    me = bus.Bus("systemb")                 # ชื่อฉัน (ตัวเล็กล้วน)

    me.heartbeat("running", "กำลังตรวจข้อ 28/42")   # ป้ายสถานะ (เรียกบ่อยๆ)
    me.report("งานเสร็จ", "ตรวจ 42 รายการ เจอ 3 จุด")  # ส่งรายงานให้ guardian เด้งเข้า Telegram
    me.send("aster", "command", "pause")            # สั่งงานคนอื่น
    me.publish("btc_signal", {"action": "buy"})     # ประกาศลงกระดาน

    for msg in me.inbox():                  # จดหมายใหม่ของฉัน
        if msg["type"] == "command" and msg["subject"] == "run_now":
            do_work()
            me.reply(msg, "รันเสร็จแล้ว")
        me.ack(msg)                         # อ่านแล้ว -> ย้ายเข้า _done

    ans = me.ask("guardian", "เครื่องว่างมั้ย", timeout=60)  # ถามแล้วรอคำตอบ

หลักการที่ทำให้ไม่พัง:
  - เขียนไฟล์ลง .tmp ก่อนแล้ว os.replace (อีกฝั่งไม่มีวันอ่านได้ครึ่งเดียว)
  - ข้ามไฟล์ที่เพิ่งเกิด < MIN_AGE วินาที (อาจยังเขียนไม่เสร็จ)
  - หยิบจดหมายด้วยการ rename เป็น .taken ก่อน (ใครเปลี่ยนสำเร็จคนนั้นได้ กันหยิบซ้ำ)
  - ทุกฉบับมี expires_at เลยเวลาแล้วข้าม (กันเครื่องปิดหลายวันแล้วทำคำสั่งเก่าทั้งกอง)
  - อ่าน/เขียน utf-8 + ensure_ascii=False (ภาษาไทยไม่เพี้ยน)
  - _done เกิน DONE_KEEP_DAYS วัน ลบทิ้งเอง
"""
from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime, timedelta

# โฟลเดอร์กลาง - ทุกโปรเจกต์บนเครื่องนี้ชี้มาที่เดียวกัน (ตั้ง env BUS_DIR ทับได้ตอนเทส)
BUS_DIR = os.environ.get("BUS_DIR", r"D:\Project\_bus")

MIN_AGE_SECONDS = 2          # ไฟล์ต้องนิ่งอย่างน้อยเท่านี้ ถึงถือว่าเขียนเสร็จ
DEFAULT_EXPIRE_MINUTES = 60  # จดหมายมีอายุเท่านี้ ถ้าไม่ระบุ (report/event ใช้ค่านี้เหมือนกัน)
DONE_KEEP_DAYS = 7           # จดหมายใน _done เก่ากว่านี้ = ลบทิ้ง
ASK_POLL_SECONDS = 1.0       # ask() วนเช็คคำตอบทุกกี่วินาที

VALID_TYPES = ("report", "command", "ask", "reply", "event")


def _now() -> datetime:
    return datetime.now()


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def norm_name(name: str) -> str:
    """ชื่อโปรเจกต์: ตัวเล็กล้วน ตัดช่องว่าง กันชื่อซ้ำจากพิมพ์เล็ก/ใหญ่ต่างกัน"""
    n = str(name or "").strip().lower()
    # อนุญาตเฉพาะ a-z 0-9 _ - (อย่างอื่นแปลงเป็น _) เพราะชื่อนี้ไปเป็นชื่อโฟลเดอร์ด้วย
    return "".join(c if (c.isalnum() or c in "_-") else "_" for c in n) or "unknown"


def _atomic_write_json(path: str, data: dict) -> None:
    """เขียนแบบปลอดภัย: ลง .tmp ก่อนแล้ว replace (อีกฝั่งอ่านได้ครึ่งเดียวไม่ได้)"""
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _read_json(path: str):
    """อ่าน json แบบเดารหัสภาษา (เผื่อไฟล์ที่ไม่ใช่ utf-8)"""
    for enc in ("utf-8-sig", "utf-8", "cp874"):
        try:
            with open(path, "r", encoding=enc) as f:
                return json.load(f)
        except UnicodeDecodeError:
            continue
        except Exception:
            return None
    return None


class Bus:
    def __init__(self, name: str, bus_dir: str = None):
        self.name = norm_name(name)
        self.dir = bus_dir or BUS_DIR
        self.inbox_dir = os.path.join(self.dir, "inbox", self.name)
        self.events_dir = os.path.join(self.dir, "events")
        self.state_dir = os.path.join(self.dir, "state")
        self.done_dir = os.path.join(self.dir, "_done", self.name)
        for d in (self.inbox_dir, self.events_dir, self.state_dir, self.done_dir):
            os.makedirs(d, exist_ok=True)
        self._events_marker = os.path.join(self.state_dir, f"_evtseen__{self.name}.json")

    # ==================== ส่ง ====================
    def send(self, to: str, mtype: str, subject: str = "", body=None,
             reply_to: str = None, expires_minutes: int = None) -> str:
        """ส่งจดหมายเข้าตู้ของ <to> - คืน id ของจดหมาย"""
        to = norm_name(to)
        if mtype not in VALID_TYPES:
            raise ValueError(f"type ต้องเป็นหนึ่งใน {VALID_TYPES}")
        mid = _now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        exp = _now() + timedelta(minutes=expires_minutes
                                 if expires_minutes is not None else DEFAULT_EXPIRE_MINUTES)
        msg = {
            "id": mid, "from": self.name, "to": to, "type": mtype,
            "subject": str(subject), "body": body, "reply_to": reply_to,
            "created_at": _iso(_now()), "expires_at": _iso(exp),
        }
        target_dir = os.path.join(self.dir, "inbox", to)
        os.makedirs(target_dir, exist_ok=True)
        _atomic_write_json(os.path.join(target_dir, f"{mid}.json"), msg)
        return mid

    def report(self, subject: str, body: str = "", expires_minutes: int = None) -> str:
        """รายงานให้ guardian เด้งเข้า Telegram (ทางลัดของ send('guardian','report',...))"""
        return self.send("guardian", "report", subject, body, expires_minutes=expires_minutes)

    def reply(self, msg: dict, body, subject: str = "") -> str:
        """ตอบกลับจดหมายที่ได้รับ - ส่งกลับหาคนส่งเดิม อ้าง id เดิม"""
        return self.send(msg.get("from", ""), "reply",
                         subject or ("re: " + str(msg.get("subject", ""))),
                         body, reply_to=msg.get("id"))

    def publish(self, topic: str, body, expires_minutes: int = None, notify: bool = False) -> str:
        """ประกาศลงกระดานกลาง - ใครสนใจก็มาอ่าน (ไม่เจาะจงผู้รับ)
        notify=True -> Guardian จะเด้งเข้า Telegram ให้ด้วย (เช่นสัญญาณสำคัญ)
        notify=False (ปกติ) -> เงียบ ให้โปรเจกต์อื่นมาอ่านไปใช้เอง ไม่กวน Telegram"""
        mid = _now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        exp = _now() + timedelta(minutes=expires_minutes
                                 if expires_minutes is not None else DEFAULT_EXPIRE_MINUTES)
        ev = {"id": mid, "from": self.name, "type": "event", "topic": str(topic),
              "body": body, "notify": bool(notify),
              "created_at": _iso(_now()), "expires_at": _iso(exp)}
        _atomic_write_json(os.path.join(self.events_dir, f"{mid}.json"), ev)
        return mid

    def peek_events(self, limit: int = 20, topic: str = None) -> list:
        """ดูประกาศล่าสุดบนกระดาน (ไม่แตะ marker = ดูกี่ครั้งก็เห็น) สำหรับคำสั่ง /events"""
        out, now = [], time.time()
        try:
            names = sorted(os.listdir(self.events_dir), reverse=True)
        except FileNotFoundError:
            return out
        for fn in names:
            if not fn.endswith(".json"):
                continue
            path = os.path.join(self.events_dir, fn)
            try:
                if now - os.path.getmtime(path) < MIN_AGE_SECONDS:
                    continue
            except OSError:
                continue
            ev = _read_json(path)
            if not ev or self._expired(ev):
                continue
            if topic and ev.get("topic") != topic:
                continue
            out.append(ev)
            if len(out) >= limit:
                break
        return out

    def sweep_events(self) -> None:
        """ลบไฟล์ประกาศที่หมดอายุแล้วบนกระดาน (เรียกเบาๆ เป็นระยะ)"""
        try:
            for fn in os.listdir(self.events_dir):
                if not fn.endswith(".json"):
                    continue
                path = os.path.join(self.events_dir, fn)
                ev = _read_json(path)
                if ev and self._expired(ev):
                    try:
                        os.remove(path)
                    except OSError:
                        pass
        except OSError:
            pass

    # ==================== รับ ====================
    def inbox(self, include_expired: bool = False, accept=None) -> list:
        """คืนจดหมายใหม่ในตู้ของฉัน (จองไว้แล้วด้วย .taken กันตัวอื่นหยิบซ้ำ)
        เรียงตามเวลาสร้าง - จดหมายหมดอายุจะถูกข้ามและเก็บกวาดทิ้ง
        accept = ฟังก์ชัน(msg)->bool ถ้าตั้งไว้ จะหยิบเฉพาะจดหมายที่ตอบ True
                 ที่เหลือ "ทิ้งไว้ในตู้" ให้คนอื่นหยิบ (เช่น Guardian หยิบแค่ ping/status
                 ส่วนจดหมายถามงานปล่อยไว้ให้ AI ของโปรเจกต์นั้นอ่านตอนเปิดแชท)"""
        out = []
        now = time.time()
        try:
            names = sorted(os.listdir(self.inbox_dir))
        except FileNotFoundError:
            return out
        for fn in names:
            if not fn.endswith(".json"):
                continue
            path = os.path.join(self.inbox_dir, fn)
            try:
                if now - os.path.getmtime(path) < MIN_AGE_SECONDS:
                    continue                      # อาจยังเขียนไม่เสร็จ รอรอบหน้า
            except OSError:
                continue
            msg = _read_json(path)
            if not msg:
                continue
            if not include_expired and self._expired(msg):
                self._move_done(path, msg)         # หมดอายุ = เก็บกวาดทิ้งเลย
                continue
            if accept is not None:
                try:
                    if not accept(msg):
                        continue                  # ไม่ใช่ของเรา ทิ้งไว้ในตู้
                except Exception:
                    continue
            # จอง: rename เป็น .taken - ถ้าสำเร็จแปลว่าเราได้จดหมายนี้ (กันหยิบซ้ำ)
            taken = path + ".taken"
            try:
                os.replace(path, taken)
            except OSError:
                continue                          # ตัวอื่นชิงไปก่อน ข้าม
            msg["_path"] = taken
            out.append(msg)
        return out

    def ack(self, msg: dict) -> None:
        """อ่านจดหมายเสร็จแล้ว -> ย้ายเข้า _done"""
        path = msg.get("_path")
        if path and os.path.exists(path):
            self._move_done(path, msg)

    def events(self, topic: str = None) -> list:
        """อ่านประกาศใหม่จากกระดาน (จำเองว่าอ่านถึงไหนแล้ว หลายคนอ่านใบเดียวกันได้)"""
        seen = _read_json(self._events_marker) or {}
        seen_ids = set(seen.get("ids", []))
        out, now = [], time.time()
        try:
            names = sorted(os.listdir(self.events_dir))
        except FileNotFoundError:
            return out
        fresh_ids = []
        for fn in names:
            if not fn.endswith(".json"):
                continue
            path = os.path.join(self.events_dir, fn)
            try:
                if now - os.path.getmtime(path) < MIN_AGE_SECONDS:
                    continue
            except OSError:
                continue
            ev = _read_json(path)
            if not ev:
                continue
            if self._expired(ev):
                continue
            fresh_ids.append(ev["id"])
            if ev["id"] in seen_ids:
                continue
            if topic and ev.get("topic") != topic:
                continue
            out.append(ev)
        # จำว่าอ่านถึงไหนแล้ว (เก็บเฉพาะ id ที่ยังไม่หมดอายุ กันไฟล์โต)
        merged = list(seen_ids | set(e["id"] for e in out))
        keep = [i for i in merged if i in set(fresh_ids)]
        _atomic_write_json(self._events_marker, {"ids": keep})
        return out

    # ==================== ป้ายสถานะ / ชีพจร ====================
    def heartbeat(self, status: str = "running", detail: str = "",
                  expect_every_minutes: int = 5, extra: dict = None) -> None:
        """เขียนป้ายสถานะของฉัน - ใครถามก็เปิดอ่านไฟล์นี้ตอบได้ทันที
        expect_every_minutes: guardian ใช้เช็คชีพจร (0 = ไม่ต้องเช็ค เช่นงานรันเป็นรอบ)"""
        card = {
            "project": self.name, "status": str(status), "detail": str(detail),
            "expect_every_minutes": int(expect_every_minutes),
            "updated_at": _iso(_now()),
        }
        if status not in ("running",):
            card["last_state_change"] = _iso(_now())
        if extra:
            card.update(extra)
        _atomic_write_json(os.path.join(self.state_dir, f"{self.name}.json"), card)

    def get_status(self, project: str) -> dict:
        """อ่านป้ายสถานะของโปรเจกต์อื่น (dict ว่างถ้าไม่มี)"""
        card = _read_json(os.path.join(self.state_dir, f"{norm_name(project)}.json"))
        return card or {}

    def all_status(self) -> list:
        """อ่านป้ายสถานะทุกโปรเจกต์ + คำนวณว่าใครชีพจรหาย (สำหรับ /bus ใน Guardian)"""
        out = []
        try:
            names = sorted(os.listdir(self.state_dir))
        except FileNotFoundError:
            return out
        now = _now()
        for fn in names:
            if not fn.endswith(".json") or fn.startswith("_"):
                continue
            card = _read_json(os.path.join(self.state_dir, fn))
            if not card:
                continue
            card["_stale"] = self._is_stale(card, now)
            out.append(card)
        return out

    # ==================== ถามแล้วรอคำตอบ ====================
    def ask(self, target: str, question: str, timeout: int = 60, body=None):
        """ส่ง ask แล้วรอ reply กลับมาในตู้เรา - คืน dict ของ reply หรือ None ถ้าไม่ตอบทัน"""
        qid = self.send(target, "ask", question, body, expires_minutes=max(1, timeout // 60 + 1))
        deadline = time.time() + timeout
        while time.time() < deadline:
            for msg in self.inbox():
                if msg.get("type") == "reply" and msg.get("reply_to") == qid:
                    self.ack(msg)
                    return msg
                else:
                    # ไม่ใช่คำตอบที่รอ - ปล่อยคืน (rename กลับ) ให้รอบงานจริงหยิบไปเอง
                    self._unclaim(msg)
            time.sleep(ASK_POLL_SECONDS)
        return None

    # ==================== ภายใน ====================
    def _expired(self, msg: dict) -> bool:
        exp = msg.get("expires_at")
        if not exp:
            return False
        try:
            return _now() > datetime.strptime(exp, "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return False

    def _is_stale(self, card: dict, now: datetime) -> bool:
        every = int(card.get("expect_every_minutes", 0) or 0)
        if every <= 0:
            return False                          # งานรันเป็นรอบ ไม่เช็คชีพจร
        try:
            upd = datetime.strptime(card.get("updated_at", ""), "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return False
        return (now - upd) > timedelta(minutes=every * 2 + 1)  # ขาดเกิน 2 รอบ = ตาย

    def _move_done(self, path: str, msg: dict) -> None:
        try:
            os.makedirs(self.done_dir, exist_ok=True)
            base = os.path.basename(path).replace(".taken", "")
            os.replace(path, os.path.join(self.done_dir, base))
        except OSError:
            try:
                os.remove(path)
            except OSError:
                pass
        self._sweep_done()

    def _unclaim(self, msg: dict) -> None:
        """คืนจดหมายที่จองไว้ (เอา .taken ออก) - ใช้ตอน ask เจอจดหมายอื่นที่ไม่ใช่คำตอบ"""
        path = msg.get("_path")
        if path and path.endswith(".taken") and os.path.exists(path):
            try:
                os.replace(path, path[:-len(".taken")])
            except OSError:
                pass

    def _sweep_done(self) -> None:
        """ลบจดหมายใน _done ที่เก่าเกิน DONE_KEEP_DAYS (เรียกเบาๆ ตอน ack)"""
        cutoff = time.time() - DONE_KEEP_DAYS * 86400
        try:
            for fn in os.listdir(self.done_dir):
                p = os.path.join(self.done_dir, fn)
                try:
                    if os.path.getmtime(p) < cutoff:
                        os.remove(p)
                except OSError:
                    pass
        except OSError:
            pass
