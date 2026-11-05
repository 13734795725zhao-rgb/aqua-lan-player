@echo off
chcp 65001 >nul
cd /d "%~dp0app"
echo [ 1/3 ] 生成图标
pwsh -ExecutionPolicy Bypass -File tools\make-icon.ps1
echo [ 2/3 ] 安装打包依赖
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
if not exist node_modules\electron-builder call npm install
echo [ 3/3 ] 构建安装包
npx electron-builder --win nsis --x64
echo.
echo 产物: app\dist\AQUA-1.0.0-Setup.exe
pause
