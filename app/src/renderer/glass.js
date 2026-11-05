'use strict';

/**
 * 输入玻璃层逻辑。
 * 这一层盖在视频之上，所以视频区的全部鼠标行为都由它接管：
 * 唤醒界面 / 边缘悬停唤出侧边栏 / 单击暂停 / 双击全屏 / 滚轮音量 / 拖放播放。
 */

const $ = (sel) => document.querySelector(sel);

const PEEK_ZONE = 10;    // 右侧边缘触发区宽度
const TOP_ZONE = 6;      // 全屏时顶部唤出标题栏的触发区

let state = null;
let lastActivity = 0;
let peekOn = false;
let osdTimer = null;
let toastTimer = null;
let lastPaused = null;
let lastVolume = null;

function applyState(next) {
  const prev = state;
  state = next;
  document.documentElement.dataset.theme = state.theme;
  document.body.classList.toggle('idle', !!state.ui.chromeHidden);

  // 暂停/播放状态变化 → 中间闪一下大图标
  if (prev && state.playback.paused !== lastPaused) {
    lastPaused = state.playback.paused;
    showOsd(state.playback.paused ? 'play' : 'pause');
  }
  if (lastPaused === null) lastPaused = state.playback.paused;

  // 音量变化 → 顶部胶囊提示
  if (state.playback.volume !== lastVolume) {
    lastVolume = state.playback.volume;
    if (state.playback.muted) showToast('已静音');
    else showToast('音量 ' + Math.round(state.playback.volume) + '%');
  }
}

function showOsd(name) {
  const el = $('#osd');
  el.innerHTML = '<span class="icon">' + icon(name) + '</span>';
  el.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove('show'), 480);
}

function showToast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 900);
}

/** 鼠标一有动静就通知主进程：重置沉浸计时器。 */
function notifyActivity() {
  const now = Date.now();
  if (now - lastActivity < 150) return;
  lastActivity = now;
  aqua.send('activity');
}

function main() {
  // ---- 鼠标移动：唤醒 + 边缘感知 ----
  window.addEventListener('mousemove', (e) => {
    notifyActivity();

    // 右侧边缘停留 → 唤出侧边栏（主进程里做 300ms 延迟判定）
    const nearRight = e.clientX >= window.innerWidth - PEEK_ZONE;
    if (nearRight !== peekOn) {
      peekOn = nearRight;
      aqua.send('sidebar:peek-start', nearRight);
    }
  });

  window.addEventListener('mouseleave', () => {
    if (peekOn) {
      peekOn = false;
      aqua.send('sidebar:peek-start', false);
    }
  });

  // ---- 单击暂停 / 双击全屏 ----
  window.addEventListener('click', (e) => {
    // 双击会先触发一次 click，两次 cycle pause 正好互相抵消
    aqua.send('play:toggle');
    notifyActivity();
    e.preventDefault();
  });

  window.addEventListener('dblclick', () => {
    aqua.send('win', 'fullscreen');
    notifyActivity();
  });

  // ---- 滚轮调音量 ----
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cur = state ? state.playback.volume : 70;
    aqua.send('play:volume', cur + (e.deltaY < 0 ? 3 : -3));
    notifyActivity();
  }, { passive: false });

  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- 拖放播放 ----
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.path) aqua.send('play:file', f.path);
  });

  // 键盘：焦点在这一层时也要能用
  bindHotkeys({
    getVolume: () => (state ? state.playback.volume : 70),
    onEscape: () => {
      if (state && state.ui.fullscreen) aqua.send('win', 'fullscreen');
    },
  });

  document.addEventListener('visibilitychange', () => notifyActivity());
}

async function boot() {
  const init = await aqua.init();
  applyState(init.state);
  aqua.on('state', applyState);
  main();
}

boot();
