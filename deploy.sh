#!/bin/bash
# 把源码构建产物 + 全部运行时 DLL + 侧栏脚本 同步到 bin/，可脱离 MSYS2 运行
# 位置无关：所有路径由脚本自身所在目录推导，整个文件夹可以随便搬
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src/build"
DST="$ROOT/bin"
SCRIPT_SRC="$ROOT/src/player/lua/explorer.lua"

if [ ! -f "$SRC/mpv.exe" ]; then
  echo "错误：找不到 $SRC/mpv.exe，请先编译（build.bat）" >&2
  exit 1
fi

mkdir -p "$DST"

echo "[1/4] 复制主程序"
cp -f "$SRC/mpv.exe" "$DST/"
cp -f "$SRC/mpv.com" "$DST/"
[ -f "$SRC/libmpv-2.dll" ] && cp -f "$SRC/libmpv-2.dll" "$DST/"

echo "[2/4] 解析并复制运行时依赖 DLL"
cd "$SRC"
ldd mpv.exe | grep -oE '/clang64/bin/[^ ]+\.dll' | sort -u | while read -r f; do
  cp -f "$f" "$DST/"
done

echo "[3/4] 同步右侧文件栏脚本（explorer.lua）"
if [ -f "$SCRIPT_SRC" ]; then
  mkdir -p "$DST/portable_config/scripts"
  cp -f "$SCRIPT_SRC" "$DST/portable_config/scripts/explorer.lua"
  echo "      -> $DST/portable_config/scripts/explorer.lua"
else
  echo "      (未找到 $SCRIPT_SRC，跳过)"
fi

echo "[4/4] 完成，bin/ 下共 $(ls "$DST" | wc -l) 个条目"
