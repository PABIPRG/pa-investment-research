@echo off
setlocal
rem ============================================================
rem  industry-chain verify script (Windows)
rem   1. adapter health check + read-only data status
rem   2. plugin smoke test (4 tools registered = pass)
rem ============================================================
set "ROOT=%~dp0"
cd /d "%ROOT%"

if /i "%~1"=="--environment" (
    if not exist "env\Scripts\python.exe" (
        echo [ERROR] Python virtual environment missing. Run init.bat first.
        exit /b 1
    )
    env\Scripts\python.exe -c "from industry_chain.app import app; print('industry-chain Python imports OK')"
    if errorlevel 1 exit /b 1
    exit /b 0
)

echo == industry-chain verify ==
echo.
echo [1/2] adapter health check ...
curl -s http://127.0.0.1:8200/health
if errorlevel 1 (
    echo.
    echo   [ERROR] adapter not running. Start with start_all.bat
    exit /b 1
)
echo.
echo   /data/status response (does not download data):
curl -s http://127.0.0.1:8200/data/status
if errorlevel 1 exit /b 1
echo.
echo [2/2] plugin smoke test ...
if exist "dsh-plugin\package.json" (
    pushd dsh-plugin
    call npx tsx test/plugin-load.smoke.ts
    if errorlevel 1 echo   [WARN] plugin smoke test failed
    popd
) else (
    echo   dsh-plugin not found, skip
)
echo.
echo == verify done ==
endlocal
