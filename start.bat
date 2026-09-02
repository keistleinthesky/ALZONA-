@echo off
REM ==== ALZONA one-click launcher ====
REM Opens the backend (FastAPI, port 5002) and the website (Vite, port 5173)
REM in two separate windows, then opens the site in your browser.

cd /d "%~dp0"

REM Make sure Node is reachable even if PATH hasn't refreshed since install.
set "PATH=%ProgramFiles%\nodejs;%PATH%"

REM Set here rather than inside the child command line: the windows started
REM below inherit this, which avoids nesting quotes inside `cmd /k "..."`
REM (cmd mis-parses those, and the backend window dies instantly).
set PYTHONUTF8=1

echo Starting ALZONA backend (port 5002)...
start "ALZONA Backend" cmd /k "gsp-env\Scripts\python.exe main.py"

echo Starting ALZONA website (port 5173)...
start "ALZONA Website" cmd /k "cd dycinovus && npm run dev"

echo Waiting for ALZONA to come up (the camera and voice models take a moment)...
timeout /t 20 /nobreak >nul

echo Opening the website in your browser...
start "" "http://localhost:5173"

echo.
echo ALZONA is starting. Two windows opened:
echo   - "ALZONA Backend"  (keep it open)
echo   - "ALZONA Website"  (keep it open)
echo If the browser shows nothing, wait a few seconds and refresh,
echo or check the "ALZONA Website" window for the exact localhost URL.
echo Close those two windows to stop ALZONA.
