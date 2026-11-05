@echo off
chcp 65001 >nul
REM 启动「苹果风格侧边栏播放器」宿主程序（app\ 目录）
REM 首次运行会自动执行 npm install（Electron 二进制走国内镜像）
setlocal

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

cd /d "%~dp0app"
if errorlevel 1 goto :fail

if not exist "node_modules\electron\dist\electron.exe" (
    echo [setup] 首次运行，正在安装依赖（约 1~3 分钟）...
    call npm install
    if errorlevel 1 goto :fail
)

echo [run] 启动播放器...
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:fail
echo.
echo ===== 启动失败 =====
echo 请确认已安装 Node.js，并可在命令行执行 npm。
pause
exit /b 1
