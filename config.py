"""
config.py - ค่าตั้งของ Flood real (systemL)
แก้ค่าในไฟล์นี้ หรือสร้าง config_local.json วางข้างๆ เพื่อทับค่า (ไม่ต้องแก้โค้ด)
"""
from __future__ import annotations

import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULTS = {
    # ---- เว็บ ----
    "HOST": "127.0.0.1",          # เปลี่ยนเป็น "0.0.0.0" ถ้าจะให้เครื่องอื่นใน LAN เข้า
    "PORT": 5095,

    # ---- รอบดึงข้อมูล (นาที) ----
    "FETCH_EVERY_MINUTES": 15,
    "HTTP_TIMEOUT": 25,

    # ---- แหล่งข้อมูล ThaiWater (สสน.) — ไม่ต้องใช้ key ----
    "THAIWATER_BASE": "https://api-v3.thaiwater.net/api/v1/thaiwater30/public",

    # ---- GISTDA พื้นที่น้ำท่วมจากดาวเทียม (ต้องสมัคร API key ฟรีที่ api-gateway.gistda.or.th) ----
    "GISTDA_API_KEY": "",
    "GISTDA_FLOOD_URL": "https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/1day",

    # ---- กรมอุตุฯ ประกาศเตือนภัย (สมัคร uid/ukey ที่ data.tmd.go.th) ----
    "TMD_UID": "",
    "TMD_UKEY": "",
    "TMD_WARNING_URL": "https://data.tmd.go.th/api/WeatherWarningNews/v1/",
    "TMD_PUBLIC_XML": "https://tmd.go.th/api/xml/warning-news",   # ใช้เมื่อไม่มี uid/ukey

    # ---- Traffy Fondue (กทม./ปริมณฑล) เรื่องแจ้งน้ำท่วมขัง — ไม่ต้องใช้ key ----
    "TRAFFY_ENABLED": True,
    "TRAFFY_URL": "https://publicapi.traffy.in.th/teamchadchart-stat-api/geojson/v1",
    "TRAFFY_HOURS": 72,            # ย้อนหลังกี่ชั่วโมง

    # ---- กทม. จุดวัดน้ำท่วมถนน (สำนักการระบายน้ำ) — ไม่ต้องใช้ key ----
    "BMA_FLOOD_ENABLED": True,
    "BMA_FLOOD_URL": "https://weather.bangkok.go.th/Flood/PageMap/GetData?id=0",
    # ดึงผ่าน Cloudflare Worker ก่อน (ใช้ IP คนละชุด + cache 10 นาที) ถ้าไม่ได้ค่อยดึงตรง  ใส่ "" = ดึงตรงอย่างเดียว
    "BMA_PROXY_URL": "https://floodreal-proxy.cheabracha0920.workers.dev/bma",

    # ---- TomTom Traffic (รถติด) — สมัคร key ฟรีที่ developer.tomtom.com ----
    "TOMTOM_API_KEY": "",
    "TRAFFIC_CACHE_MINUTES": 5,    # ถนนเดิมค้นซ้ำภายในกี่นาทีใช้ผลเดิม (ประหยัดโควตา 2,500/เดือน)

    # ---- เกณฑ์แจ้งเตือน ----
    "ALERT_ENABLED": True,
    "ALERT_WL_PERCENT": 100,       # ระดับน้ำ >= % ความจุลำน้ำ (100 = ล้นตลิ่ง)
    "ALERT_RAIN_MM": 90,           # ฝน 24 ชม. >= mm (กรมอุตุฯ: >90 = หนักมาก)
    "ALERT_DAM_PERCENT": 100,      # เขื่อน >= % ความจุ
    "ALERT_ROAD_CM": 30,           # ถนน กทม. น้ำท่วม >= ซม. (30 ซม. = รถเก๋งเริ่มลำบาก)
    "ALERT_REPEAT_HOURS": 12,      # สถานีเดิมเตือนซ้ำได้อีกเมื่อผ่านไปกี่ ชม.
    "ALERT_MAX_ITEMS": 15,         # รายการสูงสุดต่อ 1 ข้อความ (กัน Telegram ยาวเกิน)
    "ALERT_KINDS": ["wl", "dam", "road"],   # เตือนด่วนเฉพาะ: wl=น้ำล้นตลิ่ง, dam=เขื่อนเกินความจุ, road=ถนน กทม. ท่วม >= ALERT_ROAD_CM (ฝนหนักดูในสรุปทุก 4 ชม.) ใส่ "rain" เพื่อเตือนฝนด้วย
    "ALERT_MIN_GAP_MINUTES": 60,    # เตือนด่วนห่างกันอย่างน้อยกี่นาที (จุดใหม่ระหว่างนั้นจะรวมไปส่งรอบถัดไป)

    # ---- สรุปสถานการณ์ส่งเข้า Guardian/Telegram ตามเวลา (ทุก 4 ชม.) ----
    "SUMMARY_ENABLED": True,
    "SUMMARY_HOURS": [2, 6, 10, 14, 18, 22],   # ชั่วโมงที่ส่ง (เวลาไทย) ลบชั่วโมงที่ไม่อยากให้เด้งออกได้

    # ---- ตู้จดหมายกลาง (_bus) ----
    "BUS_NAME": "floodreal",
    "BUS_TO": "guardian",
}


def _load() -> dict:
    cfg = dict(DEFAULTS)
    path = os.path.join(BASE_DIR, "config_local.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                user = json.load(f)
            if isinstance(user, dict):
                cfg.update({k: v for k, v in user.items() if k in DEFAULTS})
        except (OSError, ValueError) as e:
            print(f"[config] อ่าน config_local.json ไม่ได้ ใช้ค่าเริ่มต้นแทน: {e}")
    return cfg


CFG = _load()
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
