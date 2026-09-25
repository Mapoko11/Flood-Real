@echo off
chcp 65001 >nul
echo กำลังปิด Flood real ที่รันเบื้องหลัง...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*floodreal_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('ปิด PID ' + $_.ProcessId) }"
timeout /t 2 /nobreak >nul
