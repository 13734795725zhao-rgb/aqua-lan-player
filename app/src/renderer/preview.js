'use strict';

/** 缩略图窗口只负责显示时间码，帧画面是同窗口里的原生 mpv 子窗口画的。 */

const $ = (sel) => document.querySelector(sel);

function fmt(sec) {
  if (!sec || !isFinite(sec) || sec < 0) sec = 0;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

async function boot() {
  const init = await aqua.init();
  document.documentElement.dataset.theme = init.state.theme;

  aqua.on('preview:time', (data) => {
    $('#label').textContent = fmt(data.time);
    // 没有拿到画面时（比如缩略图实例起不来），退化成一个纯时间气泡
    $('#frame').style.background = data.hasVideo
      ? 'transparent' : 'rgba(30,30,32,0.72)';
  });
}

boot();
