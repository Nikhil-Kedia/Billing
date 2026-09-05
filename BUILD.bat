@echo off
REM ============================================================
REM  Vikray - one-click build
REM
REM  Double-click this file. It sets up an isolated Python
REM  environment, builds the app, and produces a proper Windows
REM  installer in the "installer" folder.
REM
REM  Nothing here touches your data. The shop's database lives in
REM  %LOCALAPPDATA%\BalajiBilling and is never read or written by
REM  this script.
REM ============================================================
setlocal
cd /d "%~dp0"
title Building Vikray...

echo.
echo   ==========================================
echo     VIKRAY  -  Billing ^& Inventory
echo     Building the installer
echo   ==========================================
echo.

REM ---------- 1. find Python ----------
set "PY="
where py >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY (
    where python >nul 2>&1
    if not errorlevel 1 set "PY=python"
)
if not defined PY goto :nopython
echo   [1/5] Python found.

REM ---------- 2. private build environment ----------
if exist ".venv\Scripts\python.exe" goto :havevenv
echo   [2/5] Creating a build environment ^(first time only^)...
%PY% -m venv .venv
if errorlevel 1 goto :fail
goto :venvdone
:havevenv
echo   [2/5] Build environment ready.
:venvdone
set "VPY=%CD%\.venv\Scripts\python.exe"

REM ---------- 3. dependencies ----------
echo   [3/5] Installing the pieces it needs ^(needs internet the first time^)...
"%VPY%" -m pip install --upgrade pip --quiet
"%VPY%" -m pip install -r requirements.txt --quiet
if errorlevel 1 goto :fail

REM ---------- 4. build the app ----------
echo   [4/5] Building the application ^(a minute or two^)...
if exist "dist\Vikray" rmdir /s /q "dist\Vikray"
"%VPY%" -m PyInstaller build\nova.spec --noconfirm --clean --log-level WARN
if errorlevel 1 goto :fail
if not exist "dist\Vikray\Vikray.exe" goto :noexe

REM ---------- 5. installer ----------
echo   [5/5] Making the installer...
call :findiscc
if defined ISCC goto :makeinstaller

where winget >nul 2>&1
if errorlevel 1 goto :portable
echo         Inno Setup is missing - fetching it once via winget...
winget install -e --id JRSoftware.InnoSetup --accept-source-agreements --accept-package-agreements --silent >nul 2>&1
call :findiscc
if not defined ISCC goto :portable

:makeinstaller
if not exist "installer" mkdir "installer"
"%ISCC%" /Q "build\installer.iss"
if errorlevel 1 goto :fail
echo.
echo   ==========================================
echo     DONE
echo   ==========================================
echo.
echo     Your installer:
echo       %CD%\installer\Vikray-Setup-3.0.exe
echo.
echo     Double-click it to install Vikray like any other
echo     Windows program. Your existing bills, customers
echo     and stock are picked up automatically.
echo.
explorer "%CD%\installer"
goto :done

:portable
echo.
echo   ==========================================
echo     DONE  ^(portable build^)
echo   ==========================================
echo.
echo     Inno Setup was not available, so no installer was made -
echo     but the app itself is built and fully works:
echo.
echo       %CD%\dist\Vikray\Vikray.exe
echo.
echo     For the proper installer, install Inno Setup 6 from
echo     https://jrsoftware.org/isdl.php and run this file again.
echo.
explorer "%CD%\dist\Vikray"
goto :done

REM ---------- helpers ----------
:findiscc
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if defined ISCC exit /b
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if defined ISCC exit /b
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
exit /b

:nopython
echo   [X] Python was not found on this computer.
echo.
echo       Install Python 3.10 or newer from https://python.org/downloads
echo       Tick "Add python.exe to PATH" during the install, then run
echo       this file again.
echo.
pause
exit /b 1

:noexe
echo   [X] The build finished but Vikray.exe is missing.
echo       Check the messages above for the reason.
echo.
pause
exit /b 1

:fail
echo.
echo   [X] The build stopped. The message above says why.
echo.
echo       Most common cause: no internet connection while
echo       installing the dependencies. Reconnect and run again.
echo.
pause
exit /b 1

:done
pause
exit /b 0
