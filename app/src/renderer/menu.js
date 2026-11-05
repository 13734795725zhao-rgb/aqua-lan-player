'use strict';

/** 倍速菜单：选完立刻下发 Speed 指令，菜单由主进程在失焦/选中时收起。 */

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const $ = (sel) => document.querySelector(sel);

let state = null;
let lastSpeed = -1;

function render() {
  const cur = state && state.playback ? Number(state.playback.speed) || 1 : 1;
  // 状态广播是 20fps，倍速没变就别重建列表
  if (Math.abs(cur - lastSpeed) < 0.001) return;
  lastSpeed = cur;

  const host = $('#menu');
  host.innerHTML = SPEEDS.map((s) => {
    const active = Math.abs(s - cur) < 0.005;
    const label = (Math.abs(s - Math.round(s)) < 0.01 ? s.toFixed(1) : String(s)) + 'x';
    return `<button class="item${active ? ' active' : ''}" data-speed="${s}">` +
      `<span class="tick">${icon('check')}</span><span>${label}</span></button>`;
  }).join('');

  for (const el of host.querySelectorAll('.item')) {
    el.addEventListener('click', () => {
      aqua.send('play:speed', Number(el.dataset.speed));
    });
  }
}

function bindUI() {
  $('#menu').addEventListener('mousemove', () => aqua.send('activity'));
  bindHotkeys({
    getVolume: () => (state ? state.playback.volume : 70),
    onEscape: () => aqua.send('menu:close'),
  });
  aqua.on('material', (m) => {
    document.body.classList.toggle('no-acrylic', !m.acrylic);
  });
}

async function boot() {
  const init = await aqua.init();
  state = init.state;
  document.documentElement.dataset.theme = state.theme;
  bindUI();
  render();
  aqua.on('state', (next) => {
    state = next;
    document.documentElement.dataset.theme = state.theme;
    render();
  });
}

boot();
