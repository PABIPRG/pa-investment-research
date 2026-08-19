@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  dsh-trading-core install script (Windows)
rem    One-time setup: Python -> venv -> pip deps -> .env -> dsh-plugin -> verify
rem    Semantically identical to install.sh on macOS/Linux.
rem
rem  Usage:
rem    install.bat                  Full install with default PyPI
rem    install.bat mirror           Full install with Tsinghua mirror (CN users)
rem    install.bat check            Environment check only, no changes
rem    install.bat mirror check     Check + show mirror that would be used
rem
rem  CRITICAL COMPAT NOTE for cmd.exe:
rem    * Keep this file UTF-8 with BOM (EF BB BF).
rem    * NEVER put unescaped `(` or `)` in an `echo` line that lives inside a
rem      compound `if (...) else (...)` block - cmd.exe treats them as block
rem      delimiters and WILL corrupt control flow.
rem      Use square brackets `[text]` for parenthetical notes in echo strings.
rem ============================================================
set "ROOT=%~dp0"
cd /d "%ROOT%"

rem ---------- arg parsing ----------
set "MIRROR=0"
set "CHECK_ONLY=0"
:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /i "%ARG%"=="mirror" ( set "MIRROR=1" ) else (
if /i "%ARG%"=="check"  ( set "CHECK_ONLY=1" ) else (
    echo [WARN] Unknown arg "%ARG%" - ignored. Supported: mirror / check
))
shift
goto parse_args
:args_done

echo ================================================================
echo   dsh-trading-core install (Windows)
if %CHECK_ONLY%==1 echo     Mode : CHECK [env inspection only, no changes]
if %MIRROR%==1     echo     PyPI : Tsinghua mirror [recommended in China]
echo ================================================================
echo.

rem ================================================================
rem  [1/5] Python >= 3.10
rem ================================================================
set "PYCMD="
where py >nul 2>&1
if not errorlevel 1 (
    set "PYCMD=py -3"
) else (
    where python >nul 2>&1
    if not errorlevel 1 set "PYCMD=python"
)
if not defined PYCMD (
    echo [ERROR] Python not found. Install Python 3.10+ and tick "Add to PATH".
    exit /b 1
)
%PYCMD% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python ^>= 3.10 required. Current interpreter is too old.
    %PYCMD% --version
    exit /b 1
)
for /f "tokens=* USEBACKQ" %%V in (`%PYCMD% --version 2^>^&1`) do echo [OK] Python: %%V

rem ================================================================
rem  [2/5] venv
rem ================================================================
echo.
if exist "env\Scripts\python.exe" (
    echo [OK] venv: env\Scripts\python.exe [already exists]
) else (
    if %CHECK_ONLY%==1 (
        echo [WARN] venv missing: env\Scripts\python.exe. Run install.bat without "check" to create it.
    ) else (
        echo [2/5] Creating venv "env" ...
        %PYCMD% -m venv env
        if errorlevel 1 (
            echo [ERROR] Failed to create venv
            exit /b 1
        )
        echo [OK] venv created
    )
)

rem ================================================================
rem  [3/5] Python deps
rem ================================================================
echo.
if not exist "env\Scripts\python.exe" goto skip_pip_install

if %CHECK_ONLY%==1 (
    echo [CHECK] Verifying critical packages in env ...
    rem NOTE: These must be module / import names, NOT PyPI package names.
    rem   beautifulsoup4 -> bs4   /   python-dotenv -> dotenv
    env\Scripts\python.exe -c "import importlib.util, sys; pkgs=['fastapi','uvicorn','akshare','langgraph','chromadb','sse_starlette','pydantic','pandas','numpy','requests','bs4','dotenv']; missing=[p for p in pkgs if importlib.util.find_spec(p) is None]; print('  missing:', missing if missing else 'none'); sys.exit(1 if missing else 0)"
    if errorlevel 1 (
        echo [WARN] Some packages missing - they will be installed on full install.
    ) else (
        echo [OK] All critical Python packages are installed.
    )
    goto skip_pip_install
)

echo [3/5] Installing Python deps. First run takes several minutes.
env\Scripts\python.exe -m pip install --upgrade pip -q
if errorlevel 1 (
    echo [ERROR] Failed to upgrade pip
    exit /b 1
)
if %MIRROR%==1 (
    echo        mirror: https://pypi.tuna.tsinghua.edu.cn/simple
    env\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --retries 10 --timeout 120
) else (
    env\Scripts\python.exe -m pip install -r requirements.txt --retries 10 --timeout 120
)
if errorlevel 1 (
    echo [ERROR] pip install failed. Retry with "install.bat mirror" if in China.
    exit /b 1
)
echo [OK] Python deps installed.
:skip_pip_install

rem ================================================================
rem  [4/5] .env
rem ================================================================
echo.
echo [4/5] Checking .env ...
if not exist ".env" (
    if %CHECK_ONLY%==1 (
        echo [WARN] .env missing. On full install will be auto-created from .env.example; remember to set DEEPSEEK_API_KEY.
    ) else (
        copy /y ".env.example" ".env" >nul
        echo [OK] .env created from .env.example.
    )
) else (
    echo [OK] .env exists.
)
if exist ".env" (
    findstr /b /c:"DEEPSEEK_API_KEY=sk-" ".env" >nul 2>&1
    if errorlevel 1 (
        echo   [WARN] DEEPSEEK_API_KEY is still placeholder or empty. Edit .env and set a real key.
    ) else (
        echo   [OK] DEEPSEEK_API_KEY appears set.
    )
)

rem ================================================================
rem  [5/5] dsh-plugin npm deps (optional)
rem ================================================================
echo.
if exist "dsh-plugin\package.json" (
    echo [5/5] dsh-plugin npm deps. Optional - only needed for dsh Web UI.
    if %CHECK_ONLY%==1 (
        if exist "dsh-plugin\node_modules" (
            echo [OK] dsh-plugin/node_modules exists.
        ) else (
            echo [WARN] dsh-plugin/node_modules missing. npm install will run on full install.
        )
    ) else (
        pushd dsh-plugin
        call npm install >nul 2>&1
        if errorlevel 1 (
            echo   [WARN] npm install did not succeed - dsh Web UI / plugin smoke test may fail; adapter unaffected.
        ) else (
            echo   [OK] dsh-plugin npm deps ready.
        )
        popd
    )
) else (
    echo [SKIP] dsh-plugin folder not found - npm step skipped.
)

rem ================================================================
rem  verify key imports
rem ================================================================
echo.
if exist "env\Scripts\python.exe" (
    if %CHECK_ONLY%==1 (
        echo [CHECK] Critical module import check ...
    ) else (
        echo [VERIFY] Critical module import check ...
    )
    env\Scripts\python.exe -c "import fastapi, uvicorn, akshare, langgraph, chromadb, sse_starlette, pydantic, pandas, numpy, bs4, dotenv; print('  imports OK')"
    if errorlevel 1 (
        echo [ERROR] Critical module imports failed - review pip install output.
        exit /b 1
    )
) else (
    echo [SKIP] venv not ready - import check skipped.
)

rem ================================================================
rem  footer
rem ================================================================
echo.
echo ================================================================
if %CHECK_ONLY%==1 (
    echo   Check complete. If everything is green you can directly:
    echo     start_all.bat [fake / engine]
    echo     stop_all.bat
    echo     verify.bat
) else (
    echo   Install complete!
    echo     start_all.bat [fake / engine]
    echo     stop_all.bat
    echo     verify.bat
    echo   IMPORTANT: Make sure DEEPSEEK_API_KEY in .env is a real key.
)
echo ================================================================
endlocal
