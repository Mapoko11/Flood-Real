# Flood real (systemL) — เฝ้าดูน้ำท่วมทั้งประเทศไทย

## ติดตั้ง (ครั้งเดียว)
    py -3.13 -m pip install -r requirements.txt

## เริ่มใช้
    py -3.13 app.py        แล้วเปิด http://127.0.0.1:5095

## แหล่งข้อมูล
| แหล่ง | ข้อมูล | key |
|---|---|---|
| ThaiWater (สสน.) | ระดับน้ำ, ฝน 24 ชม., เขื่อน, แผนที่คาดการณ์ฝน | ไม่ต้อง |
| GISTDA | พื้นที่น้ำท่วมจากดาวเทียม | GISTDA_API_KEY (สมัครฟรี api-gateway.gistda.or.th) |
| กรมอุตุฯ | ประกาศเตือนภัย | TMD_UID / TMD_UKEY (data.tmd.go.th) |

ใส่ key/เปลี่ยนค่าได้โดยสร้าง `config_local.json` (ดูตัวอย่าง `config_local.example.json`)

## แจ้งเตือน
ส่งเข้า Guardian -> Telegram ผ่าน `D:\Project\_bus` ชื่อ `floodreal`
- น้ำ >= 100% ตลิ่ง / ฝน 24 ชม. >= 90 มม. / เขื่อน >= 100% (สถานีเดิมเตือนซ้ำทุก 6 ชม.)
- รับคำสั่งทาง bus: `run_now` (ดึงใหม่ทันที), `status` (สรุปสถานการณ์)

## ไฟล์
- app.py เว็บ + worker   - sources.py ดึง/แปลงข้อมูล   - alerts.py เกณฑ์เตือน + bus
- data/latest.json cache ล่าสุด (สร้างเอง)   - static/leaflet แผนที่แบบ offline (ไม่พึ่ง CDN)

## ให้เครื่องอื่นเข้าดู (LAN)
1. `config_local.json` ตั้ง `"HOST": "0.0.0.0"`
2. เปิด Firewall (cmd แบบ Administrator ครั้งเดียว):
   `netsh advfirewall firewall add rule name="Flood real 5095" dir=in action=allow protocol=TCP localport=5095 profile=domain,private`
3. เปิด run.bat -> หน้าต่างจะบอก URL "เครื่องอื่น: http://<IP>:5095"
4. นอกบ้าน/มือถือ: ใช้ Tailscale (ไม่ต้องเปิดพอร์ตออกเน็ต)
