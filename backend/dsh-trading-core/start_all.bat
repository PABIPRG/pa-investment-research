@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  dsh-trading-core one-click start (Windows)
rem   Service 1: FastAPI adapter :8000 (default engine mode)
rem   Service 2: dsh Web UI     :3080 (with 9-tool plugin)
rem   - Running services are detected and skipped (no duplicates)
rem   - Pass "fake" to run adapter in fake-task mode (联调)
rem Usage: start_all.bat [fake]
rem ============================================================
set "ROOT=%~dp0"
cd /d "%ROOT%"
set "PATCH=%ROOT%dsh-plugin\cordis.yml"
set "DSH_RUN=%TEMP%\dsh-run-pa"
set "LOGS=%ROOT%logs"
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul
if not exist "%DSH_RUN%" mkdir "%DSH_RUN%" 2>nul

echo ================================================================
echo   dsh-trading-core start
echo ================================================================
echo.

rem ---------- prechecks ----------
if not exist "env\Scripts\python.exe" (
    echo [ERROR] venv "env" not found. Run init.bat first.
    exit /b 1
)
if not exist ".env" (
    echo [WARN] .env not found. Run init.bat first.
)

set "RUNNER=engine"
if /i "%~1"=="fake" set "RUNNER=fake"

rem ---------- 1. adapter ----------
curl -s http://127.0.0.1:8000/health >nul 2>&1
if not errorlevel 1 (
    echo [OK] adapter already running - :8000
) else (
    echo [1/2] Starting adapter - :8000, %RUNNER% mode...
    start "dsh-trading-core-adapter" /min cmd /c "cd /d ""%ROOT%"" && set ADAPTER_RUNNER=%RUNNER%&& set PYTHONIOENCODING=utf-8&& set PYTHONUTF8=1&& env\Scripts\python.exe -m uvicorn adapter.app:app --host 127.0.0.1 --port 8000 --log-level warning > ""%LOGS%\adapter.log"" 2>&1"
    call :wait_port 8000 "adapter"
    if errorlevel 1 exit /b 1
)

rem ---------- 2. dsh Web UI ----------
netstat -ano | findstr ":3080 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [NOTE] :3080 already in use - maybe the old project. Not starting a new dsh.
    echo        If you need this project's dsh, run stop_all.bat first.
) else (
    echo [2/2] Starting dsh Web UI - :3080, plugin loaded...
    start "dsh-WebUI" /min cmd /c "cd /d ""%DSH_RUN%"" && npx @deepseek-ai/dsh web --patch ""%PATCH%"" > ""%LOGS%\dsh.log"" 2>&1"
    call :wait_port 3080 "dsh Web UI"
    if errorlevel 1 exit /b 1
)

echo.
echo All ready!
echo   - dsh UI   : http://127.0.0.1:3080   (fill DeepSeek API Key in Settings-Models)
echo   - adapter  : http://127.0.0.1:8000/health
echo   - logs     : %LOGS%\adapter.log / dsh.log
echo   - stop     : stop_all.bat
start "" "http://127.0.0.1:3080"
goto :eof

rem ---------- wait until a port is listening ----------
:wait_port
set /a tries=0
:wait_loop
set /a tries+=1
if !tries! gtr 120 (
    echo   [ERROR] %2 timeout on %1. See %LOGS%\adapter.log / %LOGS%\dsh.log
    exit /b 1
)
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":%1 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto wait_loop
echo   [OK] %2 ready (%1)
exit /b 0
endlocal
