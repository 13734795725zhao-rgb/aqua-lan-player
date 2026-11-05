@echo off
chcp 65001 >nul
REM One-click rebuild of mpv from source, then sync to bin\
REM All paths are relative to this script, so the whole folder can be moved freely.
REM
REM Usage: build.bat            incremental rebuild (auto-configures if build dir is missing)
REM        build.bat clean      wipe the build dir and configure from scratch
setlocal
set MSYSTEM=CLANG64
set CHERE_INVOKING=1
set MSYS=C:\msys64\usr\bin\bash.exe

cd /d "%~dp0"
if errorlevel 1 goto :fail

if /I "%~1"=="clean" (
    echo [clean] removing build directory...
    if exist "src\build" rmdir /S /Q "src\build"
)

if not exist "src\build" (
    echo [config] build directory missing, configuring with meson...
    "%MSYS%" -lc "cd src && meson setup build --prefix=/clang64 -Dlibmpv=true --buildtype=release"
    if errorlevel 1 goto :fail
)

echo [build] meson compile -C build
"%MSYS%" -lc "cd src && meson compile -C build"
if errorlevel 1 goto :fail

echo.
echo [deploy] syncing output to bin\
"%MSYS%" -lc "./deploy.sh"
if errorlevel 1 goto :fail

echo.
echo ===== BUILD OK =====
echo mpv.exe : %~dp0bin\mpv.exe
echo libmpv  : %~dp0bin\libmpv-2.dll
pause
exit /b 0

:fail
echo.
echo ===== BUILD FAILED =====
echo See: %~dp0src\build\meson-logs\meson-log.txt
pause
exit /b 1
