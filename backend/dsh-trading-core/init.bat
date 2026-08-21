@echo off
setlocal
rem Initialize only the Python backend environment.
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "PYCMD="
where py >nul 2>&1
if not errorlevel 1 set "PYCMD=py -3"
if not defined PYCMD (
    where python >nul 2>&1
    if not errorlevel 1 set "PYCMD=python"
)
if not defined PYCMD (
    echo [ERROR] Python 3.10 or newer is required.
    exit /b 1
)
%PYCMD% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python 3.10 or newer is required.
    exit /b 1
)

if not exist "env\Scripts\python.exe" (
    echo [1/3] Creating Python virtual environment...
    %PYCMD% -m venv env
    if errorlevel 1 exit /b 1
) else (
    echo [1/3] Python virtual environment already exists
)

echo [2/3] Installing Python requirements...
env\Scripts\python.exe -m pip install --upgrade pip -q
if errorlevel 1 exit /b 1
if /i "%~1"=="mirror" (
    env\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
) else (
    env\Scripts\python.exe -m pip install -r requirements.txt
)
if errorlevel 1 exit /b 1

echo [3/3] Verifying Python imports...
env\Scripts\python.exe -c "import fastapi, uvicorn; from adapter.app import app; print('Python imports OK')"
if errorlevel 1 exit /b 1

echo Initialization complete. Configure .env if engine mode needs credentials.
endlocal
