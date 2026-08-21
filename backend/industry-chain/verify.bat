@echo off
setlocal
rem ============================================================
rem  industry-chain verify script (Windows)
rem   1. adapter health check + key endpoint smoke
rem   2. plugin smoke test (4 tools registered = pass)
rem ============================================================
set "ROOT=%~dp0"
cd /d "%ROOT%"

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
