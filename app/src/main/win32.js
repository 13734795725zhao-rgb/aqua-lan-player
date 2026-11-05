'use strict';

/**
 * Windows 原生层（koffi → user32 / kernel32）
 *
 * 只做三件事，都是 Electron 自己不提供的：
 *   1. 创建一个「视频承载窗口」：mpv 只能把自己的窗口挂在一个 HWND 下并填满它，
 *      所以宿主必须提供一个位于左侧视频区的原生子窗口，否则 mpv 会直接铺满整个窗口。
 *   2. 给浮层窗口打开系统级磨砂材质（SetWindowCompositionAttribute / Acrylic），
 *      这是 Windows 上唯一能真正模糊「窗口背后内容」（包括视频画面）的手段，
 *      CSS 的 backdrop-filter 只能模糊网页自身，对原生窗口无效。
 *   3. 调整/销毁承载窗口。
 *
 * 注意：koffi 解引用 char* 返回值会崩溃，本文件全程不碰 char*。
 */

const koffi = require('koffi');

const kernel32 = koffi.load('kernel32.dll');
const user32 = koffi.load('user32.dll');

// ------------------------------------------------------------------ 类型 ---
const ACCENT_POLICY = koffi.struct('ACCENT_POLICY', {
  AccentState: 'int',
  AccentFlags: 'int',
  GradientColor: 'uint32', // 0xAABBGGRR
  AnimationId: 'int',
});

const WINCOMPATTRDATA = koffi.struct('WINCOMPATTRDATA', {
  Attribute: 'int',
  Data: koffi.pointer(ACCENT_POLICY),
  SizeOfData: 'uint32',
});

const RECT = koffi.struct('RECT', {
  left: 'int', top: 'int', right: 'int', bottom: 'int',
});

// ------------------------------------------------------------------ API ---
const SetDllDirectoryW = kernel32.func(
  'bool SetDllDirectoryW(const char16_t *lpPathName)');

const CreateWindowExW = user32.func(
  'uintptr_t CreateWindowExW(uint dwExStyle, const char16_t *lpClassName,' +
  ' const char16_t *lpWindowName, uint dwStyle, int X, int Y, int nWidth, int nHeight,' +
  ' uintptr_t hWndParent, uintptr_t hMenu, uintptr_t hInstance, uintptr_t lpParam)');

const SetWindowPos = user32.func(
  'bool SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter,' +
  ' int X, int Y, int cx, int cy, uint uFlags)');

const DestroyWindow = user32.func('bool DestroyWindow(uintptr_t hWnd)');
const IsWindow = user32.func('bool IsWindow(uintptr_t hWnd)');
const SetCapture = user32.func('uintptr_t SetCapture(uintptr_t hWnd)');
const ReleaseCapture = user32.func('bool ReleaseCapture()');
const GetWindow = user32.func('uintptr_t GetWindow(uintptr_t hWnd, uint uCmd)');
const GetClassNameW = user32.func(
  'int GetClassNameW(uintptr_t hWnd, uint16_t *lpClassName, int nMaxCount)');

const SetWindowCompositionAttribute = user32.func(
  'bool SetWindowCompositionAttribute(uintptr_t hWnd, WINCOMPATTRDATA *pData)');

const GetWindowRect = user32.func('bool GetWindowRect(uintptr_t hWnd, uintptr_t lpRect)');
const SetWindowLongPtrW = user32.func(
  'int64_t SetWindowLongPtrW(int64_t hWnd, int nIndex, int64_t dwNewLong)');

const GW_CHILD = 5;
const GW_HWNDNEXT = 2;

// -------------------------------------------------------------- 常量表 ---
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const GWLP_HWNDPARENT = -8;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_HIDEWINDOW = 0x0080;

const WCA_ACCENT_POLICY = 19;

const ACCENT = {
  DISABLED: 0,
  ENABLE_GRADIENT: 1,
  ENABLE_TRANSPARENTGRADIENT: 2,
  ENABLE_BLURBEHIND: 3,
  ENABLE_ACRYLICBLURBEHIND: 4,
};

// -------------------------------------------------------------- 工具函数 ---

/** Electron 的 getNativeWindowHandle() 返回 8 字节 Buffer（Win64 下即 HWND）。 */
function hwndFromBuffer(buf) {
  if (!buf || buf.length < 8) return 0n;
  return buf.readBigUInt64LE(0);
}

/** 让后续 LoadLibrary 能从 bin\ 找到 libmpv-2.dll 的一堆依赖。 */
function setDllDirectory(dir) {
  try {
    return SetDllDirectoryW(dir || null);
  } catch (e) {
    return false;
  }
}

/**
 * 创建视频承载窗口（宿主嵌入架构的关键）。
 *
 * 为什么是「顶层受管窗口」而不是外壳窗口的子窗口：
 *   Electron 的渲染窗口（Chrome_RenderWidgetHostHWND）在 Z 序里永远压着
 *   所有兄弟窗口，mpv 的画面会被整块盖住（表现为「在播但全黑」）。
 *   做成 owned 顶层窗口后，它由 Windows 保证始终在外壳之上，
 *   并且随外壳一起最小化/隐藏，鼠标事件则由上面的 glass 层接管。
 *
 * mpv 会以它为父窗口创建自己的子窗口，并自动跟随它的客户区尺寸变化。
 */
function createContainer(ownerHwnd, x, y, width, height) {
  const hwnd = CreateWindowExW(
    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
    'STATIC', 'mpv-surface',
    WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS,
    Math.round(x), Math.round(y), Math.max(1, Math.round(width)), Math.max(1, Math.round(height)),
    0n, 0n, 0n, 0n);
  if (!hwnd) return 0n;
  // 设为外壳的「受管窗口」：永远在外壳之上，且随外壳最小化
  setOwner(hwnd, ownerHwnd);
  return hwnd;
}

/**
 * 鼠标捕获：拖动侧边栏左缘调宽时，把全部鼠标输入锁定到这个窗口。
 *
 * 侧边栏是独立的原生窗口，光标一旦划到视频区域，
 * 事件就归玻璃层（视频）所有了 —— 拖拽过程中会被当成单击视频（暂停/全屏）。
 * SetCapture 之后，所有鼠标事件都送到捕获窗口，直到 ReleaseCapture。
 */
function captureMouse(hwnd) {
  try {
    return SetCapture(hwnd);
  } catch (e) {
    return 0n;
  }
}

function releaseMouse() {
  try {
    return ReleaseCapture();
  } catch (e) {
    return false;
  }
}

/**
 * 读取窗口类名（用 Buffer 承接 UTF-16，避免 koffi 误判 char*）。
 */
function className(hwnd) {
  try {
    if (!hwnd) return '';
    const buf = Buffer.alloc(256);
    const n = GetClassNameW(hwnd, buf, 64);
    return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
  } catch (e) {
    return '';
  }
}

/** 窗口在屏幕上的矩形（物理像素）。 */
function getRect(hwnd) {
  try {
    if (!hwnd) return null;
    const buf = Buffer.alloc(16);
    if (!GetWindowRect(hwnd, koffi.address(buf))) return null;
    const l = buf.readInt32LE(0);
    const t = buf.readInt32LE(4);
    const r = buf.readInt32LE(8);
    const b = buf.readInt32LE(12);
    return { x: l, y: t, w: r - l, h: b - t };
  } catch (e) {
    return null;
  }
}

/** 列出直接子窗口（诊断 mpv 是否把自己的窗口挂进了承载窗口）。 */
function children(hwnd) {
  const out = [];
  try {
    let c = GetWindow(hwnd, GW_CHILD);
    while (c) {
      out.push({ hwnd: c, cls: className(c), rect: getRect(c) });
      c = GetWindow(c, GW_HWNDNEXT);
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

/**
 * 把承载窗口抬到兄弟窗口的最上层。
 * CreateWindowEx 新建的 **子窗口** 默认被放在 Z 序底部，
 * 而 Chromium 的渲染窗口也是宿主窗口的子窗口，会把 mpv 的画面整块盖住
 * （表现就是「播放器在跑但画面永远是黑的」）。解决的代价只有一次调用。
 */
function raiseWindow(hwnd) {
  if (!hwnd) return false;
  try {
    return SetWindowPos(hwnd, 0n, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } catch (e) {
    return false;
  }
}

/**
 * 把窗口排到另一个窗口的**正上方**（而不是笼统的 HWND_TOP）。
 * 用来显式固定层叠顺序：
 *   外壳 → 视频承载窗口 → 玻璃层(输入) → 侧边栏 → 控制条
 * 视频必须在玻璃层**之下**（否则视频区的鼠标事件收不到），
 * 又在侧边栏之下（否则侧边栏被画面挡住）。
 */
function stackAfter(hwnd, afterHwnd) {
  if (!hwnd) return false;
  try {
    return SetWindowPos(hwnd, afterHwnd || 0n, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } catch (e) {
    return false;
  }
}

/** 把窗口设为另一个窗口的「受管窗口」（owned）：永远在其之上，随其最小化。 */
function setOwner(hwnd, ownerHwnd) {
  if (!hwnd) return false;
  try {
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, ownerHwnd);
    return true;
  } catch (e) {
    return false;
  }
}

/** 显示/隐藏一个原生窗口（承载窗口现在是独立顶层窗口，必须显式控制显隐）。 */
function showWindow(hwnd, visible) {
  if (!hwnd) return false;
  try {
    return SetWindowPos(hwnd, 0n, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
  } catch (e) {
    return false;
  }
}

/** 移动/缩放承载窗口（顶层窗口 → 坐标是屏幕物理像素）。 */
function moveWindow(hwnd, x, y, width, height, hide) {
  if (!hwnd) return false;
  if (hide) {
    return SetWindowPos(hwnd, 0n, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
  }
  return SetWindowPos(hwnd, 0n,
    Math.round(x), Math.round(y),
    Math.max(1, Math.round(width)), Math.max(1, Math.round(height)),
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

function destroyWindow(hwnd) {
  if (!hwnd || !isWindow(hwnd)) return false;
  return DestroyWindow(hwnd);
}

function isWindow(hwnd) {
  try {
    return !!IsWindow(hwnd);
  } catch (e) {
    return false;
  }
}

/**
 * 打开/关闭系统级磨砂材质。
 * @param hwnd    窗口句柄
 * @param enable  是否启用
 * @param abgr    0xAABBGGRR，Acrylic 的着色（同时决定整体明暗）
 */
function setAcrylic(hwnd, enable, abgr) {
  if (!hwnd) return false;
  try {
    return !!SetWindowCompositionAttribute(hwnd, {
      Attribute: WCA_ACCENT_POLICY,
      Data: {
        AccentState: enable ? ACCENT.ENABLE_ACRYLICBLURBEHIND : ACCENT.DISABLED,
        // 2 = 允许窗口四边都参与过渡（只给左右会让上下边界发虚）
        AccentFlags: enable ? 2 : 0,
        GradientColor: (abgr >>> 0) || 0,
        AnimationId: 0,
      },
      SizeOfData: 16,
    });
  } catch (e) {
    return false;
  }
}

/** 取 z 序相邻的窗口（GW_HWNDPREV=3 / GW_HWNDNEXT=2），用于确认层叠关系。 */
function neighbour(hwnd, cmd) {
  try {
    const h = GetWindow(hwnd, cmd);
    if (!h) return null;
    return { cls: className(h), rect: getRect(h) };
  } catch (e) {
    return null;
  }
}

module.exports = {
  hwndFromBuffer,
  neighbour,
  setDllDirectory,
  createContainer,
  setOwner,
  raiseWindow,
  stackAfter,
  showWindow,
  captureMouse,
  releaseMouse,
  moveWindow,
  destroyWindow,
  isWindow,
  setAcrylic,
  className,
  getRect,
  children,
  ACCENT,
};
