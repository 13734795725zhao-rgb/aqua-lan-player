@echo off
REM Sync build output + runtime DLLs + sidebar script into bin\ (portable folder)
REM Paths are relative to this script, so the folder can be moved freely.
setlocal
set MSYSTEM=CLANG64
set CHERE_INVOKING=1
cd /d "%~dp0"
"C:\msys64\usr\bin\bash.exe" -lc "./deploy.sh"
echo.
pause
