@echo off
title Golden Wicker Cafe - Server
cd /d "%~dp0"

echo ============================================
echo   Golden Wicker Cafe - Starting Server
echo ============================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Download it from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
    echo.
)

echo Server starting at http://localhost:3000
echo Admin panel: http://localhost:3000/admin.html
echo Admin password: admin123
echo.
echo Press Ctrl+C to stop the server.
echo ============================================
echo.

timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/?table=1"
start "" "http://localhost:3000/admin.html"

call npm start

pause
