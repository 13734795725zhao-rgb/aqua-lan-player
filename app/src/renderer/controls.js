'use strict';

/**
 * 悬浮胶囊播控条。
 *
 * 性能纪律：
 *  1. 内核指令 fire-and-forget，主进程乐观更新后立刻广播，界面不等 mpv。
 *  2. 高频更新（time-pos）只喂给「进度条 + 时间码」微组件，不牵连外层重绘。
 *  3. 按键高亮只用局部 background/opacity，不改外层磨砂容器的任何属性。
 *
 * 职责边界：这里只放播放级功能；系统级功能（侧边栏/画中画/全屏）都在顶栏。
 */

const $ = (sel) => document.querySelector(sel);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

let state = null;
let seeking = false;
let seekPreview = 0;
let timeMode = 'elapsed';
let lastMoveSent = 0;

function fmt(sec) {
  if (!sec || !isFinite(sec) || sec < 0) sec = 0;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

// -------------------------------------------- 微组件：进度条（高频区） ---
const Progress = {
  fill: null, knob: null, cur: null, sep: null, total: null,
  lastRatio: -1, lastText: '',

  init() {
    this.fill = $('#scrubfill');
    this.knob = $('#scrubknob');
    this.cur = $('#t-elapsed');
    this.sep = $('.t-sep');
    this.total = $('#t-total');
  },

  update(pos, duration) {
    const r = clamp01(duration > 0 ? pos / duration : 0);
    if (Math.abs(r - this.lastRatio) > 0.0004) {
      this.lastRatio = r;
      this.fill.style.width = (r * 100) + '%';
      this.knob.style.left = (r * 100) + '%';
    }
    const text = timeMode === 'remaining'
      ? '-' + fmt(Math.max(0, duration - pos)) : fmt(pos);
    if (text !== this.lastText) {
      this.lastText = text;
      this.cur.textContent = text;
    }
    if (timeMode === 'elapsed') {
      const t = fmt(duration);
      if (this.total.textContent !== t) this.total.textContent = t;
    }
  },

  setMode(mode) {
    timeMode = mode;
    this.lastText = '';
    this.lastRatio = -1;
    const remaining = mode === 'remaining';
    this.sep.style.display = remaining ? 'none' : '';
    this.total.style.display = remaining ? 'none' : '';
  },
};

// ------------------------------------------------ 微组件：音量（低频） ---
const Volume = {
  fill: null, knob: null, last: -1,
  init() {
    this.fill = $('#volfill');
    this.knob = $('#volknob');
  },
  update(v, muted) {
    const r = clamp01((muted ? 0 : v) / 100);
    if (Math.abs(r - this.last) < 0.002) return;
    this.last = r;
    this.fill.style.width = (r * 100) + '%';
    this.knob.style.left = (r * 100) + '%';
  },
};

// ------------------------------------------------ 微组件：倍速（低频） ---
const Speed = {
  text: null, btn: null, last: -1,
  init() {
    this.text = $('#speed-text');
    this.btn = $('#speed');
  },
  update(v) {
    const speed = Number(v) || 1;
    if (Math.abs(speed - this.last) < 0.001) return;
    this.last = speed;
    this.text.textContent =
      (Math.abs(speed - Math.round(speed)) < 0.01 ? speed.toFixed(1) : String(speed)) + 'x';
    this.btn.classList.toggle('modified', Math.abs(speed - 1) > 0.01);
  },
};

// -------------------------------------- 外壳：离散状态才重绘图标 ---
let lastChromeSig = '';

function paintChrome(s) {
  const p = s.playback;
  const sig = `${p.paused}|${p.muted}`;
  if (sig === lastChromeSig) return;
  lastChromeSig = sig;
  $('#play').querySelector('.icon').innerHTML = icon(p.paused ? 'play' : 'pause');
  $('#mute').querySelector('.icon').innerHTML =
    icon(p.muted ? 'speakerMute' : 'speaker');
}

function applyState(next) {
  state = next;
  // 高频：只有进度/时间在动
  Progress.update(seeking ? seekPreview : next.playback.timePos, next.playback.duration);
  // 低频：音量 / 倍速，值没变就不碰 DOM
  Volume.update(next.playback.volume, next.playback.muted);
  Speed.update(next.playback.speed);
  paintChrome(next);
}

// ============================================================== 进度条 ===
function scrubMeta() {
  return {
    track: $('#scrubline').getBoundingClientRect(),
    duration: (state && state.playback.duration) || 0,
  };
}

function ratioAt(clientX) {
  const { track } = scrubMeta();
  return track.width ? clamp01((clientX - track.left) / track.width) : 0;
}

function startScrubDrag(e) {
  e.preventDefault();
  seeking = true;
  $('#scrub').classList.add('active');
  aqua.send('activity');
  aqua.send('scrub:start');

  const duration = scrubMeta().duration;
  seekPreview = ratioAt(e.clientX) * duration;
  Progress.update(seekPreview, duration);
  aqua.send('preview:show', { x: e.clientX, time: seekPreview });
  aqua.send('scrub:move', seekPreview);

  const move = (ev) => {
    const d = scrubMeta().duration;
    seekPreview = ratioAt(ev.clientX) * d;
    Progress.update(seekPreview, d);
    aqua.send('scrub:move', seekPreview);
    const now = Date.now();
    if (now - lastMoveSent > 30) {
      lastMoveSent = now;
      aqua.send('preview:move', { time: seekPreview });
    }
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    $('#scrub').classList.remove('active');
    seeking = false;
    const d = scrubMeta().duration;
    const t = ratioAt(ev.clientX) * d;
    aqua.send('scrub:end', t);
    aqua.send('preview:hide');
    Progress.update(t, d);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function bindScrub() {
  const scrub = $('#scrub');
  scrub.addEventListener('pointerdown', startScrubDrag);

  // 悬停：弹出缩略图（只发指令，不做重绘）
  scrub.addEventListener('pointermove', (e) => {
    if (seeking) return;
    const d = scrubMeta().duration;
    aqua.send('preview:show', { x: e.clientX, time: ratioAt(e.clientX) * d });
  });
  scrub.addEventListener('pointerleave', () => {
    if (!seeking) aqua.send('preview:hide');
  });

  // 音量：拖动时本地先动（乐观），命令异步下发
  const volwrap = $('#volwrap');
  const vol = $('#vol');
  const track = $('#vol .track');
  const handle = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const r = clamp01((clientX - rect.left) / rect.width);
    Volume.update(r * 100, false);
    aqua.send('play:volume', Math.round(r * 100));
  };
  vol.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    volwrap.classList.add('dragging');
    aqua.send('activity');
    handle(e.clientX);
    const move = (ev) => handle(ev.clientX);
    const up = () => {
      volwrap.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** 长按穿梭：按下先走一次 ±10s，按住越久跳得越快 */
function bindHold(id, dir) {
  const el = $(id);
  let held = false;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    held = true;
    el.classList.add('holding');
    aqua.send('activity');
    aqua.send('hold:start', dir);
  });
  window.addEventListener('pointerup', () => {
    if (!held) return;
    held = false;
    el.classList.remove('holding');
    aqua.send('hold:end');
  });
}

function bindUI() {
  $('#back10').querySelector('.icon').innerHTML = icon('backward10');
  $('#fwd10').querySelector('.icon').innerHTML = icon('forward10');

  Progress.init();
  Volume.init();
  Speed.init();

  bindScrub();
  bindHold('#back10', -1);
  bindHold('#fwd10', 1);

  $('#play').addEventListener('click', () => aqua.send('play:toggle'));
  $('#mute').addEventListener('click', () => {
    aqua.send('play:mute', !(state && state.playback.muted));
  });

  // 倍速：把按钮在窗口内的位置交给主进程，由它决定菜单浮在哪
  $('#speed').addEventListener('click', () => {
    const r = $('#speed').getBoundingClientRect();
    aqua.send('menu:speed', { x: r.left, y: r.top, w: r.width });
  });

  // 时间码：一键切换「已播/总长」与「剩余倒计时」
  $('#time').addEventListener('click', () => {
    Progress.setMode(timeMode === 'elapsed' ? 'remaining' : 'elapsed');
    const p = state ? state.playback : { timePos: 0, duration: 0 };
    Progress.update(seeking ? seekPreview : p.timePos, p.duration);
    aqua.send('activity');
  });

  // 只有真正悬停在胶囊/进度条上时才阻止沉浸模式收起
  for (const el of [$('.pill'), $('#scrub')]) {
    el.addEventListener('mouseenter', () => aqua.send('controls:hover', true));
    el.addEventListener('mouseleave', () => aqua.send('controls:hover', false));
  }
  $('#bar').addEventListener('mousemove', () => aqua.send('activity'));

  bindHotkeys({
    getVolume: () => (state ? state.playback.volume : 70),
    getSpeed: () => (state ? state.playback.speed : 1),
    onEscape: () => {
      aqua.send('menu:close');
      if (state && state.ui.fullscreen) aqua.send('win', 'fullscreen');
    },
  });
}

async function boot() {
  const init = await aqua.init();
  state = init.state;
  bindUI();
  applyState(state);
  aqua.on('state', applyState);
}

boot();
