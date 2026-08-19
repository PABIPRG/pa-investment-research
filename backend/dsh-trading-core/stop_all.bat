@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  dsh-trading-core stop script (Windows)
rem   - find and kill listeners on ports 8000 / 3080
rem ============================================================
echo Stopping dsh-trading-core services...
set "killed=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1 && echo   [OK] stopped :8000 pid %%p && set "killed=1"
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3080 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1 && echo   [OK] stopped :3080 pid %%p && set "killed=1"
)
if "!killed!"=="0" echo   [INFO] no listeners on :8000 / :3080
echo Done.
endlocal
