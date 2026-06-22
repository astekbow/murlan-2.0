@echo off
REM ====================================================================
REM  Murlan sweep app — double-click to launch (LOCAL, this PC only).
REM  Opens http://127.0.0.1:8787 in your browser. The seed you type
REM  there never leaves this machine and is never saved.
REM ====================================================================
cd /d "%~dp0"
where node >nul 2>nul || (echo [X] Node.js nuk u gjet. Instaloje nga https://nodejs.org pastaj provo serish. & pause & exit /b 1)
if not exist "node_modules\tronweb" (
  echo Po instaloj varesite nje here te vetme...
  call npm i tronweb @scure/bip32 @scure/bip39 || (echo [X] npm install deshtoi. & pause & exit /b 1)
)
node sweep-app.mjs
pause
