@echo off
REM Register Flood real to start at Windows logon. Run as administrator.
cd /d "%~dp0"

schtasks /create /tn "Flood real" /tr "wscript.exe \"%~dp0start_floodreal_hidden.vbs\"" /sc onlogon /rl highest /f

echo.
if %errorlevel%==0 (
  echo [OK] Registered. Flood real will start automatically at logon.
  echo      To start now: schtasks /run /tn "Flood real"
) else (
  echo [ERROR] Failed - please Run as administrator.
)
echo.
echo To remove autostart: schtasks /delete /tn "Flood real" /f
echo.
pause
