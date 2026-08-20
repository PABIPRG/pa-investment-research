@echo off
setlocal enabledelayedexpansion
rem Start only the Python market-watch API.
set "ROOT=%~dp0"
cd /d "%ROOT%"
set "LOGS=%ROOT%logs"
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul

if not exist "env\Scripts\python.exe" (
    echo [ERROR] Python virtual environment missing. Run init.bat first.
    exit /b 1
)

curl -s http://127.0.0.1:8100/health >nul 2>&1
if not errorlevel 1 (
    echo [OK] market-watch API already running on :8100
    exit /b 0
)

echo Starting market-watch API on :8100 ...
start "market-watch-api" /min cmd /c "cd /d ""%ROOT%"" && set PYTHONIOENCODING=utf-8&& set PYTHONUTF8=1&& env\Scripts\python.exe -m uvicorn market_watch.app:app --host 127.0.0.1 --port 8100 --log-level warning > ""%LOGS%\adapter.log"" 2>&1"
call :wait_port 8100
exit /b %errorlevel%

:wait_port
set /a tries=0
:wait_loop
set /a tries+=1
if !tries! gtr 120 (
    echo [ERROR] market-watch API startup timed out. See %LOGS%\adapter.log
    exit /b 1
)
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:8100/health >nul 2>&1
if errorlevel 1 goto wait_loop
echo [OK] market-watch API ready on :8100
exit /b 0
