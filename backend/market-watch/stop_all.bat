@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  market-watch stop script (Windows)
rem   - find and kill listeners on ports 8100 / 3081
rem ============================================================
echo Stopping market-watch services...
set "killed=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8100 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1 && echo   [OK] stopped :8100 pid %%p && set "killed=1"
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3081 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1 && echo   [OK] stopped :3081 pid %%p && set "killed=1"
)
if "!killed!"=="0" echo   [INFO] no listeners on :8100 / :3081
echo Done.
endlocal
