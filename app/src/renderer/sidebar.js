'use strict';

/**
 * 磨砂侧边栏渲染层。
 *
 * 三个关键点：
 * 1. 虚拟列表 —— 只渲染可视区的十几行，目录里上万个文件也不卡。
 * 2. 弹簧滚动 —— 用「刚度/阻尼」积分器同时实现惯性滚动与边界回弹，
 *    越界时内容按 0.45 的阻尼系数偏移，松手后自然弹回（macOS 手感）。
 * 3. 目录多路管理 —— 分割按钮（最近/固定）、面包屑、拖拽、排序、播放模式，
 *    加上卡片上的播放上下文（律动激活态、观看进度、CC 徽标）。
 */

const $ = (sel) => document.querySelector(sel);

const ROW_H = 68;      // 行高（舒适视图）
const ROW_H_COMPACT = 48;  // 行高（紧凑视图）
const TOP_PAD = 6;     // 列表顶部留白
const RUBBER = 90;     // 允许越界的最大距离
const STIFF = 0.16;    // 弹簧刚度
const DAMP = 0.80;     // 弹簧阻尼

let state = null;
let items = [];
let view = [];
let durations = Object.create(null);
let progressMap = Object.create(null);
let activePath = '';
let filterText = '';

let scroll = 0, target = 0, vel = 0, raf = null;
let rows = [];
let viewportH = 0;
let scrollTimer = null;
let lastCountText = '';

/* 键盘操作 */
let focusIndex = -1;          // 键盘焦点所在条目
let typeAhead = '';           // type-ahead 缓冲
let typeAheadTimer = null;
let renamingPath = '';        // 正在原地重命名的条目

/* 视图偏好 */
let sortMode = 'name';
let compact = false;
let hideExt = false;
let hiddenSet = new Set();
let rowH = ROW_H;

// ------------------------------------------------------------ 工具函数 ---
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + units[i];
}

function formatDuration(sec) {
  if (!sec || !isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/* 自然排序：01、02、… 以及汉字都能按直觉排 */
const COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/** 展示用文件名：可隐藏通用视频扩展名 */
function displayName(name) {
  if (!hideExt) return name;
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** 按当前排序方式整理列表 */
function sortItems(list) {
  const arr = list.slice();
  if (sortMode === 'mtime') {
    arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  } else if (sortMode === 'duration') {
    arr.sort((a, b) =>
      (durations[b.id] || durations[b.path] || 0) - (durations[a.id] || durations[a.path] || 0));
  } else if (sortMode === 'progress') {
    // 未看过的靠前，其次按剩余比例
    const p = (it) => (progressMap[it.path] ? progressMap[it.path].pct : 0);
    arr.sort((a, b) => p(a) - p(b));
  } else {
    arr.sort((a, b) => COLLATOR.compare(a.name, b.name));
  }
  return arr;
}

// ------------------------------------------------------------ 虚拟列表 ---
function contentHeight() {
  return view.length * rowH + TOP_PAD * 2;
}

function maxScroll() {
  return Math.max(0, contentHeight() - viewportH);
}

function buildPool() {
  const need = Math.ceil(viewportH / rowH) + 4;
  while (rows.length < need) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML =
      '<div class="badge"><span class="icon"></span>' +
      '<div class="eq"><i></i><i></i><i></i></div></div>' +
      '<div class="text"><div class="name"></div><div class="sub"></div></div>' +
      '<div class="flags"></div>' +
      '<div class="rowprog"><i></i></div>';
    el._idx = -1;
    $('#canvas').appendChild(el);
    rows.push(el);
  }
  while (rows.length > need) {
    const el = rows.pop();
    el.remove();
  }
}

function fillRow(el, item, idx) {
  el._idx = idx;
  el._path = item.path;
  el.querySelector('.badge .icon').innerHTML = icon('video');

  // 文件名（可隐藏扩展名）+ 原地重命名输入框
  const nameEl = el.querySelector('.name');
  if (renamingPath === item.path) {
    if (!el._renaming) {
      nameEl.innerHTML = '<input class="rename" type="text" />';
      const input = nameEl.querySelector('input');
      input.value = item.name;
      el._renaming = true;
      input.focus();
      input.select();
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') commitRename(input.value);
        else if (ev.key === 'Escape') cancelRename();
      });
      input.addEventListener('blur', () => cancelRename());
    }
  } else {
    if (el._renaming) { nameEl.textContent = ''; el._renaming = false; }
    nameEl.textContent = displayName(item.name);
  }

  // 副信息：大小 · 格式 · 时长 · 已看 xx
  const dur = formatDuration(durations[item.id] || item.duration);
  const prog = progressMap[item.path];
  const parts = [];
  if (!compact) {
    parts.push(formatSize(item.size));
    if (!hideExt && item.ext) parts.push(item.ext);
    if (dur) parts.push(dur);
  }
  let sub = parts.map((p) => `<span class="tag">${p}</span>`).join('<span class="sep">·</span>');
  if (prog && prog.pct > 0.001 && prog.pct < 0.98 && !compact) {
    sub += '<span class="sep">·</span><span class="watched">已看 ' +
      formatDuration(prog.pos) + '</span>';
  }
  el.querySelector('.sub').innerHTML = sub;

  // 右侧徽标：CC / 音轨 / 已看完
  const flags = [];
  if (item.hasSubs) flags.push('<span class="cc-badge">CC</span>');
  if (item.hasAudio) flags.push('<span class="cc-badge">♪</span>');
  if (prog && prog.pct >= 0.98) flags.push('<span class="done">' + icon('check') + '</span>');
  el.querySelector('.flags').innerHTML = flags.join('');

  // 卡片底部的观看进度条
  const pct = prog ? Math.max(0, Math.min(1, prog.pct)) : 0;
  el.querySelector('.rowprog > i').style.width = (pct * 100) + '%';
  el.classList.toggle('has-prog', pct > 0.001);

  el.classList.toggle('active', item.path === activePath);
  el.classList.toggle('focused', idx === focusIndex);
  el.classList.toggle('ghost', !!item.ghost);
}

function render() {
  const max = maxScroll();
  const clamped = clamp(scroll, 0, max);
  const over = scroll - clamped; // 越界量 → 回弹
  $('#canvas').style.transform =
    `translate3d(0, ${-clamped + over * 0.45}px, 0)`;

  const start = Math.max(0, Math.floor(clamped / rowH) - 2);
  for (let i = 0; i < rows.length; i++) {
    const idx = start + i;
    const el = rows[i];
    if (idx >= view.length) {
      el.style.display = 'none';
      el._idx = -1;
      continue;
    }
    const item = view[idx];
    if (el._idx !== idx || el._path !== item.path) fillRow(el, item, idx);
    el.style.display = 'flex';
    el.style.transform = `translate3d(0, ${idx * rowH + TOP_PAD}px, 0)`;
    el.classList.toggle('active', item.path === activePath);
    el.classList.toggle('focused', idx === focusIndex);
  }
  updateScrollbar(clamped, max);
}

/** 时长回填等场景下刷新当前可见行 */
function refreshVisible() {
  for (const el of rows) {
    if (el._idx >= 0) {
      const item = view[el._idx];
      if (item) fillRow(el, item, el._idx);
    }
  }
}

function updateScrollbar(pos, max) {
  const bar = $('#scrollbar');
  const thumb = $('#thumb');
  const h = viewportH;
  if (max <= 0 || contentHeight() <= 0) {
    thumb.style.height = '0px';
    return;
  }
  const thumbH = Math.max(28, (h / contentHeight()) * h);
  const range = h - thumbH - 8;
  thumb.style.height = thumbH + 'px';
  thumb.style.transform = `translate3d(0, ${(pos / max) * range + 4}px, 0)`;
}

function flashScrollbar() {
  const bar = $('#scrollbar');
  bar.classList.add('show');
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => bar.classList.remove('show'), 900);
}

// -------------------------------------------------------- 弹簧滚动 ---
function start() {
  if (!raf) raf = requestAnimationFrame(tick);
}

function tick() {
  vel = (vel + (target - scroll) * STIFF) * DAMP;
  scroll += vel;

  const max = maxScroll();
  let settled = Math.abs(vel) < 0.08 && Math.abs(target - scroll) < 0.08;
  if (settled) {
    scroll = target;
    vel = 0;
    // 越界了就把目标拉回边界，下一帧自然弹回去
    if (scroll < 0) target = 0;
    else if (scroll > max) target = max;
    else {
      render();
      raf = null;
      return;
    }
  }
  render();
  raf = requestAnimationFrame(tick);
}

function scrollBy(delta) {
  target = clamp(target + delta, -RUBBER, maxScroll() + RUBBER);
  start();
}

function scrollTo(pos) {
  target = clamp(pos, 0, maxScroll());
  start();
}

/**
 * 把列表滚到「正在播放」的那一行。
 *
 * 触发时机：换片（点列表、播完自动接下一条、拖入文件）、切目录。
 * 两条例外：
 *   - 那一行**已经完整可见**就不动 —— 用户自己点列表时不该被强行拽走画面；
 *   - 用弹簧滚动平滑挪过去，并尽量让它落在可视区中部，前后邻居都留得住。
 */
function revealActive() {
  if (!activePath || viewportH <= 0) return;
  const idx = view.findIndex((it) => it.path === activePath);
  if (idx < 0) return;                       // 被搜索过滤掉 / 不在当前目录
  const top = idx * rowH + TOP_PAD;
  if (top >= scroll && top + rowH <= scroll + viewportH) return;
  scrollTo(top - (viewportH - rowH) / 2);
  flashScrollbar();
}

// ------------------------------------------------------------ 数据 ---
function applyFilter() {
  const q = filterText.trim().toLowerCase();
  let list = items.filter((it) => !hiddenSet.has(it.path));
  if (q) list = list.filter((it) => it.name.toLowerCase().indexOf(q) >= 0);
  view = sortItems(list);
  scroll = target = vel = 0;
  $('#canvas').style.height = contentHeight() + 'px';
  render();
  updateEmpty();
}

function setItems(list) {
  items = list || [];
  items.forEach((it, i) => { it._i = i; });
  applyFilter();
  // 切目录后列表会回到顶部，若当前正在播的文件也在新目录里，把它露出来
  if (activePath) revealActive();
}

function updateEmpty() {
  const empty = $('#empty');
  const scanning = state && state.library.scanning;
  const ghost = state && state.library.ghost;
  const show = (!view.length && !scanning) || !items.length;
  empty.classList.toggle('show', show);
  if (show) {
    empty.querySelector('.empty-art').innerHTML =
      '<span class="icon">' + icon(ghost ? 'warning' : 'folder') + '</span>';
    empty.querySelector('.empty-title').textContent =
      ghost ? '目录已断开' : (scanning ? '正在扫描…' : '还没有视频');
    empty.querySelector('.empty-sub').textContent = ghost
      ? '源目录不可达（拔盘或网络断开），请重新选择'
      : (scanning ? '正在遍历目录' : '点击上方「选择文件夹…」导入目录');
  }
}

// ------------------------------------------------------------ 状态 ---
function applyState(next) {
  const prevActive = activePath;
  state = next;
  const root = document.documentElement;
  root.dataset.theme = state.theme;
  root.style.setProperty('--sb-w', state.sidebar.width + 'px');

  activePath = state.playback.path || '';

  // 视图偏好
  const lib = state.library;
  if (lib.sort !== sortMode) { sortMode = lib.sort; applyFilter(); }
  if (lib.compact !== compact) {
    compact = lib.compact;
    rowH = compact ? ROW_H_COMPACT : ROW_H;
    $('#root').classList.toggle('compact', compact);
    buildPool();
    applyFilter();
  }
  if (lib.hideExt !== hideExt) { hideExt = lib.hideExt; applyFilter(); }
  hiddenSet = new Set(lib.hidden || []);
  $('#unhide').hidden = hiddenSet.size === 0;

  const countText = state.library.scanning ? '扫描中…' : `${state.library.count} 项`;
  if (countText !== lastCountText) {
    lastCountText = countText;
    $('#count').textContent = countText;
  }
  if ($('#recursive').checked !== !!state.library.recursive) {
    $('#recursive').checked = !!state.library.recursive;
  }

  renderCrumbs();
  updateEmpty();
  // 播放进度每 200ms 广播一次，只有「当前项」变化时才需要重绘列表
  if (prevActive !== activePath) {
    render();
    revealActive();   // 换片了：把列表滚到正在播的那一行
  }
}

/** 面包屑：把当前目录拆成可点击的层级 */
function renderCrumbs() {
  const host = $('#crumbs');
  const dir = (state && state.library.dir) || '';
  if (!dir) { host.innerHTML = ''; return; }
  const parts = dir.split(/[\\/]/).filter(Boolean);
  const segs = [];
  if (parts.length && /^[A-Za-z]:$/.test(parts[0])) {
    segs.push({ name: parts[0] + '\\', path: parts[0] + '\\' });
    parts.shift();
  }
  let acc = segs.length ? segs[0].path : '';
  for (const p of parts) {
    acc = acc ? acc + '\\' + p : p;
    segs.push({ name: p, path: acc });
  }
  const html = segs.map((s, i) => {
    const last = i === segs.length - 1;
    return (i ? '<span class="crumb-sep">›</span>' : '') +
      `<button class="crumb${last ? ' last' : ''}" data-path="${s.path}">${s.name}</button>`;
  }).join('');
  if (host.innerHTML !== html) host.innerHTML = html;
}

// ------------------------------------------------- 键盘焦点 / type-ahead ---
/** 方向键在条目之间移动焦点，并保证焦点项在可视区内。 */
function moveFocus(delta) {
  if (!view.length) return;
  let idx = focusIndex;
  if (idx < 0) {
    // 第一次按键：以当前正在播放的条目为起点
    const cur = view.findIndex((it) => it.path === activePath);
    idx = cur >= 0 ? cur : 0;
  } else {
    idx = Math.max(0, Math.min(view.length - 1, idx + delta));
  }
  focusIndex = idx;
  const top = idx * rowH;
  if (top < scroll) scrollTo(top);
  else if (top + rowH > scroll + viewportH) scrollTo(top + rowH - viewportH);
  else render();
  refreshVisible();
}

/** type-ahead：连敲 "03" 之类的前缀，直接跳到命中的条目。 */
function typeAheadFind(ch) {
  typeAhead += ch.toLowerCase();
  clearTimeout(typeAheadTimer);
  typeAheadTimer = setTimeout(() => { typeAhead = ''; }, 800);
  const idx = view.findIndex((it) =>
    it.name.toLowerCase().startsWith(typeAhead));
  if (idx >= 0) {
    focusIndex = idx;
    const top = idx * rowH;
    if (top < scroll) scrollTo(top);
    else if (top + rowH > scroll + viewportH) scrollTo(top + rowH - viewportH);
    else render();
    refreshVisible();
  }
}

// ------------------------------------------------------------ 重命名 ---
function beginRename(p) {
  renamingPath = p;
  focusIndex = -1;
  refreshVisible();
}

function commitRename(name) {
  const p = renamingPath;
  renamingPath = '';
  if (p && name) aqua.send('item:rename', { path: p, name });
  refreshVisible();
}

function cancelRename() {
  renamingPath = '';
  refreshVisible();
}

// ------------------------------------------------------- 浮动菜单 ---
const POPS = {
  recent: '最近访问',
  sort: '排序方式',
  view: '显示选项',
  mode: '播放模式',
};

function openPop(kind) {
  const host = $('#pop');
  const html = buildPopHTML(kind);
  if (!html) { closePop(); return; }
  host.innerHTML = html;
  host.hidden = false;
  host.dataset.kind = kind;
  // 点击菜单外部关闭
  setTimeout(() => {
    document.addEventListener('pointerdown', onDocDown, { once: true });
  }, 0);
}

function onDocDown(e) {
  if (e.target.closest('.pop')) {
    document.addEventListener('pointerdown', onDocDown, { once: true });
    return;
  }
  closePop();
}

function closePop() {
  const host = $('#pop');
  if (host) host.hidden = true;
  document.removeEventListener('pointerdown', onDocDown);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 目录名（取最后一段） */
function dirName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p || '';
}

function buildPopHTML(kind) {
  const lib = state.library;
  const out = [];

  if (kind === 'recent') {
    if (lib.pinned && lib.pinned.length) {
      out.push('<div class="pop-title">固定</div>');
      for (const p of lib.pinned) {
        out.push('<button class="pop-item" data-act="open" data-path="' + esc(p) + '">' +
          '<span class="icon">' + icon('pin') + '</span>' +
          '<span class="txt">' + esc(dirName(p)) + '</span>' +
          '<span class="tail" data-act="unpin">取消</span></button>');
      }
      out.push('<div class="pop-sep"></div>');
    }
    out.push('<div class="pop-title">最近访问</div>');
    if (lib.recent && lib.recent.length) {
      for (const p of lib.recent) {
        out.push('<button class="pop-item" data-act="open" data-path="' + esc(p) + '">' +
          '<span class="icon">' + icon('folder') + '</span>' +
          '<span class="txt">' + esc(p) + '</span>' +
          '<span class="tail" data-act="pin">固定</span></button>');
      }
      out.push('<div class="pop-sep"></div>');
      out.push('<button class="pop-item" data-act="clear">' +
        '<span class="icon">' + icon('trash') + '</span><span>清除历史记录</span></button>');
    } else {
      out.push('<div class="pop-item" style="opacity:.6">暂无记录</div>');
    }
    return out.join('');
  }

  if (kind === 'sort') {
    const opts = [
      ['name', '按文件名', 'sortName'],
      ['mtime', '按修改时间', 'clock'],
      ['duration', '按时长', 'gauge'],
      ['progress', '按观看进度', 'check'],
    ];
    for (const [k, label, ic] of opts) {
      out.push('<button class="pop-item' + (lib.sort === k ? ' active' : '') +
        '" data-act="sort" data-value="' + k + '">' +
        '<span class="icon">' + icon(ic) + '</span><span>' + label + '</span></button>');
    }
    return out.join('');
  }

  if (kind === 'view') {
    out.push('<button class="pop-item' + (lib.hideExt ? ' active' : '') +
      '" data-act="hide-ext"><span class="icon">' + icon('text') +
      '</span><span>隐藏视频扩展名</span></button>');
    out.push('<button class="pop-item' + (lib.compact ? ' active' : '') +
      '" data-act="compact"><span class="icon">' + icon('list') +
      '</span><span>紧凑视图</span></button>');
    if (hiddenSet.size) {
      out.push('<div class="pop-sep"></div>');
      out.push('<button class="pop-item" data-act="unhide-all">' +
        '<span class="icon">' + icon('refresh') +
        '</span><span>显示已隐藏的 ' + hiddenSet.size + ' 项</span></button>');
    }
    return out.join('');
  }

  if (kind === 'mode') {
    const opts = [
      ['sequence', '顺序连播', 'sequence'],
      ['loop', '单集循环', 'loop'],
      ['shuffle', '乱序播放', 'shuffle'],
    ];
    for (const [k, label, ic] of opts) {
      out.push('<button class="pop-item' + (lib.playMode === k ? ' active' : '') +
        '" data-act="mode" data-value="' + k + '">' +
        '<span class="icon">' + icon(ic) + '</span><span>' + label + '</span></button>');
    }
    return out.join('');
  }

  return '';
}
function bindUI() {
  // ---------------------------------------------------- 事件隔离（防穿透）---
  // 侧边栏是独立原生窗口，理论上不会穿透到视频；
  // 但这里再加一道 DOM 层的兜底：所有指针/滚轮事件在侧边栏内部就地消费，
  // 绝不冒泡出去，避免将来把它改成同页面内渲染时踩坑。
  const panel = $('#root');
  for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup',
    'wheel', 'contextmenu', 'pointerdown', 'pointerup']) {
    // 用**冒泡阶段**拦截：内部控件（resize 把手、列表项）先拿到事件，
    // 处理完再在根容器这里止住，不让它跑到 document / window 上去。
    panel.addEventListener(ev, (e) => e.stopPropagation());
  }

  $('#pick').querySelector('.icon').innerHTML = icon('folder');
  $('#pick-menu').querySelector('.icon').innerHTML = icon('chevronDown');
  $('.search .search-ico').innerHTML = icon('search');
  $('#clear').innerHTML = '<span class="icon">' + icon('close') + '</span>';
  $('#btn-mode').innerHTML = '<span class="icon">' + icon('playMode') + '</span>';
  $('#btn-sort').innerHTML = '<span class="icon">' + icon('sort') + '</span>';
  $('#btn-view').innerHTML = '<span class="icon">' + icon('sliders') + '</span>';
  $('#collapse').innerHTML = '<span class="icon">' + icon('chevronRight') + '</span>';

  // 分割按钮：主区开选择器，箭头出「最近 / 固定」
  $('#pick').addEventListener('click', () => aqua.invoke('library:pick'));
  $('#pick-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    openPop('recent');
  });
  $('#btn-mode').addEventListener('click', (e) => {
    e.stopPropagation();
    openPop('mode');
  });
  $('#btn-sort').addEventListener('click', (e) => {
    e.stopPropagation();
    openPop('sort');
  });
  $('#btn-view').addEventListener('click', (e) => {
    e.stopPropagation();
    openPop('view');
  });
  $('#collapse').addEventListener('click', () => {
    if (state.sidebar.open) aqua.send('sidebar:toggle');
    else aqua.send('sidebar:hover', false);
  });
  $('#recursive').addEventListener('change', (e) => {
    aqua.send('library:recursive', e.target.checked);
  });
  $('#unhide').addEventListener('click', () => aqua.send('item:unhide-all'));

  // 面包屑：点哪一级就跳到哪一级
  $('#crumbs').addEventListener('click', (e) => {
    const btn = e.target.closest('.crumb');
    if (btn) aqua.send('library:crumb', btn.dataset.path);
  });

  // 浮动菜单点击分发
  $('#pop').addEventListener('click', (e) => {
    const item = e.target.closest('.pop-item');
    if (!item) return;
    const tail = e.target.closest('.tail');
    const act = tail ? tail.dataset.act : item.dataset.act;
    const p = item.dataset.path;
    switch (act) {
      case 'open': aqua.send('library:open', p); break;
      case 'pin': aqua.send('library:pin', p); break;
      case 'unpin': aqua.send('library:pin', p); break;
      case 'clear': aqua.send('library:clear-recent'); break;
      case 'sort': aqua.send('library:sort', item.dataset.value); break;
      case 'mode': aqua.send('play:mode', item.dataset.value); break;
      case 'hide-ext':
        aqua.send('library:view', { hideExt: !state.library.hideExt });
        break;
      case 'compact':
        aqua.send('library:view', { compact: !state.library.compact });
        break;
      case 'unhide-all': aqua.send('item:unhide-all'); break;
      default: return;
    }
    closePop();
  });

  // 拖入文件夹：直接切换到新目录
  const root = $('#root');
  root.addEventListener('dragover', (e) => {
    e.preventDefault();
    root.classList.add('dropping');
  });
  root.addEventListener('dragleave', () => root.classList.remove('dropping'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('dropping');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.path) aqua.send('library:drop', f.path);
  });

  // 搜索
  const input = $('#filter');
  input.addEventListener('input', () => {
    filterText = input.value;
    $('#clear').hidden = !filterText;
    applyFilter();
  });
  $('#clear').addEventListener('click', () => {
    input.value = '';
    filterText = '';
    $('#clear').hidden = true;
    applyFilter();
    input.focus();
  });

  // 列表：滚轮 / 点击 / 右键 / 键盘
  const viewport = $('#viewport');

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    scrollBy(d);
    flashScrollbar();
  }, { passive: false });

  viewport.addEventListener('click', (e) => {
    const el = e.target.closest('.item');
    if (!el) return;
    const item = view[el._idx];
    if (!item) return;
    focusIndex = el._idx;
    aqua.send('play:index', item._i);
  });

  // 双击文件名 → 原地重命名
  viewport.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.item');
    if (!el) return;
    const item = view[el._idx];
    if (!item) return;
    e.preventDefault();
    beginRename(item.path);
  });

  // 右键 → 系统原生菜单（在主进程弹出，不会被窗口裁掉）
  viewport.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.item');
    if (!el) return;
    e.preventDefault();
    const item = view[el._idx];
    if (!item) return;
    focusIndex = el._idx;
    aqua.send('item:context', {
      path: item.path,
      name: item.name,
      hasSubs: !!item.hasSubs,
    });
  });

  // 滚动条拖拽
  const bar = $('#scrollbar');
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = bar.getBoundingClientRect();
    const max = maxScroll();
    const move = (ev) => {
      const p = (ev.clientY - rect.top) / rect.height;
      scrollTo(p * max);
      flashScrollbar();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    move(e);
  });

  // 悬停：告诉主进程鼠标在侧边栏里，别把它收起来
  $('#root').addEventListener('mouseenter', () => aqua.send('sidebar:hover', true));
  $('#root').addEventListener('mouseleave', () => aqua.send('sidebar:hover', false));

  // 拖住左边缘改宽度
  $('#resizer').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.screenX;
    const startW = state.sidebar.width;
    // 把手自己捕获指针：光标划出侧边栏范围也不会断掉拖拽
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    aqua.send('sidebar:resizing', true);
    const move = (ev) => aqua.send('sidebar:width', startW + (startX - ev.screenX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      aqua.send('sidebar:resizing', false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // 键盘：方向键在条目间移动焦点，Enter 起播，Space 播放/暂停，
  // 直接敲字母/数字触发 type-ahead 快速定位（对标 Finder）
  window.addEventListener('keydown', (e) => {
    if (e.target === input) {
      if (e.key === 'Escape') {
        // Esc：先清空搜索词，再按一次才把焦点交回播放器
        if (filterText) {
          input.value = '';
          filterText = '';
          $('#clear').hidden = true;
          applyFilter();
        } else {
          input.blur();
        }
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const page = Math.max(1, Math.floor(viewportH / rowH) - 1);
    switch (e.key) {
      case 'ArrowDown':
        moveFocus(1);
        e.preventDefault();
        break;
      case 'ArrowUp':
        moveFocus(-1);
        e.preventDefault();
        break;
      case 'PageDown': scrollBy(page * rowH); flashScrollbar(); e.preventDefault(); break;
      case 'PageUp': scrollBy(-page * rowH); flashScrollbar(); e.preventDefault(); break;
      case 'Home': focusIndex = 0; scrollTo(0); refreshVisible(); e.preventDefault(); break;
      case 'End':
        focusIndex = view.length - 1;
        scrollTo(maxScroll());
        refreshVisible();
        e.preventDefault();
        break;
      case 'Enter': {
        const cur = focusIndex >= 0 ? view[focusIndex]
          : view.find((it) => it.path === activePath);
        if (cur) aqua.send('play:index', cur._i);
        e.preventDefault();
        break;
      }
      case ' ':
        // 空格：在主视口播放/暂停，不抢列表焦点
        aqua.send('play:toggle');
        e.preventDefault();
        break;
      case 'Escape':
        closePop();
        if (state && state.sidebar.open) aqua.send('sidebar:toggle');
        e.preventDefault();
        break;
      default:
        if (e.key.length === 1 && /[\w\d\u4e00-\u9fa5]/.test(e.key)) {
          typeAheadFind(e.key);
          e.preventDefault();
        }
        break;
    }
  });

  bindHotkeys({
    getVolume: () => (state ? state.playback.volume : 70),
    onEscape: () => {
      if (filterText) {
        input.value = '';
        filterText = '';
        $('#clear').hidden = true;
        applyFilter();
      } else if (state && state.sidebar.open) {
        aqua.send('sidebar:toggle');
      }
    },
  });

  // 视口尺寸变化（窗口高度改变/侧边栏宽度不变，这里主要是高度）
  new ResizeObserver(() => {
    viewportH = $('#viewport').clientHeight;
    buildPool();
    render();
  }).observe($('#viewport'));
}

// ------------------------------------------------------------ 启动 ---
async function boot() {
  const init = await aqua.init();
  state = init.state;

  // 图标先塞好，避免首帧空白
  viewportH = $('#viewport').clientHeight;
  buildPool();

  bindUI();
  applyState(state);

  aqua.on('state', applyState);

  aqua.on('material', (m) => {
    document.body.classList.toggle('no-acrylic', !m.acrylic);
  });

  aqua.on('library:begin', () => {
    items = [];
    view = [];
    $('#canvas').style.height = '0px';
    render();
    updateEmpty();
  });

  aqua.on('library:items', (list) => setItems(list));

  aqua.on('library:durations', (batch) => {
    Object.assign(durations, batch);
    if (sortMode === 'duration') applyFilter();
    else refreshVisible();
  });

  // 观看进度：单条更新 / 全量映射
  aqua.on('library:progress', (rec) => {
    if (!rec || !rec.path) return;
    progressMap[rec.path] = { pos: rec.pos, dur: rec.dur, pct: rec.pct, at: rec.at };
    refreshVisible();
  });
  aqua.on('library:progress-map', (map) => {
    progressMap = map || Object.create(null);
    if (sortMode === 'progress') applyFilter();
    else refreshVisible();
  });

  // 源文件不可达（拔盘/网络断开）
  aqua.on('item:ghost', (info) => {
    const it = items.find((x) => x.path === info.path);
    if (it) it.ghost = true;
    showToast('源文件已不存在：' + (info.name || ''));
    refreshVisible();
  });

  // 主进程请求原地重命名
  aqua.on('item:rename:begin', (p) => beginRename(p));
  aqua.on('item:rename:failed', (info) => {
    showToast('重命名失败：' + (info && info.message ? info.message : ''));
  });

  // 收起/展开时内容淡出保护
  aqua.on('sidebar:anim', ({ dir }) => {
    const root = $('#root');
    if (dir === 'out') root.classList.add('fading');
    else root.classList.remove('fading');
  });

  // 主动拉一次目录（广播可能发生在本页面加载完成之前）
  try {
    const lib = await aqua.invoke('library:get');
    if (lib) {
      Object.assign(state.library, {
        dir: lib.dir || '',
        count: lib.count || 0,
        scanning: !!lib.scanning,
        recursive: lib.recursive !== false,
        recent: lib.recent || [],
        pinned: lib.pinned || [],
        sort: lib.sort || 'name',
        hideExt: !!lib.hideExt,
        compact: !!lib.compact,
        hidden: lib.hidden || [],
        playMode: lib.playMode || 'sequence',
      });
      Object.assign(durations, lib.durations || {});
      progressMap = lib.progress || Object.create(null);
      hiddenSet = new Set(state.library.hidden);
      if (lib.items && lib.items.length) setItems(lib.items);
      applyState(state);
    }
  } catch (e) {
    console.warn('[sidebar] 拉取目录失败：' + (e && e.message));
  }
}

/** 底部提示条 */
let toastTimer = null;
function showToast(text) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

boot();
