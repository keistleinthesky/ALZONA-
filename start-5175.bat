@echo off
REM ==== ALZONA workbench launcher (port 5175) ====
REM Opens the backend (FastAPI, port 5002) and the workbench website (Vite,
REM port 5175) in two separate windows, then opens the site in your browser.
REM
REM This is the console the song changes live in: Sing back removed, and the
REM anthem's words shown across the camera frame in both languages. start.bat
REM opens 5173 instead, which is the console that still has Sing back.
REM
REM Deliberately does NOT start 5173 or 5174. Only one console may hold the
REM microphone at a time, so a second one running is a second thing competing
REM for it — which is what stopped the harmony hearing anyone at all.

cd /d "%~dp0"

REM Make sure Node is reachable even if PATH hasn't refreshed since install.
set "PATH=%ProgramFiles%\nodejs;%PATH%"

REM Set here rather than inside the child command line: the windows started
REM below inherit this, which avoids nesting quotes inside `cmd /k "..."`
REM (cmd mis-parses those, and the backend window dies instantly).
set PYTHONUTF8=1

echo Starting ALZONA backend (port 5002)...
start "ALZONA Backend" cmd /k "gsp-env\Scripts\python.exe main.py"

echo Starting ALZONA workbench (port 5175)...
start "ALZONA 5175" cmd /k "cd dycinovus && npm run lab"

echo Waiting for ALZONA to come up (the camera and voice models take a moment)...
timeout /t 20 /nobreak >nul

echo Opening the workbench in your browser...
start "" "http://localhost:5175"

echo.
echo ALZONA is starting. Two windows opened:
echo   - "ALZONA Backend"  (keep it open)
echo   - "ALZONA 5175"     (keep it open)
echo.
echo If the browser shows nothing, wait a few seconds and refresh.
echo Close those two windows to stop ALZONA.
echo.
echo Use Chrome, and allow the microphone when it asks — permission is per
echo port, so allowing it on 5173 or 5174 does not cover this one.
