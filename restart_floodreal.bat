@echo off
chcp 65001 >nul
cd /d "%~dp0"
call stop_floodreal.bat
echo กำลังเปิด Flood real แบบเบื้องหลัง (ไม่มีหน้าต่าง)...
start "" pyw -3.13 floodreal_server.py
timeout /t 5 /nobreak >nul
echo เสร็จแล้ว เปิดดูได้ที่ http://127.0.0.1:5095 (log: data\server.log.console)
timeout /t 5 >nul
