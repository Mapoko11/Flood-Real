@echo off
chcp 65001 >nul
cd /d "%~dp0"
py -3.13 -m pip install -q -r requirements.txt
start "" /min cmd /c "timeout /t 5 /nobreak >nul & start "" http://127.0.0.1:5095"
py -3.13 floodreal_server.py
pause
