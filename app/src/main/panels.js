'use strict';

/**
 * 浮层窗口层。
 *
 * 为什么侧边栏/控制条必须是独立窗口，而不是网页里的 div：
 *   mpv 的画面是一个原生子窗口（HWND），它永远盖在网页内容之上；
 *   任何想「浮在视频之上」的 UI，都只能做成一个独立的、盖在外壳窗口之上的窗口。
 *   好处是这类窗口可以直接调用系统的 Acrylic 磨砂材质，
 *   真正模糊它背后的视频画面（CSS backdrop-filter 做不到）。
 *
 * 同时提供苹果那套缓动曲线与宽度动画。
 */

const path = require('path');
const { BrowserWindow } = require('electron');
const win32 = require('./win32');

// ------------------------------------------------------------ 缓动曲线 ---

/** 把 CSS 的 cubic-bezier 变成 JS 求值函数（牛顿迭代 + 二分兜底）。 */
function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const s = slope(t, x1, x2);
      if (s === 0) break;
      const d = calc(t, x1, x2) - x;
      t -= d / s;
    }
    // 兜底二分
    let lo = 0, hi = 1;
    t = Math.min(1, Math.max(0, t));
    for (let i = 0; i < 20; i++) {
      const v = calc(t, x1, x2);
      if (Math.abs(v - x) < 1e-5) break;
      if (v > x) hi = t; else lo = t;
      t = (lo + hi) / 2;
    }
    return calc(t, y1, y2);
  };
}

/** 苹果标准「进出场」曲线：起步快、刹车平缓，带一丝阻尼感。 */
const EASE_APPLE = cubicBezier(0.16, 1, 0.3, 1);
const EASE_OUT = cubicBezier(0.22, 0.61, 0.36, 1);

/**
 * 补间动画。主进程没有 requestAnimationFrame，用 16ms 定时器按 performance.now 求值，
 * 这样即使某帧被卡住，位置也不会累积漂移。
 */
function tween({ from, to, duration = 280, easing = EASE_APPLE, onFrame, onDone }) {
  let timer = null;
  const t0 = process.hrtime.bigint();
  const total = BigInt(Math.round(duration * 1e6));

  function step() {
    const elapsed = Number(process.hrtime.bigint() - t0) / 1000; // µs → ms
    let p = Math.min(1, Number(elapsed) / duration);
    if (!isFinite(p)) p = 1;
    const e = easing(p);
    onFrame(from + (to - from) * e, e, p);
    if (p < 1) {
      timer = setTimeout(step, 16);
    } else if (onDone) {
      onDone();
    }
  }
  step();

  return {
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get duration() { return duration; },
  };
}

// -------------------------------------------------------- 浮层窗口封装 ---

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

/**
 * @param spec.file    渲染页面文件名（位于 renderer 目录）
 * @param spec.width   初始宽（DIP）
 * @param spec.height  初始高（DIP）
 * @param spec.parent  外壳窗口（设置 parent 后由 Windows 保证它永远在壳之上，
 *                     且壳最小化时自动隐藏，不会抢占其它应用的 z 序）
 * @param spec.acrylic 是否启用系统磨砂
 * @param spec.mouse   是否接收鼠标（glass 需要接收，透明提示层不需要）
 */
function createOverlay(spec) {
  const win = new BrowserWindow({
    width: spec.width,
    height: spec.height,
    x: spec.x || 0,
    y: spec.y || 0,
    parent: spec.parent,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    focusable: spec.focusable !== false,
    hasShadow: false,
    roundedCorners: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(RENDERER_DIR, spec.file));
  win.setMenuBarVisibility(false);

  // 诊断：渲染层报错直接打到主进程 stdout，方便排障
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 || process.env.AQUA_DEBUG) {
      console.log(`[${spec.name}][L${level}] ${message} (${sourceId}:${line})`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[${spec.name}] 加载失败 ${code} ${desc} ${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[${spec.name}] 渲染进程退出: ${details.reason}`);
  });
  win.webContents.on('did-finish-load', () => {
    if (process.env.AQUA_DEBUG) console.log(`[${spec.name}] 页面加载完成`);
  });

  const api = {
    win,
    name: spec.name,
    acrylic: false,
    // 句柄立刻取好：拖拽调宽时要用它做鼠标捕获（SetCapture）
    hwnd: win32.hwndFromBuffer(win.getNativeWindowHandle()),
    visible: false,
    fadeTimer: null,

    /** 取消正在进行的淡出动画（重新显示前必须调用，否则不透明度会被继续压到 0） */
    cancelFade() {
      if (api.fadeTimer) {
        clearInterval(api.fadeTimer);
        api.fadeTimer = null;
      }
    },

    /** 淡出并隐藏 */
    fadeOut(ms = 220) {
      api.cancelFade();
      const steps = Math.max(1, Math.round(ms / 16));
      let i = 0;
      api.fadeTimer = setInterval(() => {
        i++;
        win.setOpacity(Math.max(0, 1 - i / steps));
        if (i >= steps) {
          clearInterval(api.fadeTimer);
          api.fadeTimer = null;
          win.setOpacity(1);
          win.hide();
          api.visible = false;
        }
      }, 16);
    },

    /** 打开系统磨砂材质。tint 为 0xAABBGGRR。 */
    setAcrylic(enable, tint) {
      if (!api.hwnd) api.hwnd = win32.hwndFromBuffer(win.getNativeWindowHandle());
      api.acrylic = win32.setAcrylic(api.hwnd, enable, tint);
      return api.acrylic;
    },

    setBounds(rect) {
      if (win.isDestroyed()) return;
      const r = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
      const cur = win.getBounds();
      if (cur.x === r.x && cur.y === r.y && cur.width === r.width && cur.height === r.height) return;
      win.setBounds(r);
    },

    show() {
      if (win.isDestroyed()) return;
      api.cancelFade();
      if (!api.visible) {
        win.showInactive(); // 不抢焦点，避免点击视频时焦点来回跳
        api.visible = true;
      }
      win.setOpacity(1);
    },

    hide() {
      if (win.isDestroyed()) return;
      api.cancelFade();
      if (api.visible) {
        win.hide();
        api.visible = false;
      }
    },

    setOpacity(v) {
      if (!win.isDestroyed()) win.setOpacity(Math.max(0, Math.min(1, v)));
    },

    /** 让鼠标穿透（只有纯提示层需要）。 */
    ignoreMouse(ignore) {
      if (win.isDestroyed()) return;
      win.setIgnoreMouseEvents(!!ignore, { forward: true });
    },

    send(channel, payload) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
  };

  return api;
}

module.exports = { createOverlay, tween, cubicBezier, EASE_APPLE, EASE_OUT, RENDERER_DIR };
