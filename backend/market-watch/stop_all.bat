@echo off
setlocal enabledelayedexpansion
rem Manual Python-backend wrapper only; Phase 2 Runtime owns its own child handles.
set "killed=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8100 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1 && echo [OK] stopped :8100 pid %%p && set "killed=1"
)
if "!killed!"=="0" echo [INFO] no listener on :8100
endlocal
