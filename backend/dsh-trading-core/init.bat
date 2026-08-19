@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  dsh-trading-core init script (Windows)
rem   1. Locate Python 3.10+ and create venv
rem   2. Install Python deps  (pass "mirror" to use Tsinghua mirror)
rem   3. Generate .env from .env.example
rem   4. Install dsh-plugin npm deps + verify key imports
rem Usage: init.bat [mirror]
rem ============================================================
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo ================================================================
echo   dsh-trading-core init
echo ================================================================
echo.

rem ---------- 1. locate Python (>=3.10) ----------
rem NOTE: do not capture the interpreter full path into a variable -
rem a Chinese-username path captured via for /f gets mangled. Invoke
rem py/python by command name and let cmd resolve it internally.
set "PYCMD="
where py >nul 2>&1
if not errorlevel 1 (
    set "PYCMD=py -3"
) else (
    where python >nul 2>&1
    if not errorlevel 1 set "PYCMD=python"
)
if not defined PYCMD (
    echo [ERROR] Python not found. Install Python 3.10+ and check "Add to PATH".
    exit /b 1
)
%PYCMD% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python >= 3.10 required. Current "%PYCMD%" is too old.
    %PYCMD% --version
    exit /b 1
)
echo [OK] Python: %PYCMD%

rem ---------- 2. create venv ----------
if not exist "env\Scripts\python.exe" (
    echo [1/4] Creating venv "env" ...
    %PYCMD% -m venv env
    if errorlevel 1 exit /b 1
) else (
    echo [1/4] venv already exists, skip
)

rem ---------- 3. install Python deps ----------
echo [2/4] Installing Python deps (first run may take minutes)...
env\Scripts\python.exe -m pip install --upgrade pip -q
if /i "%~1"=="mirror" (
    env\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
) else (
    env\Scripts\python.exe -m pip install -r requirements.txt
)
if errorlevel 1 (
    echo [ERROR] pip install failed
    exit /b 1
)

rem ---------- 4. generate .env ----------
echo [3/4] Checking .env ...
if not exist ".env" (
    copy /y ".env.example" ".env" >nul
    echo   [TIP] Created .env from .env.example. Edit it and fill DEEPSEEK_API_KEY.
) else (
    echo   .env already exists, skip
)
findstr /b /c:"DEEPSEEK_API_KEY=" ".env" >nul 2>&1
if errorlevel 1 (
    echo   [WARN] DEEPSEEK_API_KEY line not found in .env
)

rem ---------- 5. dsh-plugin npm deps (optional) ----------
echo [4/4] Installing dsh-plugin npm deps (optional)...
if exist "dsh-plugin\package.json" (
    pushd dsh-plugin
    call npm install >nul 2>&1
    if errorlevel 1 echo   [WARN] npm install failed - plugin smoke test may fail, adapter unaffected
    popd
) else (
    echo   dsh-plugin not found, skip
)

rem ---------- 6. verify key imports ----------
echo [VERIFY] Checking key imports ...
env\Scripts\python.exe -c "import fastapi, uvicorn, akshare, langgraph, chromadb, sse_starlette; print('  imports OK')"
if errorlevel 1 (
    echo [ERROR] key imports failed
    exit /b 1
)

echo.
echo ================================================================
echo   Init done!
echo     - Start: start_all.bat
echo     - Stop : stop_all.bat
echo     - Check: verify.bat
echo   Make sure DEEPSEEK_API_KEY is set in .env
echo ================================================================
endlocal
