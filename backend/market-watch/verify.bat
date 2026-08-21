@echo off
setlocal
rem Verify the Python health contract and imports only.
set "ROOT=%~dp0"
cd /d "%ROOT%"

env\Scripts\python.exe -m unittest tests\test_health_contract.py
if errorlevel 1 exit /b 1
env\Scripts\python.exe -c "import fastapi, uvicorn; from market_watch.app import app; print('Python imports OK')"
if errorlevel 1 exit /b 1
endlocal
