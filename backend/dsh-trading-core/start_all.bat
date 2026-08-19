@echo off
chcp 65001 >nul
rem ============================================================
rem dsh-trading-core × DeepSeek Harness 一键启动
rem   1. 分析适配器 (FastAPI, engine 模式, :8000)
rem   2. dsh Web UI (:3080, 已加载 dsh-trading-core 插件)
rem   3. 打开浏览器
rem ============================================================

setlocal
set ROOT=%~dp0
set PATCH=%~dp0dsh-plugin\cordis.yml

echo [1/2] 检查/启动分析适配器 (:8000, engine 模式)...
curl -s http://127.0.0.1:8000/health >nul 2>&1
if not errorlevel 1 (
  echo   [OK] 适配器已在运行
  goto :adapter_ok
)
echo   启动适配器 ...
start "dsh-trading-core-adapter" /min cmd /c "cd /d %ROOT% && set ADAPTER_RUNNER=engine&& set PYTHONIOENCODING=utf-8&& set PYTHONUTF8=1&& env\Scripts\python.exe -m uvicorn adapter.app:app --host 127.0.0.1 --port 8000 --log-level warning"
echo   等待适配器就绪 ...
:wait_adapter
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:8000/health >nul 2>&1
if errorlevel 1 goto wait_adapter
echo   [OK] 适配器就绪: engine = tradingagents-cn
:adapter_ok

echo [2/2] 检查/启动 dsh Web UI (:3080)...
netstat -ano | findstr ":3080" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   [OK] dsh Web UI 已在运行
  goto :web_ok
)
echo   启动 dsh web ...
start "dsh-WebUI" cmd /k "dsh web --patch %PATCH%"
echo   等待 Web UI 就绪 ...
:wait_web
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":3080" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto wait_web
echo   [OK] dsh Web UI 就绪
:web_ok

echo.
echo 全部就绪！
echo   - dsh 对话页 : http://127.0.0.1:3080   (Settings - Models 填 DeepSeek API Key)
echo   - 适配器状态 : http://127.0.0.1:8000/health
echo.
echo 浏览器即将打开 dsh 页面；如已配置过 Key，直接对话说「分析一下 600519」。
start "" http://127.0.0.1:3080
endlocal
