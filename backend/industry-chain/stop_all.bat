@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  industry-chain stop script (Windows)
rem   - find and kill listeners on ports 8200 / 3082
rem ============================================================
echo Stopping industry-chain services...
set "killed=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8200 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1 && echo   [OK] stopped :8200 pid %%p && set "killed=1"
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3082 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1 && echo   [OK] stopped :3082 pid %%p && set "killed=1"
)
if "!killed!"=="0" echo   [INFO] no listeners on :8200 / :3082
echo Done.
endlocal
