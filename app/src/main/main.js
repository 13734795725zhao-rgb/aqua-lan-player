'use strict';

/**
 * 宿主主进程：状态机 + 布局编排。
 *
 * 分工（这是整套方案的地基）：
 *   - Electron 建窗口、画 UI（侧边栏 / 控制条 / 标题栏）
 *   - libmpv 只负责把画面渲染进「视频承载窗口」这个原生子窗口
 *   - 鼠标/键盘/动效全部由网页层接管，mpv 自身的输入与 OSC 全部关闭
 *
 * 三条性能纪律：
 *   1. 侧边栏展开/收起的整个动画过程中，绝不重设 mpv 视口尺寸，
 *      等动画结束（onDone）后才同步一次，避免每帧触发 mpv 重绘。
 *   2. 所有浮层窗口只跟随外壳窗口做几何同步，不参与任何像素级的视频合成。
 *   3. 控件状态用 mpv_observe_property 事件驱动，不用定时器盲目轮询。
 */

const path = require('path');
const {
  app, BrowserWindow, screen, ipcMain, dialog, nativeTheme, shell: electronShell,
  clipboard, Menu,
} = require('electron');

const win32 = require('./win32');
const { MpvPlayer, MpvProbe, MpvThumb, EVENT, END_REASON } = require('./mpv');
const { Store } = require('./store');
const { scanFolder, findCompanions } = require('./library');
const { createOverlay, tween, EASE_APPLE, RENDERER_DIR } = require('./panels');

// ------------------------------------------------------------- 常量表 ---
/**
 * 打包后（app.asar）与开发态的目录结构不同：
 *   开发态：<项目>\app\src\main  → ROOT = <项目>
 *   打包后：<安装目录>\resources\app.asar\src\main → ROOT = <安装目录>\resources
 * mpv 的运行时（libmpv-2.dll 及其依赖）在开发态是 <项目>\bin，
 * 打包时被 extraResources 放到 <安装目录>\resources\bin。
 */
const PACKAGED = app.isPackaged;
const ROOT = PACKAGED ? process.resourcesPath : path.resolve(__dirname, '..', '..', '..');
const BIN_DIR = path.join(ROOT, 'bin');
const CONFIG_DIR = path.join(BIN_DIR, 'portable_config');
/** 应用图标：打包后由 exe 自带，开发态手动指定（任务栏 / Alt-Tab 显示） */
const ICON_FILE = PACKAGED ? null : path.join(ROOT, 'build', 'icon.ico');

const TITLE_H = 52;          // 统一标题栏高度（与 shell.css 的 --title-h 保持一致）
const CONTROLS_H = 116;      // 控制层高度：里面是「悬浮胶囊 + 全宽进度条」
const SCRUB_HIT_TOP = 80;    // 进度条命中区上沿（相对控制层顶部），缩略图浮在它上方
const SIDEBAR_MS = 280;      // 苹果动效时长：250~320ms
const PEEK_DELAY = 300;      // 边缘悬停触发延迟
const PEEK_HIDE_DELAY = 450; // 鼠标离开侧边栏后的收起延迟
const IDLE_HIDE_MS = 2500;   // 鼠标静止多久后进入沉浸模式
const CHROME_FADE_MS = 400;  // 沉浸模式的淡出时长
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 560;
const PROBE_LIMIT = 3000;    // 最多探测多少个文件的时长

const PREVIEW_W = 208;       // 悬停缩略图窗口
const PREVIEW_H = 138;
const PREVIEW_IMG_W = 200;
const PREVIEW_IMG_H = 113;
const MENU_W = 132;          // 倍速菜单
const MENU_ITEM_H = 32;

/** 倍速下拉菜单的候选值 */
const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

/**
 * 长按快进/快退的阶梯变速表：
 * 按下先走一次常规 ±10s，之后按持续时间逐级加速穿梭。
 */
const SHUTTLE = [
  { after: 350, speed: 2, step: 1 },
  { after: 1000, speed: 5, step: 3 },
  { after: 1800, speed: 12, step: 8 },
];

// --------------------------------------------------------------- 状态 ---
const state = {
  theme: 'dark',                 // 实际生效的主题（auto 已解析）
  themePref: 'auto',
  sidebar: {
    open: false,                 // 固定展开
    peeking: false,              // 边缘悬停的临时浮出
    width: 320,
    currentWidth: 0,             // 动画过程中的实时宽度
    layout: 'overlay',           // 'overlay' 浮层式 | 'push' 推挤式
    animating: false,
    resizing: false,
  },
  library: {
    dir: '', scanning: false, count: 0, recursive: true, ready: false,
    recent: [],            // 最近访问的目录
    pinned: [],            // 固定到快捷栏的目录
    sort: 'name',          // 'name' | 'mtime' | 'duration' | 'progress'
    hideExt: false,        // 隐藏通用视频扩展名
    compact: false,        // 紧凑视图
    hidden: [],            // 从列表隐藏的路径
    playMode: 'sequence',  // 'sequence' | 'loop' | 'shuffle'
    ghost: false,          // 目录不可达（拔盘/网络断开）
  },
  playback: {
    path: '', index: -1, title: '', paused: true, idle: true,
    timePos: 0, duration: 0, volume: 70, muted: false, speed: 1,
    progress: { pos: 0, dur: 0, pct: 0 },
  },
  ui: { fullscreen: false, chromeHidden: false, active: true, acrylic: true, pip: false },
};

let store = null;
let shellWin = null;
let glass = null;
let sidebar = null;
let controls = null;
let menu = null;        // 倍速菜单
let preview = null;     // 进度条悬停缩略图
let shellHwnd = 0n;
let containerHwnd = 0n;
let previewHwnd = 0n;
let previewContainer = 0n;
let player = null;
let probe = null;
let thumb = null;       // 缩略图用的第三个 libmpv 实例

let libraryItems = [];
const libraryDurations = Object.create(null);
/** 观看进度：路径 → { pos, dur, pct, at } */
let progressMap = Object.create(null);
let sidebarTween = null;
let peekTimer = null;
let hideTimer = null;
let idleTimer = null;
let followTimer = null;
let lastGeomEvent = 0;
let controlsHovered = false;
let sidebarHovered = false;
/** 手动开合侧边栏后，在这一时刻之前不响应边缘唤出（防闪烁） */
let peekSuppressedUntil = 0;
let durationBatch = {};
let durationFlushTimer = null;
let quitting = false;

// 拖动进度条（Scrubbing）期间的临时状态
let scrubbing = false;
let scrubWasPaused = true;
let lastScrubSeek = 0;

// 长按快进/快退穿梭
let holdTimer = null;
let holdDir = 0;
let holdStartedAt = 0;
let holdWasPaused = true;
let holdBaseSpeed = 1;

// 画中画
let pipPrevBounds = null;
let lastPropertyEventAt = 0;
let lastPosSend = 0;
let lastVolSend = 0;
let lastProgressSave = 0;

// 播完自动连播：本项目 mpv 开了 keep-open=yes，
// mpv 在 EOF 时不会卸载文件（playloop.c 的 handle_keep_open 把 stop_play
// 改回 KEEP_PLAYING），因此 MPV_EVENT_END_FILE 不会在播完那一刻发出 ——
// 只能靠 eof-reached 属性来判断。
let eofHandled = false;      // 当前这个文件是否已经处理过「播完」
let eofPending = false;      // 250ms 二次确认进行中
let lastAdvanceAt = 0;       // 上次自动推进的时刻（防同一次播完连跳两条）
let shuffleBag = [];         // 乱序播放的抽取袋：抽空再洗一轮，保证不重复

// ------------------------------------------------------------ 工具函数 ---
function allWindows() {
  return [
    shellWin, glass && glass.win, sidebar && sidebar.win, controls && controls.win,
    menu && menu.win, preview && preview.win,
  ].filter((w) => w && !w.isDestroyed());
}

/** 控制层窗口的位置尺寸（相对屏幕，DIP）。 */
function controlsBounds() {
  const cb = contentBounds();
  return {
    x: cb.x,
    y: cb.y + cb.height - CONTROLS_H,
    width: cb.width,
    height: CONTROLS_H,
  };
}

function broadcast(channel, payload) {
  for (const w of allWindows()) w.webContents.send(channel, payload);
}

function sendState() {
  // 窗口标题跟着当前文件走
  if (shellWin && !shellWin.isDestroyed()) {
    const t = state.playback.title ? `AQUA 澜 — ${state.playback.title}` : 'AQUA 澜';
    if (shellWin.getTitle() !== t) shellWin.setTitle(t);
  }
  broadcast('state', state);
}

function sidebarVisible() {
  return state.sidebar.open || state.sidebar.peeking || state.sidebar.animating;
}

function contentBounds() {
  return shellWin.getContentBounds();
}

function scaleFactor() {
  try {
    return screen.getDisplayMatching(contentBounds()).scaleFactor || 1;
  } catch (e) {
    return 1;
  }
}

/** 视频区在外壳客户区内的矩形（DIP）。 */
function videoRect() {
  const cb = contentBounds();
  const top = state.ui.chromeHidden ? 0 : TITLE_H;
  const inset = (state.sidebar.open && state.sidebar.layout === 'push')
    ? state.sidebar.width : 0;
  return { x: 0, y: top, width: Math.max(1, cb.width - inset), height: Math.max(1, cb.height - top) };
}

function acrylicTint() {
  // 半透明要够"实"，否则视频从侧边栏背后透出来，
  // 用户根本分不清哪里是画面、哪里是面板（这正是"鼠标操作混在一起"的根源）。
  return state.theme === 'dark' ? 0xD91E1E1E : 0xE6F2F2F2;
}

// -------------------------------------------------------------- 布局 ---

function positionSidebar() {
  if (!sidebar || !sidebarVisible()) return;
  const cb = contentBounds();
  const v = videoRect();
  // 窗口可以被缩得很小，侧边栏不能宽过窗口（否则会盖住整块画面还拖不动）
  const w = Math.max(1, Math.min(state.sidebar.currentWidth, cb.width - 60));
  sidebar.setBounds({
    x: cb.x + cb.width - w,
    y: cb.y + v.y,
    width: w,
    height: v.height,
  });
}

/**
 * 某个 Electron 窗口真实的 DIP → 物理像素换算比。
 *
 * 不信任 scaleFactor() 的"按显示器查表"：多屏缩放不一致时它给出的是
 * **那块屏**的缩放，而 DIP 虚拟桌面 → 物理桌面的映射是逐显示器做的，
 * 两者不能混用（见 videoPhysicalRect 的说明）。
 * 这里直接拿 Windows 报的物理宽度除以 Electron 报的 DIP 宽度，得到真值。
 */
function measuredScale(win, hwnd) {
  try {
    const b = win.getBounds();
    const r = win32.getRect(hwnd);
    if (r && b.width > 0) {
      const k = r.w / b.width;
      if (k > 0.2 && k < 5) return k;
    }
  } catch (e) { /* 忽略 */ }
  return scaleFactor();
}

/**
 * 视频区的**物理像素**矩形（承载窗口是顶层窗口，只能用物理像素定位）。
 *
 * 关键：只缩放「相对偏移」，绝不缩放「屏幕绝对坐标」。
 *
 * DIP 虚拟桌面 → 物理桌面的映射是**逐显示器**的：每块屏各自把自己的
 * DIP 矩形按自己的缩放铺到物理桌面上，副屏的原点并不等于「DIP 原点 × 副屏缩放」。
 * （本机副屏 DISPLAY9 在 DIP 空间里 y 原点是 180，而它的物理原点不是 180×k。）
 * 所以 `(cb.y + v.y) * s` 这种"整体乘缩放"的算法，只要副屏的 DIP 原点不为 0
 * 且缩放和主屏不同，算出来的原点就是错的 ——
 * 表现正是「视频窗口往上偏移，把标题栏下半截压住」。
 *
 * 正确做法：向 Windows 要外壳窗口的**真实物理矩形**当原点，
 * DIP 只用来算「相对外壳客户区」的偏移量。
 */
function videoPhysicalRect() {
  const b = shellWin.getBounds();      // DIP：外框（屏幕坐标）
  const cb = contentBounds();          // DIP：客户区（屏幕坐标）
  const v = videoRect();               // DIP：相对客户区
  const r = win32.getRect(shellHwnd);  // 物理像素：外框（屏幕坐标）
  const s = measuredScale(shellWin, shellHwnd);
  // 客户区原点（物理）：外框物理原点 + 边框宽度换算成物理像素
  const ox = r ? r.x + (cb.x - b.x) * s : cb.x * s;
  const oy = r ? r.y + (cb.y - b.y) * s : cb.y * s;
  return {
    x: ox + v.x * s,
    y: oy + v.y * s,
    w: Math.max(1, v.width * s),
    h: Math.max(1, v.height * s),
    s,
  };
}

/**
 * 统一几何同步。
 * @param opts.video 是否同步 mpv 视口（动画过程中传 false）
 */
function relayout(opts = {}) {
  if (!shellWin || shellWin.isDestroyed()) return;
  const cb = contentBounds();
  const v = videoRect();

  if (containerHwnd && opts.video !== false) {
    // 承载窗口是顶层受管窗口 → 坐标用屏幕物理像素
    const p = videoPhysicalRect();
    win32.moveWindow(containerHwnd, p.x, p.y, p.w, p.h);
  }

  if (glass) {
    glass.setBounds({ x: cb.x + v.x, y: cb.y + v.y, width: v.width, height: v.height });
  }

  syncControlsBounds();

  positionSidebar();
}

/** 控制层的宽度会随侧边栏同步收窄，保证胶囊相对「视频区」居中。 */
function syncControlsBounds() {
  // 注意：即使当前是隐藏状态也要更新 bounds，
  // 否则「隐藏期间调整了窗口大小」会让控制条停留在旧位置。
  if (!controls) return;
  const ccb = controlsBounds();
  // 窗口窄的时候不再给侧边栏让位，否则胶囊会被挤到只剩几十像素
  const narrow = ccb.width < 640;
  const inset = (!narrow && sidebarVisible()) ? state.sidebar.currentWidth : 0;
  controls.setBounds({
    x: ccb.x, y: ccb.y,
    width: Math.max(1, ccb.width - inset), height: CONTROLS_H,
  });
}

if (process.env.AQUA_DEBUG) {
  const _relayout = relayout;
  relayout = function (opts) {
    _relayout(opts);
    const cb = contentBounds();
    const v = videoRect();
    console.log(`[layout] cb=${JSON.stringify(cb)} video=${JSON.stringify(v)} scale=${scaleFactor().toFixed(2)}`);
  };
}

function scheduleFollow() {
  lastGeomEvent = Date.now();
  if (followTimer) return;
  followTimer = setInterval(() => {
    relayout();
    if (Date.now() - lastGeomEvent > 250) {
      clearInterval(followTimer);
      followTimer = null;
      // 停下来时按「最终落点」再做一次完整适配
      // （跨屏拖动结束时，缩放/所在显示器才刚定下来）
      syncDisplay();
    }
  }, 16);
}

// -------------------------------------------- 多显示器 / 缩放适配 ---
/**
 * 外壳窗口当前所在的显示器。
 * 多屏且缩放不同时，它决定 DIP → 物理像素的换算（本机主屏是 1.75）。
 */
function currentDisplay() {
  try {
    return screen.getDisplayMatching(contentBounds());
  } catch (e) {
    return screen.getPrimaryDisplay();
  }
}

/**
 * 把窗口收进目标显示器的工作区。
 *
 * 只在「换屏 / 显示器分辨率变了」时才调用：
 *   - 从 4K 屏拖到 1080p 屏，窗口可能比目标屏还大 → 等比缩到放得下；
 *   - 拔掉显示器或把分辨率改小后，窗口可能整个落到屏外 → 拉回可视区。
 * 同一块屏上用户自己把窗口拉大，不会被干预。
 */
function fitIntoDisplay(disp) {
  if (!shellWin || shellWin.isDestroyed()) return;
  if (shellWin.isMaximized() || shellWin.isFullScreen() || state.ui.pip) return;
  const wa = (disp || currentDisplay()).workArea;
  const b = shellWin.getBounds();
  const min = shellWin.getMinimumSize();
  const minW = Math.max(1, min[0] || 420);
  const minH = Math.max(1, min[1] || 280);
  const availW = Math.max(minW, wa.width);
  const availH = Math.max(minH, wa.height);

  let w = b.width;
  let h = b.height;
  // 换屏：先恢复这块屏上次记住的尺寸（放得下的话），
  // 否则才等比缩 —— 免得在两块屏之间来回拖就把窗口越拖越小。
  const saved = displaySizes.get(disp.id);
  if (saved && saved.width <= availW && saved.height <= availH) {
    w = saved.width;
    h = saved.height;
  } else if (w > availW || h > availH) {
    const k = Math.min(availW / w, availH / h);   // 等比缩，保住窗口比例
    w = Math.max(minW, Math.round(w * k));
    h = Math.max(minH, Math.round(h * k));
  }
  const x = Math.min(Math.max(b.x, wa.x), Math.max(wa.x, wa.x + wa.width - w));
  const y = Math.min(Math.max(b.y, wa.y), Math.max(wa.y, wa.y + wa.height - h));
  if (w !== b.width || h !== b.height || x !== b.x || y !== b.y) {
    shellWin.setBounds({ x, y, width: w, height: h });
  }
}

/**
 * 显示器 / 缩放变化后的整体重适配。
 *
 * 为什么光靠 move/resize 事件不够：
 *   视频承载窗口是我们自己 CreateWindowEx 出来的**原生顶层窗口**，
 *   Windows 不会替它做 DPI 缩放；而 WM_DPICHANGED 又比 Electron 分发的
 *   move 事件晚一拍，只同步一次会停在「旧缩放算出的物理像素」上
 *   （表现为画面错位、留黑边、或者比视频区大一圈）。
 *   所以这里除了一次立即同步，还要在 120ms / 400ms 各补一次。
 *
 * mpv 侧不用额外操心：它用 WH_CALLWNDPROC 钩子盯着承载窗口的
 * WM_WINDOWPOSCHANGED（w32_common.c 的 resize_child_win），
 * 我们一把承载窗口挪到新尺寸，它的画面就自动跟上。
 */
function adaptToDisplay(opts = {}) {
  if (!shellWin || shellWin.isDestroyed()) return;
  if (opts.fit) fitIntoDisplay(opts.display);
  hidePreview();        // 缩略图浮层的物理坐标也要按新缩放重算，先收起来
  relayout();
  ensureStackOrder();
  setTimeout(() => {
    if (shellWin && !shellWin.isDestroyed()) { relayout(); ensureStackOrder(); }
  }, 120);
  setTimeout(() => {
    if (shellWin && !shellWin.isDestroyed()) { relayout(); ensureStackOrder(); }
  }, 400);
}

/** 轮询与事件共用的入口：只有「所在显示器」或「缩放」真的变了才动手。 */
let lastDisplayId = null;
let lastScaleFactor = 0;
/** 每块显示器各自记住的窗口尺寸：displayId → { width, height } */
const displaySizes = new Map();

function syncDisplay(opts = {}) {
  if (!shellWin || shellWin.isDestroyed()) return;
  const disp = currentDisplay();
  const s = disp.scaleFactor || 1;
  const scaleChanged = Math.abs(s - lastScaleFactor) > 0.001;
  const displayChanged = disp.id !== lastDisplayId;
  if (lastDisplayId !== null && !scaleChanged && !displayChanged) return;
  if (displayChanged && lastDisplayId !== null && !shellWin.isMinimized()) {
    // 离开旧屏前，记下它在那块屏上的尺寸（下次拖回来原样恢复）
    const b = shellWin.getBounds();
    displaySizes.set(lastDisplayId, { width: b.width, height: b.height });
  }
  lastDisplayId = disp.id;
  lastScaleFactor = s;
  adaptToDisplay({ fit: displayChanged || !!opts.forceFit, display: disp });
  if (process.env.AQUA_DEBUG) {
    console.log(`[display] 适配 id=${disp.id} scale=${s} ` +
      `workArea=${JSON.stringify(disp.workArea)}`);
  }
}

// --------------------------------------------------- 侧边栏开合动画 ---

function animateSidebar(target, done) {
  if (sidebarTween) sidebarTween.cancel();
  const from = state.sidebar.currentWidth;
  state.sidebar.animating = true;

  // 内容淡出保护：收起时文字/缩略图先快速淡出，
  // 避免宽度变窄的瞬间文字被挤成难看的截断状态
  sidebar.send('sidebar:anim', { dir: target > from ? 'in' : 'out', ms: SIDEBAR_MS });

  sidebarTween = tween({
    from, to: target, duration: SIDEBAR_MS, easing: EASE_APPLE,
    onFrame: (w) => {
      state.sidebar.currentWidth = w;
      positionSidebar();
      syncControlsBounds();
    },
    onDone: () => {
      sidebarTween = null;
      state.sidebar.animating = false;
      state.sidebar.currentWidth = target;
      if (target === 0) {
        sidebar.hide();
      }
      // 动画彻底结束之后，才让 mpv 视口做一次尺寸同步（推挤模式下唯一一次重绘）
      relayout();
      if (done) done();
    },
  });
}

/**
 * 侧边栏显隐的**唯一入口**。
 *
 * 这一层把四类竞态一次性收掉：
 *  1. **明确意图**：调用方给的是目标状态，不是"取反"，
 *     避免"状态变了 → 样式没跟上 → 再被别的逻辑改回去"。
 *  2. **打断所有待执行的隐藏**：淡出定时器、边缘唤出定时器全部清掉，
 *     不会出现"刚展开就被 450ms 后的自动收起吞掉"。
 *  3. **防抖**：200ms 内的重复触发只生效一次，
 *     杜绝 click + 快捷键双通道导致的"展开→立即收起"闪一下。
 *  4. **单一事实源**：顶栏按钮的高亮完全由 state.sidebar.open 派生。
 */
let sidebarToggleAt = 0;
/** 本次会话里用户是否手动操作过侧边栏（决定窗口激活时要不要强制展开） */
let sidebarUserToggled = false;
/** 本次启动是否已经激活过一次 */
let sidebarFirstFocus = false;

function setSidebarVisible(want) {
  const now = Date.now();
  if (now - sidebarToggleAt < 200) return;   // 防抖
  sidebarToggleAt = now;

  // 打断一切"隐藏"意图
  suppressPeek();
  clearTimeout(hideTimer);

  if (want) {
    state.sidebar.peeking = false;
    openSidebar(true);
  } else {
    closeSidebar();
  }
  sidebarUserToggled = true;
  if (store) store.set('sidebarOpen', state.sidebar.open);
}

/**
 * 把侧边栏窗口的可见性/位置与 state 强制对齐。
 *
 * 场景：窗口最小化期间动画仍在跑，此时 contentBounds() 是 0×0，
 * 侧边栏会被摆到一个无效位置（状态写着"已展开"，窗口其实看不见）。
 * 从最小化恢复、被拉回屏幕、显示切换时都调一次，把两者拉回一致。
 */
/**
 * 固化几个受管窗口的层叠顺序（从下到上）：
 *     外壳 → 视频承载窗口 → 玻璃层(输入) → 控制条 → 侧边栏
 *
 * 为什么需要它：
 *   * 玻璃层必须在视频**之上**，否则视频区的鼠标事件全被 mpv 窗口吃掉
 *     （点画面不暂停、移动鼠标唤不回控件）；
 *   * 侧边栏必须在最上，否则展开后被画面挡住 —— 就是"点了按钮却看不见"。
 *   * **mpv 在加载文件、初始化渲染窗口时会把自己的承载窗口顶到最前**，
 *     所以光在启动时排一次不够，必须在每次 VO 就绪后再排一次。
 *
 * 做法：按「自底向上」依次置顶，每抬一次就把该窗口压到其余之上。
 * （注意 SetWindowPos 的 hWndInsertAfter 语义是"排在它**后面**"，
 *   不能用"插到某窗口之后"来表达"在其之上"。）
 */
function ensureStackOrder() {
  if (!containerHwnd) return;
  const r1 = win32.raiseWindow(containerHwnd);
  const r2 = glass ? win32.raiseWindow(glass.hwnd) : null;
  const r3 = controls ? win32.raiseWindow(controls.hwnd) : null;
  const r4 = sidebar ? win32.raiseWindow(sidebar.hwnd) : null;
  if (process.env.AQUA_DEBUG && stackLogCount-- > 0) {
    const hx = (h) => (h ? '0x' + h.toString(16) : 'null');
    console.log(`[zorder] 固化 container=${r1}${hx(containerHwnd)} glass=${r2}${hx(glass && glass.hwnd)}` +
      ` controls=${r3}${hx(controls && controls.hwnd)} sidebar=${r4}${hx(sidebar && sidebar.hwnd)}`);
  }
}
let stackLogCount = 3;

function syncSidebarWindow() {
  if (!sidebar) return;
  const shouldShow = state.sidebar.open || state.sidebar.peeking || state.sidebar.animating;
  if (shouldShow) {
    if (sidebarTween) { sidebarTween.cancel(); sidebarTween = null; }
    state.sidebar.animating = false;
    state.sidebar.currentWidth = state.sidebar.width;
    if (!sidebar.visible) {
      sidebar.show();
      sidebar.setOpacity(1);
    }
    positionSidebar();
    syncControlsBounds();
    win32.raiseWindow(sidebar.hwnd);   // 同样保证压在视频窗口之上
  } else if (sidebar.visible) {
    sidebar.hide();
  }
}

function openSidebar(pinned) {
  if (pinned) state.sidebar.open = true;
  clearTimeout(hideTimer);
  const wasVisible = sidebar.visible;
  if (!wasVisible) {
    state.sidebar.currentWidth = 0;
    positionSidebar();
    sidebar.show();
    applySidebarMaterial();
  }
  // 显式置顶：视频承载窗口（mpv）与玻璃层都是外壳的受管窗口，
  // 单纯 show() 不保证排在最前 —— 侧边栏必须压在它们之上，否则会被画面挡住。
  win32.raiseWindow(sidebar.hwnd);
  animateSidebar(state.sidebar.width);
  sendState();
}

function closeSidebar({ keepPinned = false } = {}) {
  if (!keepPinned) state.sidebar.open = false;
  state.sidebar.peeking = false;
  if (!sidebar.visible) {
    sendState();
    return;
  }
  animateSidebar(0, () => {
    sendState();
  });
  sendState();
}

function setPeek(on) {
  if (process.env.AQUA_DEBUG) {
    console.log(`[sidebar] setPeek(${on}) open=${state.sidebar.open} peeking=${state.sidebar.peeking}`);
  }
  if (state.sidebar.open) return;
  clearTimeout(hideTimer);
  if (on) {
    if (state.sidebar.peeking && sidebar.visible) return;
    state.sidebar.peeking = true;
    openSidebar(false);
  } else {
    if (!state.sidebar.peeking) return;
    hideTimer = setTimeout(() => {
      state.sidebar.peeking = false;
      closeSidebar();
    }, PEEK_HIDE_DELAY);
  }
}

function schedulePeek() {
  if (state.sidebar.open || state.sidebar.peeking) return;
  // 侧边栏已经露出来了就别再顶它（否则会来回闪）
  if (sidebar && sidebar.visible) return;
  if (process.env.AQUA_DEBUG) {
    console.log(`[sidebar] schedulePeek 被拒（visible=${sidebar && sidebar.visible} 抑制中=${Date.now() < peekSuppressedUntil}）`);
  }
  // 手动开合后的一小段时间内不响应边缘唤出，
  // 否则「点按钮关闭 → 鼠标恰好在右缘 → 又被顶出来」会变成闪烁
  if (Date.now() < peekSuppressedUntil) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => setPeek(true), PEEK_DELAY);
}

function cancelPeek() {
  clearTimeout(peekTimer);
}

/** 手动操作侧边栏后，暂时禁用边缘唤出。 */
function suppressPeek(ms = 1800) {
  peekSuppressedUntil = Date.now() + ms;
  cancelPeek();
}

// --------------------------------------------------------- 沉浸模式 ---

function showChrome() {
  if (process.env.AQUA_DEBUG) {
    console.log(`[main] showChrome flag=${controls && controls.visible} real=${controls && controls.win.isVisible()}`);
  }
  if (controls) {
    controls.show(); // 内部会取消未完成的淡出并恢复不透明度
    syncControlsBounds();   // 隐藏期间窗口可能变过尺寸，这里补一次同步
  }
  if (state.ui.chromeHidden) {
    state.ui.chromeHidden = false;
    relayout();
  }
}

/**
 * 沉浸式休眠：淡控制条 + 隐藏光标。
 * 三条例外（苹果的行为也是这样）：
 *   - 画中画：窗口太小，控件必须常驻
 *   - 已经处于暂停：用户多半在打量画面，不要收走控件
 *   - 鼠标正停在控件/侧边栏上
 */
function hideChrome() {
  if (state.ui.pip) return;
  // 暂停时控件常驻（macOS 就是这样：暂停时 transport 一直在）
  if (state.playback.paused && !state.playback.idle) return;
  if (controls && controls.visible && !controlsHovered) {
    controls.fadeOut(CHROME_FADE_MS);
  }
  hidePreview();
  if (state.ui.fullscreen && !state.sidebar.open && !sidebarHovered) {
    state.ui.chromeHidden = true;
    relayout();
  }
}

function kickActivity() {
  showChrome();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideChrome, IDLE_HIDE_MS);
}

// --------------------------------------------------------- 画中画 ---
/**
 * 桌面端的画中画不是「换一个 wid」（mpv 的 wid 只能在初始化时给定），
 * 正确做法是把宿主主窗口本身切成：无标题栏、永远置顶、按视频宽高比锁定的小窗口。
 * 视频承载窗口是它的子窗口，会自动跟着缩过去，一次转场就完成了。
 */
function togglePip() {
  if (!shellWin || shellWin.isDestroyed()) return;
  state.ui.pip = !state.ui.pip;

  if (state.ui.pip) {
    pipPrevBounds = shellWin.getBounds();
    if (shellWin.isMaximized()) shellWin.unmaximize();
    if (shellWin.isFullScreen()) shellWin.setFullScreen(false);

    // 收起侧边栏，免得小窗口里还留出右侧空白
    if (state.sidebar.open) {
      state.sidebar.open = false;
      closeSidebar();
    }

    const size = player && player.videoSize ? player.videoSize() : null;
    const ratio = (size && size.h) ? size.w / size.h : 16 / 9;
    const w = 400;
    const h = Math.round(w / ratio);

    shellWin.setAspectRatio(w / h);
    shellWin.setAlwaysOnTop(true, 'screen-saver');
    const area = screen.getDisplayMatching(shellWin.getBounds()).workArea;
    shellWin.setBounds({
      x: area.x + area.width - w - 24,
      y: area.y + area.height - h - 24,
      width: w,
      height: h,
    });
    state.ui.chromeHidden = true;   // 藏掉标题栏：小窗只剩画面 + 悬浮控件
    relayout();
    kickActivity();
  } else {
    shellWin.setAspectRatio(0);
    shellWin.setAlwaysOnTop(false);
    if (pipPrevBounds) shellWin.setBounds(pipPrevBounds);
    state.ui.chromeHidden = false;
    relayout();
    kickActivity();
  }
  sendState();
}

// --------------------------------------------------------- 倍速菜单 ---

function ensureMenu() {
  if (menu) return menu;
  menu = createOverlay({
    name: 'menu', file: 'menu.html', parent: shellWin,
    width: MENU_W, height: SPEEDS.length * MENU_ITEM_H + 20, focusable: true,
  });
  // 失焦即关闭：点到别处、点到别的控件都会收到 blur
  menu.win.on('blur', () => hideMenu());
  try { menu.setAcrylic(state.ui.acrylic, acrylicTint()); } catch (e) { /* 忽略 */ }
  return menu;
}

/** anchor 是按钮在控制层内的局部坐标，此处换算成屏幕坐标再定位。 */
function showMenu(anchor) {
  if (!shellWin) return;
  const m = ensureMenu();
  const h = SPEEDS.length * MENU_ITEM_H + 20;
  const ccb = controlsBounds();
  const area = screen.getDisplayMatching(ccb).workArea;

  let x = ccb.x + (anchor.x || 0) + (anchor.w || 0) - MENU_W; // 右对齐按钮
  let y = ccb.y + (anchor.y || 0) - h - 8;                    // 浮在按钮上方
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - MENU_W - 4));
  if (y < area.y + 4) y = area.y + 4;

  m.setBounds({ x: Math.round(x), y: Math.round(y), width: MENU_W, height: h });
  m.show();
}

function hideMenu() {
  if (menu && menu.visible) menu.hide();
}

function toggleMenu(anchor) {
  if (menu && menu.visible) hideMenu();
  else showMenu(anchor);
}

// ----------------------------------------------------- 悬停缩略图 ---
/** 懒创建：第一次悬停进度条时才起来（内含第三个 libmpv 实例）。 */
function ensurePreview() {
  if (preview) return preview;
  preview = createOverlay({
    name: 'preview', file: 'preview.html', parent: shellWin,
    width: PREVIEW_W, height: PREVIEW_H, focusable: false,
  });
  // 缩略图永远不吃鼠标事件，否则会挡住进度条的拖拽
  preview.ignoreMouse(true);
  previewHwnd = win32.hwndFromBuffer(preview.win.getNativeWindowHandle());
  const s = scaleFactor();
  previewContainer = win32.createContainer(
    previewHwnd, 4 * s, 4 * s, PREVIEW_IMG_W * s, PREVIEW_IMG_H * s);
  // 承载窗口是独立的顶层窗口：预览没显示时必须先藏起来，
  // 否则它会孤零零地停在屏幕左上角（就是那个「莫名其妙的小缩略图」）。
  if (previewContainer) win32.showWindow(previewContainer, false);
  if (previewContainer) {
    try {
      thumb = new MpvThumb({ binDir: BIN_DIR, containerHwnd: previewContainer });
      win32.raiseWindow(previewContainer);
      // 立即把当前文件也喂给缩略图实例，保证第一次悬停就有画面
      if (state.playback.path) thumb.load(state.playback.path);
    } catch (e) {
      console.warn('[mpv] 缩略图实例启动失败：', e.message);
      thumb = null;
    }
  }
  return preview;
}

function showPreview(localX, time) {
  if (!state.playback.duration) return;
  if (!preview) ensurePreview();
  if (!preview) return;

  const ccb = controlsBounds();
  let x = ccb.x + localX - PREVIEW_W / 2;
  x = Math.max(ccb.x + 8,
    Math.min(x, ccb.x + ccb.width - PREVIEW_W - 8));
  const y = ccb.y + SCRUB_HIT_TOP - 10 - PREVIEW_H;

  preview.setBounds({ x: Math.round(x), y: Math.round(y), width: PREVIEW_W, height: PREVIEW_H });
  preview.show();
  // 承载窗口也是独立顶层窗口 → 必须跟着预览框一起挪到对应位置。
  // 同样的规矩：拿预览浮层的**真实物理矩形**当原点，只把 4px 的内边距换算成物理像素，
  // 不能拿 DIP 屏幕坐标直接乘缩放（跨屏时会偏）。
  if (previewContainer) {
    const s = measuredScale(preview.win, previewHwnd);
    const pr = win32.getRect(previewHwnd);
    win32.moveWindow(previewContainer,
      (pr ? pr.x : Math.round(x) * s) + 4 * s,
      (pr ? pr.y : Math.round(y) * s) + 4 * s,
      PREVIEW_IMG_W * s, PREVIEW_IMG_H * s);
    win32.showWindow(previewContainer, true);
  }
  movePreviewThumb(time);
}

let lastThumbSeek = 0;
function movePreviewThumb(time) {
  if (!preview || !preview.visible) return;
  preview.send('preview:time', { time, hasVideo: !!thumb });
  if (!thumb || state.playback.duration <= 0) return;
  const t = Math.max(0, Math.min(state.playback.duration - 0.05, time));
  const now = Date.now();
  if (now - lastThumbSeek < 40) return;   // 节流，别把解码线程压满
  lastThumbSeek = now;
  try {
    // 缩略图实例可能刚被后台任务切到别的文件，先纠正回来
    if (thumb.loaded !== state.playback.path) {
      thumb.load(state.playback.path);
      return;
    }
    thumb.seekTo(t);
  } catch (e) { /* 忽略 */ }
}

function hidePreview() {
  if (previewContainer) win32.showWindow(previewContainer, false);
  if (preview && preview.visible) preview.hide();
}

// ------------------------------------------------- 缩略图预览说明 ---
/**
 * 第三个 libmpv 实例（thumb）只服务一件事：**进度条悬停预览**。
 * 它加载当前文件、按鼠标位置 exact seek，由 GPU 解出那一帧显示在浮层里。
 *
 * ⚠ 不要再拿它去做「列表卡片的首帧缩略图」：
 *   1) 会和悬停预览抢同一个实例（互相把对方的文件换掉）；
 *   2) 课程类视频的首帧往往是纯色/黑底，卡片上只看到一个灰框，反而更糟。
 *   列表徽标统一用统一的视频图标。
 */

// ------------------------------------------------------- 拖拽擦洗 ---
/**
 * 苹果的 Scrubbing 手感：拖动时先按帧画面快速定位（暂停底层播放，避免声音糊成一团），
 * 松手后再恢复到原本的播放状态。
 */
function beginScrub() {
  if (!player) return;
  scrubbing = true;
  scrubWasPaused = !!player.getFlag('pause');
  if (!scrubWasPaused) player.pause(true);
}

function moveScrub(time) {
  if (!player || !scrubbing) return;
  const now = Date.now();
  if (now - lastScrubSeek < 45) return;
  lastScrubSeek = now;
  player.seekAbsolute(time, 'absolute+exact');
}

function endScrub(time) {
  if (!player) { scrubbing = false; return; }
  scrubbing = false;
  player.seekAbsolute(Math.max(0, time), 'absolute+exact');
  if (!scrubWasPaused) player.pause(false);
  refreshPlayback(false);
}

// ------------------------------------------------------- 长按穿梭 ---
function beginHold(dir) {
  if (!player) return;
  holdDir = dir;
  holdStartedAt = Date.now();
  holdBaseSpeed = player.getDouble('speed') || 1;
  holdWasPaused = !!player.getFlag('pause');
  if (holdWasPaused) player.pause(false);
  player.seek(10 * dir);          // 点一下就是常规 ±10 秒
  if (holdTimer) clearInterval(holdTimer);
  holdTimer = setInterval(tickHold, 110);
}

function tickHold() {
  if (!player || !holdDir) return;
  const elapsed = Date.now() - holdStartedAt;
  let stage = -1;
  for (let i = SHUTTLE.length - 1; i >= 0; i--) {
    if (elapsed >= SHUTTLE[i].after) { stage = i; break; }
  }
  if (stage < 0) return;
  const s = SHUTTLE[stage];
  if (holdDir > 0) {
    player.setSpeed(holdBaseSpeed * s.speed);   // 正向：阶梯加速播放
  } else {
    // 反向播放多数封装不支持，改为逐级加大的跳跃式回退
    player.seek(-s.step);
  }
}

function endHold() {
  if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  holdDir = 0;
  if (player) {
    player.setSpeed(holdBaseSpeed);
    if (holdWasPaused) player.pause(true);
  }
  refreshPlayback(false);
}

// ----------------------------------------------------------- 播放器 ---

function initPlayer() {
  shellHwnd = win32.hwndFromBuffer(shellWin.getNativeWindowHandle());
  const cb = contentBounds();
  const s = scaleFactor();
  const v = videoRect();
  containerHwnd = win32.createContainer(
    shellHwnd, (cb.x + v.x) * s, (cb.y + v.y) * s, v.width * s, v.height * s);

  if (!containerHwnd) {
    console.error('[宿主] 视频承载窗口创建失败');
    return;
  }
  // 关键：把承载窗口抬到 Chromium 渲染窗口之上，否则画面会被网页盖住
  win32.raiseWindow(containerHwnd);

  try {
    player = new MpvPlayer({ binDir: BIN_DIR, containerHwnd, configDir: CONFIG_DIR });
    // mpv 在初始化里已经建好自己的子窗口，再抬一次确保它排在渲染窗口之前
    win32.raiseWindow(containerHwnd);
  } catch (e) {
    console.error('[mpv] 初始化失败：', e.message);
    dialog.showErrorBox('libmpv 初始化失败', e.message + '\n\n请确认 bin\\libmpv-2.dll 及其依赖完整。');
    return;
  }

  player.setVolume(state.playback.volume);
  player.setMute(state.playback.muted);

  // 时长探测实例（第二个 libmpv，无画面无声音）
  try {
    probe = new MpvProbe({ binDir: BIN_DIR });
    probe.onDuration = queueDuration;
  } catch (e) {
    console.warn('[mpv] 时长探测实例启动失败：', e.message);
  }
}

function handlePlayerEvent(ev) {
  switch (ev.event_id) {
    case EVENT.PROPERTY_CHANGE: {
      // mpv 主动告诉我们哪个属性变了 —— UI 不需要定时器轮询
      const info = MpvPlayer.decodePropertyChange(ev);
      if (!info) break;
      lastPropertyEventAt = Date.now();
      if (info.name === 'eof-reached') {
        // 播到最后了（keep-open 下 mpv 不发 END_FILE，只有这个属性会翻）
        maybeEnded();
        break;
      }
      if (info.name === 'time-pos') {
        // 逐帧属性：只读这一个值，广播限流到 20fps
        const t = player.getDouble('time-pos');
        if (t != null) state.playback.timePos = t;
        const now = Date.now();
        if (now - lastPosSend >= 50) {
          lastPosSend = now;
          sendState();
        }
        // 观看进度每 5 秒落一次盘
        if (now - lastProgressSave >= 5000 && state.playback.path) {
          lastProgressSave = now;
          saveProgress(state.playback.path, state.playback.timePos,
            state.playback.duration || 0);
        }
      } else {
        // 离散属性（pause/volume/mute/speed/duration）立即生效
        refreshPlayback(true);
      }
      break;
    }
    case EVENT.END_FILE: {
      // 注意：keep-open=yes 时这个文件结束（EOF）**不会**走到这里。
      // 这里只兜住「换文件 / 出错 / 停止」时被卸载的情况，
      // 真正的播完判定在 eof-reached（见 onPlaybackEnded）。
      const { reason } = MpvPlayer.decodeEndFile(ev);
      if (reason === END_REASON.EOF) onPlaybackEnded();
      break;
    }
    case EVENT.FILE_LOADED: {
      // 文件就绪：自动绑定同名的外挂字幕 / 外部音轨
      attachCompanions();
      refreshPlayback(true);
      // mpv 初始化渲染窗口时会把自己的承载窗口顶到最前，
      // 这会把侧边栏/玻璃层压到画面下面 —— 所以这里必须重新固化层叠顺序。
      setTimeout(ensureStackOrder, 60);
      setTimeout(ensureStackOrder, 400);
      break;
    }
    case EVENT.VIDEO_RECONFIG: {
      refreshPlayback(true);
      setTimeout(ensureStackOrder, 80);
      break;
    }
    case EVENT.START_FILE:
      // 开始载入：mpv 可能重建渲染窗口，这里先排一次，载入完成后（FILE_LOADED）还会再排
      ensureStackOrder();
      eofHandled = false;   // 新文件：重新允许「播完 → 接下一个」
      refreshPlayback(true);
      break;
    case EVENT.IDLE:
    case EVENT.PAUSE:
    case EVENT.UNPAUSE:
      refreshPlayback(true);
      break;
    default:
      break;
  }
}

let lastSnapshot = '';
function refreshPlayback(force) {
  if (!player) return;
  const snap = player.snapshot();
  if (!snap) return;
  const p = state.playback;
  p.timePos = snap.timePos || 0;
  p.duration = snap.duration || 0;
  p.paused = snap.paused !== false;
  p.idle = !!snap.idle;
  p.volume = snap.volume != null ? snap.volume : p.volume;
  p.muted = !!snap.muted;
  p.speed = snap.speed || 1;

  const key =
    `${p.timePos.toFixed(1)}|${p.duration.toFixed(1)}|${p.paused}|${p.idle}|` +
    `${p.volume}|${p.muted}|${p.speed.toFixed(2)}`;
  if (force || key !== lastSnapshot) {
    lastSnapshot = key;
    sendState();
  }
}

function playIndex(index) {
  if (index < 0 || index >= libraryItems.length) return;
  const item = libraryItems[index];
  if (process.env.AQUA_DEBUG) {
    console.log(`[main] playIndex ${index} -> ${item ? item.name : 'null'}`);
  }
  if (!item) return;

  // 源文件可能已经被拔盘 / 删除：先探活，避免把内核搞崩
  if (!require('fs').existsSync(item.path)) {
    state.library.ghost = true;
    sidebar.send('item:ghost', { path: item.path, name: item.name });
    sendState();
    return;
  }

  state.playback.index = index;
  state.playback.path = item.path;
  state.playback.title = item.name;
  eofHandled = false;      // 新的一条：重新允许「播完 → 接下一个」
  player.loadFile(item.path);
  player.pause(false);
  if (thumb) thumb.load(item.path);   // 同步喂给缩略图实例

  // 自动续播：从上次的位置继续
  const rec = progressOf(item.path);
  if (rec && rec.pos > 5 && rec.pct < 0.98) {
    player.seekAbsolute(rec.pos, 'absolute');
  }
  sendState();
}

/** 列表里被用户「隐藏」的条目不参与自动连播。 */
function isHidden(p) {
  return (state.library.hidden || []).includes(p);
}

/** 从 start 起按 step 方向找第一个可播（未被隐藏）的下标，找不到返回 -1。 */
function playableIndex(start, step) {
  const n = libraryItems.length;
  for (let i = start; i >= 0 && i < n; i += step) {
    if (!isHidden(libraryItems[i].path)) return i;
  }
  return -1;
}

/**
 * 乱序播放：用一个「抽取袋」洗牌后逐个取，取空再洗一轮。
 * 这样既随机，又不会像纯 Math.random 那样反复抽到同一条、
 * 或者漏掉某几条永远播不到。
 */
function nextShuffleIndex(base) {
  const n = libraryItems.length;
  if (!n) return -1;
  if (!shuffleBag.length) {
    shuffleBag = libraryItems.map((_, i) => i);
    // Fisher–Yates
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = shuffleBag[i];
      shuffleBag[i] = shuffleBag[j];
      shuffleBag[j] = t;
    }
  }
  while (shuffleBag.length) {
    const cand = shuffleBag.shift();
    if (cand !== base && !isHidden(libraryItems[cand].path)) return cand;
  }
  return base >= 0 ? base : playableIndex(0, 1);
}

/**
 * 播完了：记进度 + 按播放模式接上下一条。
 *
 * 触发来源有三处（互为兜底，避免漏判）：
 *   ① eof-reached 属性观察（主路径，播完瞬间就到）
 *   ② 250ms 轮询（属性变更通知万一没送达时的兜底）
 *   ③ END_FILE/EOF（万一将来关掉 keep-open）
 */
function onPlaybackEnded() {
  if (!state.playback.path) return;
  if (eofHandled) return;
  const now = Date.now();
  if (now - lastAdvanceAt < 800) return;   // 防同一次播完连跳两条
  eofHandled = true;
  lastAdvanceAt = now;

  // 看完的标记成 100%
  const dur = state.playback.duration || 0;
  if (dur) saveProgress(state.playback.path, dur, dur);

  if (!(store && store.get('autoplayNext'))) return;
  setTimeout(() => playOffset(1, { auto: true }), 60);
}

/**
 * eof-reached 的**二次确认**。
 *
 * 换文件的瞬间（loadfile 已下发、START_FILE 还没到）eof-reached 可能仍是
 * 上一首留下的 true，直接判定会连跳两条。所以收到信号后等 250ms 再看一次。
 */
function maybeEnded() {
  if (eofHandled || eofPending) return;
  if (!player || state.playback.idle) return;
  if (player.getFlag('eof-reached') !== true) return;
  eofPending = true;
  setTimeout(() => {
    eofPending = false;
    if (!player || eofHandled || state.playback.idle) return;
    if (player.getFlag('eof-reached') === true) onPlaybackEnded();
  }, 250);
}

/**
 * 按播放模式推进。
 * @param delta 手动切换给 ±1；自动连播固定 +1
 * @param opts.auto 是否为「播完自动接下一个」
 *                  （顺序连播播完最后一条就收尾，不绕回开头循环整目录）
 */
function playOffset(delta, opts = {}) {
  if (!libraryItems.length) return;
  const mode = state.library.playMode;
  const base = state.playback.index;
  const n = libraryItems.length;

  // 单集循环：只在「播完自动接上」时生效；
  // 手动点上/下一个仍然按顺序走，否则用户永远切不走。
  if (mode === 'loop' && opts.auto) {
    if (base >= 0) playIndex(base);
    return;
  }

  let next;
  if (mode === 'shuffle') {
    next = nextShuffleIndex(base);
  } else {
    const from = base < 0 ? (delta > 0 ? 0 : n - 1) : base + delta;
    next = playableIndex(from, delta > 0 ? 1 : -1);
    if (next < 0 && delta > 0) {
      if (opts.auto) return;                 // 顺序连播：最后一条播完就收尾
      next = playableIndex(0, 1);            // 手动「下一个」才绕回开头
    } else if (next < 0) {
      next = playableIndex(n - 1, -1);       // 往回绕到最后一个
    }
  }
  if (next >= 0) playIndex(next);
}

/** 切目录 / 换播放模式时，乱序的抽取袋要作废重洗。 */
function resetShuffleBag() {
  shuffleBag = [];
}

// ------------------------------------------------------------- 目录 ---

/** 记入「最近访问」（最多 5 条，置顶去重）。 */
function pushRecent(dir) {
  if (!dir) return;
  const list = (state.library.recent || []).filter((d) => d !== dir);
  list.unshift(dir);
  state.library.recent = list.slice(0, 5);
  if (store) store.set('recentFolders', state.library.recent);
}

function togglePin(dir) {
  if (!dir) return;
  const list = state.library.pinned || [];
  const i = list.indexOf(dir);
  if (i >= 0) list.splice(i, 1);
  else list.unshift(dir);
  state.library.pinned = list.slice(0, 8);
  if (store) store.set('pinnedFolders', state.library.pinned);
  sendState();
}

function clearRecent() {
  state.library.recent = [];
  if (store) store.set('recentFolders', []);
  sendState();
}

/** 从列表中隐藏（不动磁盘文件）。 */
function hideItemDirect(p) {
  if (!p) return;
  const list = state.library.hidden || [];
  if (!list.includes(p)) list.push(p);
  state.library.hidden = list;
  if (store) store.set('hiddenItems', list);
  sidebar.send('library:items', libraryItems);
  sendState();
}

/** 目录是否可达（拔盘 / 网络断开时返回 false）。 */
function dirAlive(dir) {
  try {
    return require('fs').statSync(dir).isDirectory();
  } catch (e) {
    return false;
  }
}

async function loadFolder(dir) {
  if (!dir) return;
  state.library.dir = dir;
  state.library.scanning = true;
  state.library.ready = false;
  state.library.ghost = !dirAlive(dir);
  sendState();
  sidebar.send('library:begin', { dir });

  const items = await scanFolder(dir, state.library.recursive, (n) => {
    sidebar.send('library:progress', { count: n });
  });

  libraryItems = items;
  resetShuffleBag();   // 换目录：乱序的抽取袋作废
  state.library.scanning = false;
  state.library.count = items.length;
  state.library.ready = true;
  state.library.ghost = !dirAlive(dir);
  sidebar.send('library:items', items);
  sidebar.send('library:durations', libraryDurations);
  sidebar.send('library:progress-map', progressMap);
  sendState();

  if (probe) {
    probe.clear();
    probe.enqueue(items.slice(0, PROBE_LIMIT));
  }
  if (store) store.set('lastDir', dir);
  pushRecent(dir);
}

// ------------------------------------------------------- 观看进度 ---

function saveProgress(filePath, pos, dur) {
  if (!filePath || !dur) return;
  const pct = Math.max(0, Math.min(1, pos / dur));
  const rec = { pos, dur, pct, at: Date.now() };
  progressMap[filePath] = rec;
  if (store) store.set('progress', progressMap);
  state.playback.progress = rec;
  sidebar.send('library:progress', { path: filePath, ...rec });
}

function progressOf(filePath) {
  return progressMap[filePath] || null;
}

/** 播放就绪后，把同名外挂字幕与外部音轨挂到 mpv 的渲染管线。 */
function attachCompanions() {
  if (!player || !state.playback.path) return;
  try {
    const c = findCompanions(state.playback.path);
    if (c.subs.length) player.command('sub-add', c.subs[0]);
    if (c.audios.length) player.command('audio-add', c.audios[0]);
  } catch (e) { /* 忽略 */ }
}

function queueDuration(id, duration) {
  libraryDurations[id] = duration;
  durationBatch[id] = duration;
  if (!durationFlushTimer) {
    durationFlushTimer = setTimeout(() => {
      sidebar.send('library:durations', durationBatch);
      durationBatch = {};
      durationFlushTimer = null;
    }, 250);
  }
}

// --------------------------------------------------------- 窗口创建 ---

/**
 * 校验上次保存的窗口位置。
 * 最小化 / 拔掉显示器后保存的坐标可能是 (-32000,-32000) 这种屏幕外位置，
 * 直接恢复会让窗口「消失」，所以这里检查窗口中心是否还落在某块屏幕里。
 */
function sanitizeBounds(b) {
  if (!b || !b.width || !b.height) return null;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const ok = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height;
  });
  return ok ? b : null;
}

function createShell() {
  const bounds = sanitizeBounds(store.get('bounds'));
  shellWin = new BrowserWindow({
    width: (bounds && bounds.width) || 1280,
    height: (bounds && bounds.height) || 760,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 420,
    minHeight: 280,
    title: 'AQUA 澜',
    icon: ICON_FILE || undefined,   // 任务栏 / Alt-Tab 的图标（打包后由 exe 自带）
    frame: false,               // 自绘标题栏；Windows 下默认带 thickFrame，原生缩放边框仍在
    backgroundColor: state.theme === 'dark' ? '#1b1b1d' : '#ececec',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  shellWin.loadFile(path.join(RENDERER_DIR, 'shell.html'));
  shellWin.setMenuBarVisibility(false);

  shellWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[shell] ${message} (${sourceId}:${line})`);
  });
  shellWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[shell] 加载失败 ${code} ${desc} ${url}`);
  });
  shellWin.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[shell] 渲染进程退出: ${details.reason}`);
  });

  shellWin.once('ready-to-show', () => {
    shellWin.show();

  // 保险：万一窗口落在屏幕外（上次是最小化退出的，Windows 会继承那个位置），
  // 把它拉回可见区域 —— 否则用户会以为"双击了没反应"。
  setTimeout(() => {
    if (!shellWin || shellWin.isDestroyed()) return;
    const b = shellWin.getBounds();
    const onScreen = screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return b.x + b.width > wa.x && b.x < wa.x + wa.width &&
        b.y + b.height > wa.y && b.y < wa.y + wa.height;
    });
    if (!onScreen) {
      shellWin.restore();
      shellWin.show();
      shellWin.focus();
      console.log('[宿主] 窗口原本落在屏幕外，已拉回可见区域');
    }
    syncSidebarWindow();
  }, 900);
    relayout();
  });

  const geom = () => { scheduleFollow(); };
  shellWin.on('move', geom);
  shellWin.on('resize', geom);
  shellWin.on('restore', geom);
  shellWin.on('maximize', geom);
  shellWin.on('unmaximize', geom);

  shellWin.on('minimize', () => {
    if (sidebar) sidebar.hide();
    if (controls) controls.hide();
    if (glass) glass.hide();
    if (containerHwnd) win32.moveWindow(containerHwnd, 0, 0, 0, 0, true);
  });
  shellWin.on('restore', () => {
    if (glass) glass.show();
    if (sidebarVisible()) sidebar.show();
    kickActivity();
    relayout();
    // 从最小化恢复：把侧边栏窗口与状态强行对齐
    // （最小化期间动画会被摆到无效位置，导致"状态说开着其实看不见"）
    syncSidebarWindow();
  });

  shellWin.on('enter-full-screen', () => {
    state.ui.fullscreen = true;
    relayout();
    kickActivity();
    sendState();
  });
  shellWin.on('leave-full-screen', () => {
    state.ui.fullscreen = false;
    state.ui.chromeHidden = false;
    relayout();
    kickActivity();
    sendState();
  });

  shellWin.on('focus', () => {
    state.ui.active = true;
    // 窗口被激活（快捷方式启动 / 从后台切回来）时，
    // 如果用户还没手动动过侧边栏，就强制展开一次 —— 保证"打开就能看见目录"。
    // 只在本次启动的第一次激活时做；用户手动收起过就不再强制。
    if (!sidebarFirstFocus && !sidebarUserToggled
      && !state.sidebar.open && !state.sidebar.animating) {
      state.sidebar.peeking = false;
      openSidebar(true);
    }
    sidebarFirstFocus = true;
    sendState();
  });
  shellWin.on('blur', () => {
    setTimeout(() => {
      const any = allWindows().some((w) => w.isFocused());
      if (!any) { state.ui.active = false; sendState(); }
    }, 30);
  });

  shellWin.on('closed', () => {
    shellWin = null;
  });

  shellWin.on('close', () => {
    if (shellWin) store.set('bounds', shellWin.getBounds());
  });

  return shellWin;
}

function createOverlays() {
  // 1) 输入玻璃层：盖在视频之上，接管全部鼠标事件。
  //    视频是原生子窗口，网页拿不到它上面的鼠标，只能靠这层窗口。
  glass = createOverlay({
    name: 'glass', file: 'glass.html', parent: shellWin,
    width: 100, height: 100, focusable: true,
  });
  glass.show();

  // 2) 悬浮胶囊播控条。注意 focusable 不能关：
  //    Windows 上 focusable:false 会连带 setIgnoreMouseEvents(true)，滑块就点不动了。
  //    它不用系统磨砂 —— 磨砂是「整扇窗口」的效果，会把胶囊那一圈圆角糊成矩形；
  //    胶囊自己用半透明材质 + 高光描边，视觉上是浮在画面上的一整块玻璃。
  controls = createOverlay({
    name: 'controls', file: 'controls.html', parent: shellWin,
    width: 100, height: CONTROLS_H, focusable: true,
  });
  controls.show();

  // 3) 右侧磨砂侧边栏（最后创建 → 位于最上层）
  sidebar = createOverlay({
    name: 'sidebar', file: 'sidebar.html', parent: shellWin,
    width: state.sidebar.width, height: 100, focusable: true,
  });

  ensureStackOrder();

  // 磨砂材质要等窗口句柄就绪；失败则自动降级为半透明纯色面板。
  // 这里是「窗口还隐藏着」的时候设材质 —— 之后每次开合都不再重设，避免闪。
  for (const p of [sidebar]) {
    p.win.once('ready-to-show', () => {
      const ok = p.setAcrylic(true, acrylicTint());
      if (!ok) {
        state.ui.acrylic = false;
        console.warn(`[材质] ${p.name} 未能启用系统磨砂，已降级为半透明面板`);
      }
      p.materialState = !!state.ui.acrylic;
      p.materialTint = state.theme;
      p.send('material', { acrylic: ok, theme: state.theme });
    });
  }

  relayout();
}

// ------------------------------------------------------------- IPC ---

function bindIpc() {
  ipcMain.handle('init', () => ({
    constants: { TITLE_H, CONTROLS_H, SIDEBAR_MIN, SIDEBAR_MAX },
    state,
  }));

  // ---- 窗口 ----
  ipcMain.on('win', (_e, action) => {
    switch (action) {
      case 'min': shellWin.minimize(); break;
      case 'max':
        if (shellWin.isMaximized()) shellWin.unmaximize();
        else shellWin.maximize();
        break;
      case 'close': shellWin.close(); break;
      case 'fullscreen':
        shellWin.setFullScreen(!shellWin.isFullScreen());
        break;
      default: break;
    }
  });

  // ---- 侧边栏 ----
  ipcMain.on('sidebar:toggle', () => {
    // 以「窗口真实是否可见」为准，而不是状态字段。
    // 窗口最小化 / 被拉回屏幕外的过程中，两者会短暂脱节：
    // 状态说"已展开"其实窗口是藏着的，此时若按状态反推就会发出"收起"指令 ——
    // 点按钮看起来就毫无反应。
    const open = sidebar ? sidebar.visible : state.sidebar.open;
    if (process.env.AQUA_DEBUG) {
      console.log(`[sidebar] toggle 实际可见=${open} 状态open=${state.sidebar.open} → 目标=${!open}`);
    }
    setSidebarVisible(!open);
  });

  // 显式指定目标状态；传 null 表示"按实际可见性翻转"
  ipcMain.on('sidebar:set', (_e, want) => {
    if (want === null || want === undefined) {
      const open = sidebar ? sidebar.visible : state.sidebar.open;
      setSidebarVisible(!open);
    } else {
      setSidebarVisible(!!want);
    }
  });
  ipcMain.on('sidebar:peek-start', (_e, on) => {
    if (on) schedulePeek(); else cancelPeek();
  });
  ipcMain.on('sidebar:hover', (_e, on) => {
    // 开合动画期间窗口在移动，进出事件是"假"的，忽略掉才不会误判
    if (state.sidebar.animating) return;
    sidebarHovered = on;
    if (on) { clearTimeout(hideTimer); kickActivity(); }
    else if (state.sidebar.peeking) setPeek(false);
  });
  ipcMain.on('sidebar:width', (_e, w) => {
    const width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
    state.sidebar.width = width;
    state.sidebar.currentWidth = width;
    if (store) store.set('sidebarWidth', width);
    relayout();
    sendState();
  });
  ipcMain.on('sidebar:resizing', (_e, on) => {
    state.sidebar.resizing = on;
    // 拖拽调宽时加一层"遮罩"：
    //   ① 鼠标捕获到侧边栏窗口，事件不会跑回视频区；
    //   ② 玻璃层暂时忽略鼠标，划到画面上也不会被当成单击（暂停/全屏）。
    if (on) {
      if (sidebar && sidebar.hwnd) win32.captureMouse(sidebar.hwnd);
      if (glass) glass.win.setIgnoreMouseEvents(true);
    } else {
      win32.releaseMouse();
      if (glass) glass.win.setIgnoreMouseEvents(false);
    }
    sendState();
  });
  ipcMain.on('sidebar:layout', (_e, layout) => {
    state.sidebar.layout = layout === 'push' ? 'push' : 'overlay';
    if (store) store.set('layout', state.sidebar.layout);
    relayout();
    sendState();
  });

  // ---- 目录 ----
  // 渲染层加载完成的时间不确定，主动拉取一次，避免错过广播
  ipcMain.handle('library:get', () => ({
    dir: state.library.dir,
    items: libraryItems,
    durations: libraryDurations,
    progress: progressMap,
    scanning: state.library.scanning,
    count: state.library.count,
    recursive: state.library.recursive,
    recent: state.library.recent,
    pinned: state.library.pinned,
    sort: state.library.sort,
    hideExt: state.library.hideExt,
    compact: state.library.compact,
    hidden: state.library.hidden,
    playMode: state.library.playMode,
  }));

  ipcMain.handle('library:pick', async () => {
    const res = await dialog.showOpenDialog(shellWin, {
      title: '选择视频文件夹',
      properties: ['openDirectory', 'showHiddenFiles'],
      defaultPath: state.library.dir || undefined,
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    loadFolder(dir);
    return dir;
  });

  ipcMain.on('library:rescan', () => {
    if (state.library.dir) loadFolder(state.library.dir);
  });

  ipcMain.on('library:recursive', (_e, on) => {
    state.library.recursive = !!on;
    if (store) store.set('recursive', state.library.recursive);
    if (state.library.dir) loadFolder(state.library.dir);
  });

  // ---- 目录多路管理（最近 / 固定 / 面包屑 / 拖拽）----
  ipcMain.on('library:open', (_e, dir) => { if (dir) loadFolder(dir); });
  ipcMain.on('library:pin', (_e, dir) => togglePin(dir));
  ipcMain.on('library:clear-recent', () => clearRecent());
  ipcMain.on('library:crumb', (_e, dir) => { if (dir) loadFolder(dir); });
  ipcMain.on('library:drop', (_e, dir) => { if (dir) loadFolder(dir); });

  ipcMain.on('library:sort', (_e, mode) => {
    const allowed = ['name', 'mtime', 'duration', 'progress'];
    state.library.sort = allowed.includes(mode) ? mode : 'name';
    if (store) store.set('sortBy', state.library.sort);
    sendState();
  });
  ipcMain.on('library:view', (_e, opt) => {
    const o = opt || {};
    if (o.compact !== undefined) {
      state.library.compact = !!o.compact;
      if (store) store.set('compact', state.library.compact);
    }
    if (o.hideExt !== undefined) {
      state.library.hideExt = !!o.hideExt;
      if (store) store.set('hideExt', state.library.hideExt);
    }
    sendState();
  });

  // ---- 播放模式（顺序 / 单曲循环 / 乱序）----
  ipcMain.on('play:mode', (_e, mode) => {
    const allowed = ['sequence', 'loop', 'shuffle'];
    state.library.playMode = allowed.includes(mode) ? mode : 'sequence';
    if (store) store.set('playMode', state.library.playMode);
    resetShuffleBag();
    sendState();
  });

  // ---- 条目操作 ----
  ipcMain.on('item:hide', (_e, p) => hideItemDirect(p));
  ipcMain.on('item:unhide-all', () => {
    state.library.hidden = [];
    if (store) store.set('hiddenItems', []);
    sidebar.send('library:items', libraryItems);
    sendState();
  });
  ipcMain.on('item:trash', (_e, p) => {
    if (!p) return;
    try {
      electronShell.trashItem(p);
      // 回收是异步的，延迟一点再刷新列表
      setTimeout(() => {
        if (state.library.dir) loadFolder(state.library.dir);
      }, 800);
    } catch (e) {
      console.warn('[主进程] 移到回收站失败', e.message);
    }
  });
  ipcMain.on('item:rename', (_e, info) => {
    const { path: p, name } = info || {};
    if (!p || !name) return;
    const dir = require('path').dirname(p);
    const target = require('path').join(dir, name);
    try {
      require('fs').renameSync(p, target);
      if (state.playback.path === p) state.playback.path = target;
      if (state.library.dir) loadFolder(state.library.dir);
    } catch (e) {
      console.warn('[主进程] 重命名失败', e.message);
      sidebar.send('item:rename:failed', { path: p, message: e.message });
    }
  });
  ipcMain.on('item:copy', (_e, info) => {
    const { path: p, name, what } = info || {};
    const text = what === 'name' ? (name || '') : (p || '');
    if (text) clipboard.writeText(text);
  });
  ipcMain.on('item:rename:start', (_e, p) => sidebar.send('item:rename:begin', p));

  // ---- 原生右键菜单（macOS 风格交互：系统菜单，不用自绘浮层避免被窗口裁掉）----
  ipcMain.on('item:context', (_e, info) => {
    const it = info || {};
    if (!it.path) return;
    const isPinned = (state.library.pinned || []).includes(state.library.dir);
    const template = [
      { label: '在资源管理器中显示', click: () => electronShell.showItemInFolder(it.path) },
      { label: '复制文件路径', click: () => clipboard.writeText(it.path) },
      { label: '复制文件名', click: () => clipboard.writeText(it.name || '') },
      { type: 'separator' },
      {
        label: it.hasSubs ? '绑定外挂字幕' : '无外挂字幕',
        enabled: !!it.hasSubs,
        click: () => {
          const subs = findCompanions(it.path).subs;
          if (subs.length && player) player.command('sub-add', subs[0]);
        },
      },
      { type: 'separator' },
      { label: '从列表中隐藏', click: () => hideItemDirect(it.path) },
      { label: '重命名…', click: () => sidebar.send('item:rename:begin', it.path) },
      { type: 'separator' },
      { label: '移到回收站', click: () => {
        try { electronShell.trashItem(it.path); } catch (e) { /* 忽略 */ }
        setTimeout(() => { if (state.library.dir) loadFolder(state.library.dir); }, 800);
      } },
    ];
    Menu.buildFromTemplate(template).popup({ window: shellWin });
  });

  // ---- 播放 ----
  ipcMain.on('play:index', (_e, index) => playIndex(index));
  ipcMain.on('play:file', (_e, file) => {
    // 拖放进来的文件：不在列表里也能直接播
    state.playback.path = file;
    state.playback.title = path.basename(file);
    const idx = libraryItems.findIndex((it) => it.path === file);
    state.playback.index = idx;
    eofHandled = false;
    if (player) {
      player.loadFile(file);
      player.pause(false);
    }
    sendState();
  });
  ipcMain.on('play:toggle', () => {
    hideMenu();
    // 乐观更新：界面先翻转，命令异步下发（不等内核处理完）
    state.playback.paused = !state.playback.paused;
    sendState();
    if (player) player.playPause();
    kickActivity();
  });
  ipcMain.on('play:seek', (_e, sec) => { if (player) player.seekAbsolute(sec); kickActivity(); });
  ipcMain.on('play:offset', (_e, sec) => { if (player) player.seek(sec); kickActivity(); });
  ipcMain.on('play:volume', (_e, v) => {
    state.playback.volume = Math.max(0, Math.min(130, v));
    if (player) player.setVolume(state.playback.volume);
    if (store) store.set('volume', state.playback.volume);
    kickActivity();
    // 拖动时每帧都会来，广播限流，避免几十次跨进程推送
    const now = Date.now();
    if (now - lastVolSend >= 50) {
      lastVolSend = now;
      sendState();
    }
  });
  ipcMain.on('play:mute', (_e, on) => {
    state.playback.muted = !!on;
    if (player) player.setMute(state.playback.muted);
    if (store) store.set('muted', state.playback.muted);
    kickActivity();
    sendState();
  });
  ipcMain.on('play:next', () => { playOffset(1); kickActivity(); });
  ipcMain.on('play:prev', () => { playOffset(-1); kickActivity(); });
  ipcMain.on('play:stop', () => { if (player) player.stop(); kickActivity(); });

  // ---- 倍速 ----
  ipcMain.on('play:speed', (_e, v) => {
    const speed = Math.max(0.05, Math.min(8, Number(v) || 1));
    state.playback.speed = speed;      // 乐观更新，属性观察随后会确认
    if (player) player.setSpeed(speed);
    hideMenu();
    kickActivity();
    sendState();
  });
  ipcMain.on('menu:speed', (_e, anchor) => toggleMenu(anchor || { x: 0, y: 0, w: 0 }));
  ipcMain.on('menu:close', () => hideMenu());

  // ---- 长按快进/快退穿梭 ----
  ipcMain.on('hold:start', (_e, dir) => beginHold(dir > 0 ? 1 : -1));
  ipcMain.on('hold:end', () => endHold());

  // ---- 进度条擦洗（Scrubbing）----
  ipcMain.on('scrub:start', () => { beginScrub(); kickActivity(); });
  ipcMain.on('scrub:move', (_e, time) => moveScrub(time));
  ipcMain.on('scrub:end', (_e, time) => { endScrub(time); kickActivity(); });

  // ---- 悬停缩略图 ----
  ipcMain.on('preview:show', (_e, data) => {
    const d = data || {};
    showPreview(d.x || 0, d.time || 0);
    kickActivity();
  });
  ipcMain.on('preview:move', (_e, data) => {
    const d = data || {};
    movePreviewThumb(d.time || 0);
  });
  ipcMain.on('preview:hide', () => hidePreview());

  // ---- 画中画 ----
  ipcMain.on('win:pip', () => togglePip());
  ipcMain.on('play:reveal', (_e, file) => {
    if (file) electronShell.showItemInFolder(file);
  });

  // ---- 交互活性 ----
  ipcMain.on('activity', () => kickActivity());
  ipcMain.on('controls:hover', (_e, on) => {
    controlsHovered = on;
    if (on) kickActivity();
  });
  ipcMain.on('win:focus', () => {
    if (!state.ui.active) { state.ui.active = true; sendState(); }
  });

  // ---- 主题 ----
  ipcMain.on('theme', (_e, pref) => {
    state.themePref = pref || 'auto';
    if (store) store.set('theme', state.themePref);
    applyTheme();
  });
}

// ------------------------------------------------------------- 主题 ---

function applyTheme() {
  const pref = state.themePref;
  nativeTheme.themeSource = pref === 'auto' ? 'system' : pref;
  state.theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  if (shellWin && !shellWin.isDestroyed()) {
    shellWin.setBackgroundColor(state.theme === 'dark' ? '#1b1b1d' : '#ececec');
  }
  // 只有「整面矩形」的浮层适合用系统磨砂：
  // 悬浮胶囊和缩略图带圆角，磨砂会把轮廓糊成矩形，它们走自己的半透明材质。
  for (const p of [sidebar, menu]) {
    if (!p) continue;
    if (p === sidebar) {
      applySidebarMaterial(true);
    } else {
      p.setAcrylic(state.ui.acrylic, acrylicTint());
    }
    p.send('material', { acrylic: p.acrylic, theme: state.theme });
  }
  sendState();
}

/**
 * 磨砂材质只在「真的需要变」的时候才重设。
 *
 * 之前每次开合侧边栏都会重设一遍 SetWindowCompositionAttribute，
 * 窗口因此重新合成一次 —— 肉眼看到的就是「点一下按钮闪一下」。
 */
function applySidebarMaterial(force = false) {
  if (!sidebar) return;
  const want = !!state.ui.acrylic;
  if (!force && sidebar.materialState === want && sidebar.materialTint === state.theme) return;
  sidebar.setAcrylic(want, acrylicTint());
  sidebar.materialState = want;
  sidebar.materialTint = state.theme;
}

// -------------------------------------------------------------- 启动 ---

function boot() {
  store = new Store();

  state.sidebar.width = store.get('sidebarWidth');
  state.sidebar.layout = store.get('layout') === 'push' ? 'push' : 'overlay';
  state.sidebar.open = !!store.get('sidebarOpen');
  state.themePref = store.get('theme') || 'auto';
  state.library.recursive = store.get('recursive') !== false;
  state.playback.volume = store.get('volume');
  state.playback.muted = !!store.get('muted');
  // 目录多路管理 & 播放偏好
  state.library.recent = store.get('recentFolders') || [];
  state.library.pinned = store.get('pinnedFolders') || [];
  state.library.sort = store.get('sortBy') || 'name';
  state.library.hideExt = !!store.get('hideExt');
  state.library.compact = !!store.get('compact');
  state.library.hidden = store.get('hiddenItems') || [];
  state.library.playMode = store.get('playMode') || 'sequence';
  progressMap = store.get('progress') || Object.create(null);

  createShell();
  initPlayer();
  createOverlays();
  bindIpc();

  applyTheme();
  state.theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  nativeTheme.on('updated', () => {
    if (state.themePref === 'auto') {
      state.theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      applyTheme();
    }
  });

  // mpv 事件泵（60fps 排空事件队列，真正的驱动是 mpv 的属性观察）
  setInterval(() => {
    if (quitting) return;
    if (player) player.pump(handlePlayerEvent);
    if (probe) probe.pump((ev) => probe.handleEvent(ev));
  }, 16);

  // 显示器变化：插拔 / 改分辨率 / 改缩放
  screen.on('display-metrics-changed', () => {
    scheduleFollow();
    syncDisplay({ forceFit: true });   // 工作区尺寸变了，窗口可能装不下
  });
  screen.on('display-added', () => syncDisplay());
  screen.on('display-removed', () => syncDisplay({ forceFit: true }));

  // 跨屏 / 缩放变化的兜底：事件可能晚一拍，也可能压根不来（Win+方向键等）
  setInterval(() => {
    if (quitting) return;
    syncDisplay();
  }, 500);

  // 播完轮询（250ms）。
  // keep-open 下 mpv 并不保证为 eof-reached 主动发属性变更通知，
  // 所以属性观察只是「快路径」，真正兜底的是这里的低频轮询。
  setInterval(() => {
    if (quitting) return;
    if (!state.playback.idle) maybeEnded();
  }, 250);

  // 兜底看门狗：若某版 mpv 的属性事件投递异常，退化为低频刷新，UI 不至于僵住
  setInterval(() => {
    if (quitting) return;
    const playing = !state.playback.idle && !state.playback.paused;
    if (playing && Date.now() - lastPropertyEventAt > 1500) refreshPlayback(false);
  }, 1000);

  kickActivity();

  // 恢复上次目录
  const last = store.get('lastDir');
  if (last) loadFolder(last);
  if (state.sidebar.open) {
    setTimeout(() => openSidebar(true), 300);
  }

  if (process.env.AQUA_DEBUG) {
    setTimeout(async () => {
      const fs = require('fs');
      for (const [name, p] of [['sidebar', sidebar], ['controls', controls], ['menu', menu]]) {
        if (!p) continue;
        try {
          const img = await p.win.webContents.capturePage();
          fs.writeFileSync(path.join(ROOT, 'dbg_' + name + '.png'), img.toPNG());
          console.log('[dbg] 已截取 ' + name + ' 渲染层内容');
        } catch (e) {
          console.log('[dbg] ' + name + ' 截取失败: ' + e.message);
        }
      }
    }, 2500);

    // 自动播放第一项：验证「列表点击 → mpv 载入 → 出画」整条链路
    setTimeout(() => {
      if (libraryItems.length) {
        console.log('[dbg] 自动播放第 0 项：' + libraryItems[0].name);
        playIndex(0);
      } else {
        console.log('[dbg] 目录为空，跳过自动播放');
      }
    }, 3200);
    setTimeout(() => {
      const p = state.playback;
      console.log(`[dbg] 播放状态 timePos=${p.timePos} duration=${p.duration} ` +
        `paused=${p.paused} idle=${p.idle} title=${p.title}`);
    }, 6500);

    // 模拟"点击列表项"：高频采样侧边栏窗口的可见性，检测是否闪烁
    setTimeout(() => {
      if (libraryItems.length < 2) return;
      console.log('[dbg] 模拟点击列表项（切换播放）…');
      playIndex(1);
      let last = sidebar.visible;
      const changes = [];
      const t0 = Date.now();
      const iv = setInterval(() => {
        const v = sidebar.visible;
        if (v !== last) {
          changes.push(`${Date.now() - t0}ms:${last ? '可见' : '隐藏'}→${v ? '可见' : '隐藏'}`);
          last = v;
        }
        if (Date.now() - t0 > 2600) {
          clearInterval(iv);
          console.log('[dbg] 点击后 2.6s 内可见性变化: ' +
            (changes.length ? changes.join(' | ') : '无（不闪）'));
        }
      }, 25);
    }, 5000);

    // 侧边栏显隐的确定性自测：完全走"点按钮"的那条路径
    // （按窗口真实可见性翻转），收起 → 再点 → 展开，不需要真人去点。
    setTimeout(() => {
      const before = sidebar.visible;
      setSidebarVisible(!before);            // 第一次点
      setTimeout(() => {
        const v1 = sidebar.visible;
        setSidebarVisible(!v1);              // 第二次点
        setTimeout(() => {
          const v2 = sidebar.visible;
          console.log(`[sidebar] 自测(模拟点击): 窗口可见 ${before} → ${v1} → ${v2}，` +
            `状态 open=${state.sidebar.open}` +
            (v1 === !before && v2 === before ? ' ✅ 通过' : ' ❌ 失败'));
        }, 520);
      }, 520);
    }, 4000);

    // 抓取主窗口的真实屏幕内容（含原生视频子窗口，PrintWindow 抓不到 GPU 画面）
    setTimeout(async () => {
      try {
        const { desktopCapturer } = require('electron');
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 1280, height: 800 },
        });
        const hit = sources.find((s) => /视频播放器|AQUA|mpv/i.test(s.name));
        if (hit) {
          require('fs').writeFileSync(path.join(ROOT, 'dbg_window.png'), hit.thumbnail.toPNG());
          console.log('[dbg] 已抓取窗口画面：' + hit.name);
        }
        // 视频承载窗口是独立的顶层窗口，要单独抓
        const surf = sources.find((s) => /mpv-surface|mpv/i.test(s.name));
        if (surf) {
          require('fs').writeFileSync(path.join(ROOT, 'dbg_surface.png'), surf.thumbnail.toPNG());
          console.log('[dbg] 已抓取视频画面：' + surf.name);
        } else {
          console.log('[dbg] 候选窗口：' +
            sources.map((s) => s.name).filter((n) => n.trim()).join(' | '));
        }
        if (!hit) {
          console.log('[dbg] 没找到主窗口，候选：' +
            sources.map((s) => s.name).filter((n) => n.trim()).join(' | '));
        }
      } catch (e) {
        console.log('[dbg] 抓取窗口失败：' + e.message);
      }

      // 直接向内核要一张当前帧：能出图就说明 VO 真的在渲染
      if (player) {
        try {
          const shot = path.join(app.getPath('temp'), 'aq_frame.png');
          player.command('screenshot-to-file', shot, 'video');
          setTimeout(() => {
            try {
              if (require('fs').existsSync(shot)) {
                require('fs').copyFileSync(shot, path.join(ROOT, 'dbg_frame.png'));
                require('fs').unlinkSync(shot);
                console.log('[dbg] 已取到当前帧 dbg_frame.png');
              } else {
                console.log('[dbg] 截图命令没有产出文件');
              }
            } catch (e) { /* 忽略 */ }
          }, 900);
        } catch (e) { /* 忽略 */ }
      }

      // 诊断：承载窗口 / 它的子窗口树 / mpv 的 VO 状态
      if (player) {
        const kids = win32.children(containerHwnd).map((k) => ({
          cls: k.cls, rect: k.rect,
        }));
        console.log('[dbg] 承载窗口 rect=' + JSON.stringify(win32.getRect(containerHwnd)));
        console.log('[dbg] 承载窗口的子窗口=' + JSON.stringify(kids));
        const shellKids = win32.children(shellHwnd).map((k) => ({
          cls: k.cls, rect: k.rect,
        }));
        console.log('[dbg] 外壳子窗口(z序从上到下)=' + JSON.stringify(shellKids));
        console.log('[dbg] 承载窗口的z序邻居: 上=' +
          JSON.stringify(win32.neighbour(containerHwnd, 3)) +
          ' 下=' + JSON.stringify(win32.neighbour(containerHwnd, 2)));
        console.log('[dbg] 侧边栏的z序邻居: 上=' +
          JSON.stringify(win32.neighbour(sidebar.hwnd, 3)) +
          ' 下=' + JSON.stringify(win32.neighbour(sidebar.hwnd, 2)));
        console.log('[dbg] vo-configured=' + player.getFlag('vo-configured') +
          ' video-params=' + JSON.stringify(player.videoSize()) +
          ' time-pos=' + player.getDouble('time-pos'));
      }
    }, 7500);
  }
}

app.whenReady().then(() => {
  try {
    boot();
  } catch (e) {
    console.error('启动失败', e);
    dialog.showErrorBox('启动失败', e.stack || e.message);
  }
});

app.on('before-quit', () => {
  quitting = true;
  if (sidebarTween) sidebarTween.cancel();
  if (holdTimer) clearInterval(holdTimer);
  if (probe) probe.destroy();
  if (thumb) thumb.destroy();
  if (player) player.destroy();
  if (previewContainer) win32.destroyWindow(previewContainer);
  if (containerHwnd) win32.destroyWindow(containerHwnd);
  if (store) store.flushNow();
});

app.on('window-all-closed', () => {
  app.quit();
});
