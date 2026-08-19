@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  market-watch one-click start (Windows)
rem   Service 1: FastAPI adapter :8100 (watch agent)
rem   Service 2: dsh Web UI     :3081 (with 11-tool plugin)
rem   - Running services are detected and skipped (no duplicates)
rem ============================================================
set "ROOT=%~dp0"
cd /d "%ROOT%"
set "PATCH=%ROOT%dsh-plugin\cordis.yml"
set "DSH_RUN=%TEMP%\dsh-run-mw"
set "LOGS=%ROOT%logs"
if not exist "%LOGS%" mkdir "%LOGS%" 2>nul
if not exist "%DSH_RUN%" mkdir "%DSH_RUN%" 2>nul

echo ================================================================
echo   market-watch start
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

rem ---------- 1. adapter ----------
curl -s http://127.0.0.1:8100/health >nul 2>&1
if not errorlevel 1 (
    echo [OK] adapter already running - :8100
) else (
    echo [1/2] Starting adapter - :8100...
    start "market-watch-adapter" /min cmd /c "cd /d ""%ROOT%"" && set PYTHONIOENCODING=utf-8&& set PYTHONUTF8=1&& env\Scripts\python.exe -m uvicorn market_watch.app:app --host 127.0.0.1 --port 8100 --log-level warning > ""%LOGS%\adapter.log"" 2>&1"
    call :wait_port 8100 "adapter"
    if errorlevel 1 exit /b 1
)

rem ---------- 2. dsh Web UI ----------
netstat -ano | findstr ":3081 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [NOTE] :3081 already in use. Run stop_all.bat first if needed.
) else (
    echo [2/2] Starting dsh Web UI - :3081, plugin loaded...
    start "dsh-WebUI" /min cmd /c "cd /d ""%DSH_RUN%"" && npx @deepseek-ai/dsh web --patch ""%PATCH%"" --port 3081 > ""%LOGS%\dsh.log"" 2>&1"
    call :wait_port 3081 "dsh Web UI"
    if errorlevel 1 exit /b 1
)

echo.
echo All ready!
echo   - dsh UI   : http://127.0.0.1:3081   (fill DeepSeek API Key in Settings-Models)
echo   - adapter  : http://127.0.0.1:8100/health
echo   - logs     : %LOGS%\adapter.log / dsh.log
echo   - stop     : stop_all.bat
start "" "http://127.0.0.1:3081"
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
