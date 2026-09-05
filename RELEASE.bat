@echo off
REM ============================================================
REM  Vikray - one-command release  (Phase 5)
REM
REM  RELEASE.bat 3.1 "Faster bill search, dark mode fixes"
REM
REM  Bumps the version everywhere it appears, rebuilds the
REM  installer, hashes it, writes latest.json, pushes the code to
REM  GitHub, and publishes (or updates) the GitHub release - the
REM  same steps that were done by hand to ship 3.0, now one command.
REM
REM  One-time setup this needs: GitHub CLI signed in.
REM    winget install --id GitHub.cli
REM    gh auth login
REM  After that, releasing never needs a pasted token again.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Releasing Vikray...

if "%~1"=="" goto :usage
set "VERSION=%~1"
set "NOTES=%~2"
if "%NOTES%"=="" set "NOTES=See the release notes on GitHub."

echo.
echo   ==========================================
echo     VIKRAY  -  Release %VERSION%
echo   ==========================================
echo.

echo %VERSION%| findstr /r "^[0-9][0-9]*\.[0-9][0-9]*\(\.[0-9][0-9]*\)\?$" >nul
if errorlevel 1 (
    echo   [X] Version must look like 3.1 or 3.1.2 - got "%VERSION%"
    goto :fail
)

if not exist ".venv\Scripts\python.exe" (
    echo   [X] No build environment found yet. Run BUILD.bat once first,
    echo       then run RELEASE.bat again.
    goto :fail
)
set "VPY=%CD%\.venv\Scripts\python.exe"

echo   [1/6] Setting version to %VERSION% in brand.py and installer.iss...
"%VPY%" "build\bump_version.py" "%VERSION%"
if errorlevel 1 goto :fail

echo   [2/6] Building the installer ^(a minute or two^)...
call BUILD.bat
if errorlevel 1 goto :fail
if not exist "installer\Vikray-Setup-%VERSION%.exe" (
    echo   [X] Expected installer\Vikray-Setup-%VERSION%.exe was not produced.
    goto :fail
)

echo   [3/6] Hashing the installer and writing latest.json...
"%VPY%" "build\make_feed.py" "%VERSION%" "%NOTES%"
if errorlevel 1 goto :fail

echo   [4/6] Pushing the code to GitHub...
git add -A
git commit -m "Release %VERSION%" >nul 2>&1
if errorlevel 1 echo         (nothing new to commit in git - continuing)
git push
if errorlevel 1 goto :fail

echo   [5/6] Publishing the GitHub release...
where gh >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [X] GitHub CLI ^(gh^) is not installed.
    echo       Install it once:  winget install --id GitHub.cli
    echo       Then sign in:     gh auth login
    echo       Then run this command again - the code is already pushed,
    echo       nothing above needs to be repeated.
    goto :fail
)
gh auth status >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [X] Not signed in to GitHub CLI. Run "gh auth login" once,
    echo       then run RELEASE.bat %VERSION% again. The code is already
    echo       pushed, nothing above needs to be repeated.
    goto :fail
)

gh release view "v%VERSION%" >nul 2>&1
if errorlevel 1 (
    gh release create "v%VERSION%" "installer\Vikray-Setup-%VERSION%.exe" "latest.json" --title "Vikray %VERSION%" --notes "%NOTES%"
) else (
    gh release upload "v%VERSION%" "installer\Vikray-Setup-%VERSION%.exe" "latest.json" --clobber
)
if errorlevel 1 goto :fail

echo   [6/6] Done.
echo.
echo   ==========================================
echo     RELEASED  -  Vikray %VERSION%
echo   ==========================================
echo.
echo     Every device still on an older version will pick this up
echo     within 24 hours on its own, or right away if someone opens
echo     Settings and clicks "Check for updates".
echo.
goto :done

:usage
echo   Usage:   RELEASE.bat ^<version^> ["release notes"]
echo   Example: RELEASE.bat 3.1 "Faster bill search, dark mode fixes"
goto :done

:fail
echo.
echo   Something went wrong above - scroll up to see which step failed.
echo.

:done
pause
