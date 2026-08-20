@echo off
setlocal enabledelayedexpansion
rem Start only the Python trading-core API. ADAPTER_RUNNER may be fake or engine.
set "ROOT=%~dp0"
cd /d "%ROOT%"
set "LOGS=%ROOT%logs"
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul

if not exist "env\Scripts\python.exe" (
    echo [ERROR] Python virtual environment missing. Run init.bat first.
    exit /b 1
)

set "RUNNER=%ADAPTER_RUNNER%"
if not defined RUNNER set "RUNNER=engine"
if not "%~1"=="" set "RUNNER=%~1"
if /i not "%RUNNER%"=="fake" if /i not "%RUNNER%"=="engine" (
    echo [ERROR] ADAPTER_RUNNER must be fake or engine.
    exit /b 1
)

curl -fsS http://127.0.0.1:8000/health >nul 2>&1
if not errorlevel 1 (
    echo [OK] trading-core API already running on :8000
    exit /b 0
)

echo Starting trading-core API on :8000 ^(ADAPTER_RUNNER=%RUNNER%^) ...
start "trading-core-api" /min cmd /c "cd /d ""%ROOT%"" && set ADAPTER_RUNNER=%RUNNER%&& set PYTHONIOENCODING=utf-8&& set PYTHONUTF8=1&& env\Scripts\python.exe -m uvicorn adapter.app:app --host 127.0.0.1 --port 8000 --log-level warning > ""%LOGS%\adapter.log"" 2>&1"
call :wait_port 8000
exit /b %errorlevel%

:wait_port
set /a tries=0
:wait_loop
set /a tries+=1
if !tries! gtr 120 (
    echo [ERROR] trading-core API startup timed out. See %LOGS%\adapter.log
    exit /b 1
)
timeout /t 1 /nobreak >nul
curl -fsS http://127.0.0.1:8000/health >nul 2>&1
if errorlevel 1 goto wait_loop
echo [OK] trading-core API ready on :8000
exit /b 0
