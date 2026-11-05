'use strict';

/**
 * 外壳窗口（主窗口）渲染层。
 *
 * 职责边界（苹果正交原则）：
 *   顶栏 = 全局与上下文：交通灯、当前文件名、侧边栏折叠、画中画、全屏、外观
 *   底栏 = 内容本身：进度、播放/暂停、快退快进、音量、倍速
 * 同一个功能在整个视口里只存在一个控制点，两边不重复。
 *
 * 视频画面是盖在 .stage 之上的原生子窗口，这里碰不到它。
 */

const $ = (sel) => document.querySelector(sel);

let state = null;
let lastSig = '';

function applyState(next) {
  state = next;
  const root = document.documentElement;
  root.dataset.theme = state.theme;

  // 标题显示当前文件名（没在播放时显示应用名）
  const title = state.playback.title || '视频播放器';
  if ($('#title').textContent !== title) $('#title').textContent = title;

  $('#lights').classList.toggle('inactive', !state.ui.active);
  document.body.classList.toggle('chrome-hidden', !!state.ui.chromeHidden);

  // 图标只在相关状态变化时重绘（状态广播是 20fps，别每帧重建 DOM）
  const sig = `${state.sidebar.open}|${state.ui.fullscreen}|${state.ui.pip}`;
  if (sig !== lastSig) {
    lastSig = sig;
    // 只切 class，不重建 innerHTML —— 重建会把手上的点击目标换掉，
    // 正是「点了按钮没反应」的经典成因之一。
    $('#btn-sidebar').classList.toggle('on', !!state.sidebar.open);
    $('#btn-fs').innerHTML = '<span class="icon">' +
      icon(state.ui.fullscreen ? 'exitFullscreen' : 'fullscreen') + '</span>';
    $('#btn-pip').innerHTML = '<span class="icon">' +
      icon(state.ui.pip ? 'pipExit' : 'pip') + '</span>';
    $('#btn-pip').classList.toggle('on', !!state.ui.pip);
  }
}

async function boot() {
  const init = await aqua.init();
  applyState(init.state);

  aqua.on('state', applyState);

  // 交通灯
  $('#lights').addEventListener('click', (e) => {
    const btn = e.target.closest('.light');
    if (!btn) return;
    aqua.send('win', btn.dataset.act);
  });

  // 图标**不随状态变化**的按钮：只在初始化时画一次。
  // （侧栏 / 外观按钮以前放在每次状态广播里重设 innerHTML，
  //   后来为了不让重建 innerHTML 吃掉点击把它们整个删掉了 —— 结果按钮成空的。
  //   这里一次画好，之后只切 class。）
  $('#btn-sidebar').innerHTML =
    '<span class="icon">' + icon('sidebarRight') + '</span>';
  $('#btn-theme').innerHTML = '<span class="icon">' + icon('video') + '</span>';

  // 侧栏按钮：发送**目标状态**而不是盲目取反，并阻止冒泡。
  // 1) 明确意图：主进程按"要展开"来执行，不会出现状态来回翻转；
  // 2) 阻止冒泡：避免外层的全局监听（点击空白关闭 / 快捷键）二次触发，
  //    一次点击变成"展开→立即收起"，肉眼看就是闪一下。
  $('#btn-sidebar').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    // 只表达"翻转"意图，目标状态由主进程按窗口真实可见性判定 ——
    // 避免渲染层的状态副本与主进程的窗口实际状态不一致时发出反向指令。
    aqua.send('sidebar:set', null);
  });
  $('#btn-pip').addEventListener('click', () => aqua.send('win:pip'));
  $('#btn-fs').addEventListener('click', () => aqua.send('win', 'fullscreen'));
  $('#btn-theme').addEventListener('click', () => {
    const order = ['auto', 'dark', 'light'];
    const i = order.indexOf(state.themePref);
    aqua.send('theme', order[(i + 1) % order.length]);
  });

  // 双击标题栏最大化（macOS 习惯）
  $('#titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    aqua.send('win', 'max');
  });

  // 拖文件进来直接播
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.path) aqua.send('play:file', f.path);
  });

  bindHotkeys({
    getVolume: () => (state ? state.playback.volume : 70),
    getSpeed: () => (state ? state.playback.speed : 1),
    onEscape: () => {
      if (state && state.ui.fullscreen) aqua.send('win', 'fullscreen');
    },
  });
}

boot();
