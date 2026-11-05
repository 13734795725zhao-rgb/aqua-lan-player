/**
 * 原生层探针：在纯 Node 环境下验证 libmpv 绑定与 Windows 磨砂材质接口。
 *   node tools/probe-native.js
 *
 * 刻意直接 require 主进程真正使用的 win32.js / mpv.js ——
 * 探针跑通 == 播放器跑通，不另写一套「看起来对」的实现。
 * 任何一项 FAIL 都只会让对应功能降级，不影响其它项。
 */
'use strict';

const path = require('path');
const koffi = require('koffi');

const win32 = require('../src/main/win32');
const { MpvProbe, MpvThumb, EVENT, FORMAT } = require('../src/main/mpv');

// 探针需要一个「父窗口」来挂承载窗口；这里直接调一次 CreateWindowExW 即可
// （函数声明不会注册 koffi 类型名，不会和 win32.js 里的结构体重名）
const user32 = koffi.load('user32.dll');
const CreateWindowExW = user32.func(
  'uintptr_t CreateWindowExW(uint dwExStyle, const char16_t *lpClassName,' +
  ' const char16_t *lpWindowName, uint dwStyle, int X, int Y, int nWidth, int nHeight,' +
  ' uintptr_t hWndParent, uintptr_t hMenu, uintptr_t hInstance, uintptr_t lpParam)');

const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
let failures = 0;

function ok(label, detail) {
  console.log(`  [ OK ] ${label}${detail ? ' -> ' + detail : ''}`);
}
function fail(label, err) {
  failures++;
  console.log(`  [FAIL] ${label} -> ${err && err.message ? err.message : err}`);
}
function check(label, fn) {
  try {
    const r = fn();
    ok(label, r === undefined ? undefined : String(r));
    return r;
  } catch (e) {
    fail(label, e);
    return null;
  }
}

console.log(`koffi ${require('koffi/package.json').version}`);
console.log(`mpv   ${BIN_DIR}`);

// ------------------------------------------------- 原生窗口 + 磨砂材质 ---
console.log('\n# 1. Windows 原生窗口 + 磨砂材质');

// 父窗口（顶层，用于承载子窗口）
let probeParent = 0n;
// 视频承载窗口（mpv 会挂在它下面）
let probeContainer = 0n;

check('CreateWindowExW(探针父窗口)', () => {
  // WS_POPUP = 0x80000000：一个不需要显示的顶层宿主窗口
  probeParent = CreateWindowExW(0, 'STATIC', 'mpv-aqua-probe', 0x80000000,
    0, 0, 100, 100, 0n, 0n, 0n, 0n) || 0n;
  if (!probeParent) throw new Error('返回空句柄');
  return '0x' + probeParent.toString(16);
});

check('createContainer(视频承载窗口)', () => {
  probeContainer = win32.createContainer(probeParent, 0, 0, 100, 100);
  if (!probeContainer) throw new Error('承载窗口必须挂在某个父窗口下');
  return '0x' + probeContainer.toString(16);
});

// 注意：Acrylic 只对顶层窗口生效，承载窗口是子窗口，所以这里拿父窗口试
check('setAcrylic(系统磨砂)', () => {
  if (!probeParent) throw new Error('没有可用窗口句柄');
  const r = win32.setAcrylic(probeParent, true, 0x99202020);
  if (!r) throw new Error('系统拒绝该材质（需 Win10 1803+）');
  return 'acrylic 可用';
});

// ------------------------------------------------------------ libmpv ---
console.log('\n# 2. libmpv 绑定（复用主进程的 mpv.js）');

let probe = null;
check('MpvProbe 实例创建（第二个实例，无画面无声音）', () => {
  probe = new MpvProbe({ binDir: BIN_DIR });
  return 'initialized';
});

check('command(数组形式)', () => {
  if (!probe) throw new Error('无实例');
  const r = probe.command('set', 'volume', '37');
  if (r < 0) throw new Error('错误码 ' + r);
  return r;
});

check('getDouble(volume)', () => {
  if (!probe) throw new Error('无实例');
  return probe.getDouble('volume');
});

check('getFlag(idle-active)', () => {
  if (!probe) throw new Error('无实例');
  return probe.getFlag('idle-active') ? 'yes' : 'no';
});

check('getInt64(playlist-count)', () => {
  if (!probe) throw new Error('无实例');
  return probe.getInt64('playlist-count');
});

check('waitEvent 循环（0.6s）', () => {
  if (!probe) throw new Error('无实例');
  const seen = new Set();
  const deadline = Date.now() + 600;
  while (Date.now() < deadline) {
    const ev = probe.waitEvent(0.05);
    if (ev && ev.event_id) seen.add(ev.event_id);
  }
  return '事件 id: ' + ([...seen].join(',') || '无');
});

check('getDouble(percent-pos) 取不到时返回 null 而不是乱值', () => {
  if (!probe) throw new Error('无实例');
  const v = probe.getDouble('percent-pos');
  return v === null ? 'null（空闲态下该属性确实不存在）' : String(v);
});

// ------------------------------------------------------- 属性观察链路 ---
console.log('\n# 3. 属性观察（UI 不用轮询的关键）');

check('requestEvent(PROPERTY_CHANGE)', () => {
  if (!probe) throw new Error('无实例');
  const r = probe.requestEvent(EVENT.PROPERTY_CHANGE, true);
  if (r < 0) throw new Error('错误码 ' + r);
  return r;
});

check('observe(volume, DOUBLE)', () => {
  if (!probe) throw new Error('无实例');
  // userdata 4 → volume，和主进程 mpv.js 里的映射表一致
  const r = probe.observe('volume', FORMAT.DOUBLE, 4);
  if (r < 0) throw new Error('错误码 ' + r);
  return r;
});

check('收到 PropertyChange 并用 reply_userdata 反查属性名', () => {
  if (!probe) throw new Error('无实例');
  const before = probe.getDouble('volume');
  probe.command('set', 'volume', '61');        // 制造一次变更
  const deadline = Date.now() + 1500;
  const seen = [];
  while (Date.now() < deadline) {
    const ev = probe.waitEvent(0.05);
    if (!ev) continue;          // 50ms 内没有事件不算结束，继续等到截止时间
    seen.push(`${ev.event_id}/${ev.reply_userdata}`);
    if (ev.event_id === EVENT.PROPERTY_CHANGE) {
      const info = MpvProbe.decodePropertyChange(ev);
      if (info && info.name === 'volume') {
        return `reply_userdata=${ev.reply_userdata} → ${info.name}，值 ${before} → ${probe.getDouble('volume')}`;
      }
    }
  }
  throw new Error('1.5s 内没解出 volume 的变更事件；期间收到的事件: ' + seen.join(' '));
});

// ------------------------------------------------------- 缩略图实例 ---
console.log('\n# 4. 悬停缩略图用的第三条链路（带画面的独立实例）');

check('commandAsync(异步指令不阻塞内核线程)', () => {
  if (!probe) throw new Error('无实例');
  const t0 = Date.now();
  probe.commandAsync('set', 'volume', '55');   // fire-and-forget
  const spent = Date.now() - t0;
  if (spent > 30) throw new Error('异步指令却耗时 ' + spent + 'ms');
  return '投递耗时 ' + spent + 'ms（命令在后台执行）';
});

check('异步指令最终生效', () => {
  if (!probe) throw new Error('无实例');
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (Math.abs((probe.getDouble('volume') || 0) - 55) < 0.01) return 'volume=55';
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error('1s 内 volume 没有变成 55');
});

check('MpvThumb 实例创建', () => {
  if (!probeParent) throw new Error('没有可用父窗口');
  const cn = win32.createContainer(probeParent, 0, 0, 200, 113);
  if (!cn) throw new Error('承载窗口创建失败');
  const t = new MpvThumb({ binDir: BIN_DIR, containerHwnd: cn });
  win32.raiseWindow(cn);
  const paused = t.getFlag('pause');
  t.destroy();
  win32.destroyWindow(cn);
  return '缩略图实例可用，pause=' + paused;
});

// ------------------------------------------------------------ 收尾 ---
if (probe) {
  check('销毁时长探测实例', () => {
    probe.destroy();
    return 'ok';
  });
}
if (probeParent) {
  check('销毁探针窗口', () => win32.destroyWindow(probeParent));
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
