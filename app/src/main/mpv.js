'use strict';

/**
 * libmpv 绑定层。
 *
 * 宿主架构：整个窗口由 Electron 创建，mpv 只负责把画面渲染到我们给的
 * 原生子窗口（--wid / mpv_set_option_string("wid", ...)）里，其余 UI 全部是网页。
 *
 * 两条铁律：
 *   1. 绝不解引用 char*（koffi 会直接崩进程），所有属性读取走
 *      mpv_get_property + Buffer，命令走 mpv_command 的字符串数组。
 *   2. mpv_wait_event 返回的是不透明指针，必须 koffi.decode(ptr, MPV_EVENT) 才能读字段。
 */

const path = require('path');
const koffi = require('koffi');
const win32 = require('./win32');

// ------------------------------------------------------------- 常量表 ---
const FORMAT = {
  NONE: 0,
  STRING: 1,
  OSD_STRING: 2,
  FLAG: 3,
  INT64: 4,
  DOUBLE: 5,
};

/**
 * 主播放时需要观察的属性（事件驱动，不做定时轮询）。
 *
 * 关键取舍：mpv 的 property-change 事件里只有 `const char *name`，
 * 而 koffi 解引用 char* 会直接崩进程 —— 所以这里给每个属性编一个
 * userdata 编号，mpv 会把它原样回传（mpv_event.reply_userdata，安全类型），
 * 收到事件后按编号反查属性名，一次字符串都不需要读。
 */
const OBSERVED = [
  ['time-pos', FORMAT.DOUBLE, 1],
  ['duration', FORMAT.DOUBLE, 2],
  ['pause', FORMAT.FLAG, 3],
  ['volume', FORMAT.DOUBLE, 4],
  ['mute', FORMAT.FLAG, 5],
  ['speed', FORMAT.DOUBLE, 6],
  // 播完判定：本实例开了 keep-open=yes，mpv 在 EOF 时会把 stop_play 改回
  // KEEP_PLAYING（playloop.c 的 handle_keep_open），文件不卸载 ——
  // 于是 MPV_EVENT_END_FILE **不会**在播完时发出。唯一可靠的"播完了"信号
  // 就是 eof-reached 属性。
  ['eof-reached', FORMAT.FLAG, 7],
];

/** userdata 编号 → 属性名 */
const OBSERVED_BY_ID = Object.create(null);
for (const [name, , id] of OBSERVED) OBSERVED_BY_ID[id] = name;

/**
 * mpv_event_id 枚举。
 *
 * ⚠ 这些数字必须与 include/mpv/client.h 完全一致 —— 不能凭印象写！
 * 本项目的 mpv 构建里 9/10/12/13/15 属于 MPV_ENABLE_DEPRECATED 段，
 * PROPERTY_CHANGE 实际是 22（曾按 21 写，导致属性事件全部对不上号）。
 */
const EVENT = {
  NONE: 0,
  SHUTDOWN: 1,
  LOG_MESSAGE: 2,
  GET_PROPERTY_REPLY: 3,
  SET_PROPERTY_REPLY: 4,
  COMMAND_REPLY: 5,
  START_FILE: 6,
  END_FILE: 7,
  FILE_LOADED: 8,
  TRACKS_CHANGED: 9,
  TRACK_SWITCHED: 10,
  IDLE: 11,
  PAUSE: 12,
  UNPAUSE: 13,
  TICK: 14,
  SCRIPT_INPUT_DISPATCH: 15,
  CLIENT_MESSAGE: 16,
  VIDEO_RECONFIG: 17,
  AUDIO_RECONFIG: 18,
  SEEK: 20,
  PLAYBACK_RESTART: 21,
  PROPERTY_CHANGE: 22,
  QUEUE_OVERFLOW: 24,
  HOOK: 25,
};

/** end-file 的 reason 字段 */
const END_REASON = {
  EOF: 0,
  STOP: 1,
  QUIT: 2,
  ERROR: 3,
  REDIRECT: 4,
};

const MPV_EVENT_END_FILE = koffi.struct('mpv_event_end_file', {
  reason: 'int',
  error: 'int',
});

/**
 * mpv_event_property 我们根本不需要读：
 * 属性名由 reply_userdata 反查，值一律用 getXxx 重新取，
 * 这样既绕开了 char* 崩溃，也绕开了不同构建里 data 偏移的坑。
 */
const MPV_EVENT_PROPERTY = koffi.struct('mpv_event_property', {
  name: 'uintptr_t',
  format: 'int',
  data: 'uintptr_t',
});

const MPV_EVENT = koffi.struct('mpv_event', {
  event_id: 'int',
  error: 'int',
  reply_userdata: 'uint64',
  data: koffi.pointer(MPV_EVENT_END_FILE),
});

// --------------------------------------------------------- 动态库加载 ---
let lib = null;
let api = null;

function loadLibrary(binDir) {
  if (lib) return api;

  win32.setDllDirectory(binDir);
  try {
    lib = koffi.load(path.join(binDir, 'libmpv-2.dll'));
  } finally {
    // 还原 DLL 搜索路径，别影响进程里其它 LoadLibrary
    win32.setDllDirectory(null);
  }

  api = {
    create: lib.func('void *mpv_create()'),
    initialize: lib.func('int mpv_initialize(void *ctx)'),
    terminateDestroy: lib.func('void mpv_terminate_destroy(void *ctx)'),
    setOptionString: lib.func('int mpv_set_option_string(void *ctx, const char *name, const char *value)'),
    command: lib.func('int mpv_command(void *ctx, const char **args)'),
    commandAsync: lib.func('int mpv_command_async(void *ctx, uint64 reply_userdata, const char **args)'),
    commandString: lib.func('int mpv_command_string(void *ctx, const char *args)'),
    getProperty: lib.func('int mpv_get_property(void *ctx, const char *name, int format, void *data)'),
    setPropertyString: lib.func('int mpv_set_property_string(void *ctx, const char *name, const char *value)'),
    waitEvent: lib.func('mpv_event *mpv_wait_event(void *ctx, double timeout)'),
    requestLogMessages: lib.func('int mpv_request_log_messages(void *ctx, const char *min_level)'),
    requestEvent: lib.func('int mpv_request_event(void *ctx, int event_id, int enable)'),
    observeProperty: lib.func(
      'int mpv_observe_property(void *ctx, uint64 reply_userdata, const char *name, int format)'),
    unobserveProperty: lib.func(
      'int mpv_unobserve_property(void *ctx, uint64 reply_userdata)'),
  };
  return api;
}

// ------------------------------------------------------------- 句柄封装 ---
class MpvHandle {
  constructor(binDir) {
    this.binDir = binDir;
    this.api = loadLibrary(binDir);
    this.ctx = this.api.create();
    this._buf = Buffer.alloc(8);
    this.destroyed = false;
    if (!this.ctx) throw new Error('mpv_create 失败');
  }

  setOption(name, value) {
    if (!this.ctx) return -1;
    return this.api.setOptionString(this.ctx, String(name), String(value));
  }

  initialize() {
    const r = this.api.initialize(this.ctx);
    if (r < 0) throw new Error('mpv_initialize 失败，错误码 ' + r);
    return r;
  }

  /** mpv_command：不经过命令行解析，路径里的空格/反斜杠都安全。 */
  command(...args) {
    if (!this.ctx) return -1;
    const argv = args.filter((a) => a !== undefined && a !== null).map(String);
    argv.push(null); // koffi 需要显式 NULL 结尾
    return this.api.command(this.ctx, argv);
  }

  /**
   * mpv_command_async：**不等待**内核处理完就返回。
   *
   * 这一条是「点击不卡」的关键：同步的 mpv_command 要等内核把命令执行完
   * 才返回，而高码率播放时内核正忙着解码渲染，主线程会被拖住几十毫秒。
   * 异步版本是 fire-and-forget：命令进队列，主线程立刻返回去画界面。
   *
   * 参数会被 mpv 复制（mp_input_parse_cmd_strv 解析完立刻 talloc_free 了自己的副本），
   * 所以这里传 JS 数组是安全的。
   */
  commandAsync(...args) {
    if (!this.ctx) return -1;
    const argv = args.filter((a) => a !== undefined && a !== null).map(String);
    argv.push(null);
    return this.api.commandAsync(this.ctx, 0n, argv);
  }

  /** 异步设置属性（等价于 set xxx yyy，但不等回复）。 */
  setPropertyAsync(name, value) {
    return this.commandAsync('set', name, String(value));
  }

  getDouble(name) {
    if (!this.ctx) return null;
    const r = this.api.getProperty(this.ctx, name, FORMAT.DOUBLE, this._buf);
    return r < 0 ? null : this._buf.readDoubleLE(0);
  }

  getFlag(name) {
    if (!this.ctx) return null;
    this._buf.fill(0);
    const r = this.api.getProperty(this.ctx, name, FORMAT.FLAG, this._buf);
    return r < 0 ? null : this._buf.readInt32LE(0) !== 0;
  }

  getInt64(name) {
    if (!this.ctx) return null;
    const r = this.api.getProperty(this.ctx, name, FORMAT.INT64, this._buf);
    return r < 0 ? null : Number(this._buf.readBigInt64LE(0));
  }

  setString(name, value) {
    if (!this.ctx) return -1;
    return this.api.setPropertyString(this.ctx, name, String(value));
  }

  /** 开关某类事件的投递。 */
  requestEvent(id, enable = true) {
    if (!this.ctx) return -1;
    return this.api.requestEvent(this.ctx, id, enable ? 1 : 0);
  }

  /** 订阅属性：值一变 mpv 就主动推 MPV_EVENT_PROPERTY_CHANGE。 */
  observe(name, format, userdata = 0) {
    if (!this.ctx) return -1;
    return this.api.observeProperty(this.ctx, BigInt(userdata), name, format);
  }

  unobserve(userdata) {
    if (!this.ctx) return -1;
    return this.api.unobserveProperty(this.ctx, BigInt(userdata));
  }

  /** 取出并解码一个事件；无事件返回 null。 */
  waitEvent(timeout = 0) {
    if (!this.ctx) return null;
    const ptr = this.api.waitEvent(this.ctx, timeout);
    if (!ptr) return null;
    const ev = koffi.decode(ptr, MPV_EVENT);
    if (!ev || ev.event_id === EVENT.NONE) return null;
    return ev;
  }

  /**
   * 解 property-change 事件 → 变化了的 {name}。
   * 靠 reply_userdata 反查属性名，不读任何 char*；
   * 值由调用方用 getXxx(name) 自行读取。
   */
  static decodePropertyChange(ev) {
    if (!ev) return null;
    const name = OBSERVED_BY_ID[ev.reply_userdata];
    if (!name) return null;
    return { name, format: 0, data: 0 };
  }

  /** 取 end-file 事件的 {reason, error}，取值失败时按 EOF 处理。 */
  static decodeEndFile(ev) {
    const fallback = { reason: END_REASON.EOF, error: 0 };
    if (!ev || !ev.data) return fallback;
    try {
      if (ev.data.reason !== undefined) return { reason: ev.data.reason, error: ev.data.error };
      return koffi.decode(ev.data, MPV_EVENT_END_FILE);
    } catch (e) {
      return fallback;
    }
  }

  /** 排空事件队列，逐个交给回调。 */
  pump(onEvent) {
    if (!this.ctx) return;
    for (let i = 0; i < 200; i++) {
      const ev = this.waitEvent(0);
      if (!ev) break;
      onEvent(ev);
      if (ev.event_id === EVENT.SHUTDOWN) break;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ctx) {
      try {
        this.api.terminateDestroy(this.ctx);
      } catch (e) { /* 忽略退出阶段的异常 */ }
      this.ctx = null;
    }
  }
}

// --------------------------------------------------------------- 播放器 ---
class MpvPlayer extends MpvHandle {
  /**
   * @param binDir        mpv 运行时目录（含 libmpv-2.dll 及其依赖）
   * @param containerHwnd 视频承载窗口句柄（bigint）
   * @param configDir     mpv 配置目录（便携配置）
   */
  constructor({ binDir, containerHwnd, configDir }) {
    super(binDir);

    const opts = [
      // 嵌入：把 mpv 的窗口挂到宿主的视频承载窗口下
      ['wid', containerHwnd.toString()],
      // 配置：沿用 bin\portable_config，但不加载任何 Lua 脚本（OSD 面板由网页接管）
      ['config', 'yes'],
      ['config-dir', configDir],
      ['load-scripts', 'no'],
      // 界面：内置 OSC / 鼠标绑定全部关掉，交由宿主统一处理
      ['osc', 'no'],
      ['osd-level', '0'],
      ['input-default-bindings', 'no'],
      ['input-builtin-bindings', 'no'],
      ['input-cursor', 'no'],
      ['cursor-autohide', 'no'],
      // 行为：空闲不退出、播完停在最后一帧（由宿主决定要不要连播）
      ['idle', 'yes'],
      ['force-window', 'yes'],
      ['keep-open', 'yes'],
      ['keep-open-pause', 'no'],
      ['terminal', 'no'],
      ['msg-level', 'all=error'],
      // 音频：倍速时保持音调（mpv 基于 scaletempo2，能避免 1.5x/2x 的尖锐人声）
      ['audio-pitch-correction', 'yes'],
      // 画质
      ['hwdec', 'auto-safe'],
      ['sub-auto', 'fuzzy'],
      ['save-position-on-quit', 'no'],
    ];
    for (const [k, v] of opts) {
      const r = this.setOption(k, v);
      if (r < 0) console.warn(`[mpv] 选项 ${k}=${v} 被拒绝（错误码 ${r}）`);
    }
    this.initialize();
    this.api.requestLogMessages(this.ctx, 'error');

    // 观察核心属性：mpv 主动推 PropertyChange，UI 侧不需要定时器轮询
    this.requestEvent(EVENT.PROPERTY_CHANGE, true);
    for (const [name, format, id] of OBSERVED) {
      const r = this.observe(name, format, id);
      if (r < 0) console.warn(`[mpv] 观察属性 ${name} 失败（错误码 ${r}）`);
    }
  }

  loadFile(file) {
    // 用数组形式调用，路径不需要任何转义
    return this.commandAsync('loadfile', file, 'replace');
  }

  playPause() { return this.commandAsync('cycle', 'pause'); }
  pause(on) { return this.commandAsync('set', 'pause', on ? 'yes' : 'no'); }
  stop() { return this.commandAsync('stop'); }
  seek(seconds, mode = 'relative') {
    return this.commandAsync('seek', String(seconds), mode);
  }
  seekAbsolute(seconds, flags = 'absolute') {
    return this.commandAsync('seek', String(seconds), flags);
  }
  setVolume(v) { return this.commandAsync('set', 'volume', String(v)); }
  setMute(on) { return this.commandAsync('set', 'mute', on ? 'yes' : 'no'); }
  setSpeed(v) { return this.commandAsync('set', 'speed', String(v)); }

  /** 视频原始尺寸，用于画中画窗口按真实宽高比缩放到小窗。 */
  videoSize() {
    const w = this.getInt64('video-params/w');
    const h = this.getInt64('video-params/h');
    return (w && h) ? { w, h } : null;
  }

  /** 播放状态快照，供 UI 渲染。 */
  snapshot() {
    return {
      timePos: this.getDouble('time-pos'),
      duration: this.getDouble('duration'),
      paused: this.getFlag('pause'),
      idle: this.getFlag('idle-active'),
      volume: this.getDouble('volume'),
      muted: this.getFlag('mute'),
      speed: this.getDouble('speed'),
      percent: this.getDouble('percent-pos'),
    };
  }
}

// ------------------------------------------------------------- 缩略图实例 ---
/**
 * 第三个 libmpv 实例：只为「进度条悬停缩略图」服务。
 * 它有自己独立的画面（挂在预览小窗的承载窗口下），静音、暂停、
 * 宿主在鼠标悬停时用 absolute+exact 精确 seek 到对应时间点，
 * 由 GPU 直接解码出那一帧，比截图/编码方案快得多。
 */
class MpvThumb extends MpvHandle {
  constructor({ binDir, containerHwnd }) {
    super(binDir);
    const opts = [
      ['wid', containerHwnd.toString()],
      ['config', 'no'],
      ['load-scripts', 'no'],
      ['vo', 'gpu'],
      ['ao', 'null'],
      ['audio', 'no'],
      ['mute', 'yes'],
      ['pause', 'yes'],
      ['keep-open', 'yes'],
      ['force-window', 'yes'],
      ['idle', 'yes'],
      ['osc', 'no'],
      ['osd-level', '0'],
      ['input-default-bindings', 'no'],
      ['input-builtin-bindings', 'no'],
      ['input-cursor', 'no'],
      ['cursor-autohide', 'no'],
      ['terminal', 'no'],
      ['msg-level', 'all=fatal'],
      ['hwdec', 'auto-safe'],
      ['sub', 'no'],
    ];
    for (const [k, v] of opts) this.setOption(k, v);
    this.initialize();
    this.loaded = '';
  }

  load(file) {
    if (this.loaded === file) return 0;
    this.loaded = file;
    return this.commandAsync('loadfile', file, 'replace');
  }

  /** 精确跳到某一秒（带 exact，得到的是这一帧而不是最近关键帧）。 */
  seekTo(seconds) {
    return this.commandAsync('seek', String(seconds), 'absolute+exact');
  }
}

// ----------------------------------------------------------- 时长探测器 ---
/**
 * 第二个 libmpv 实例：无画面无声音，只做「后台扫时长」。
 * 一个文件一个文件地 loadfile → 等 FILE_LOADED → 读 duration → 下一个，
 * 空闲时自动推进，UI 侧逐个收到时长后即时刷新列表。
 */
class MpvProbe extends MpvHandle {
  constructor({ binDir }) {
    super(binDir);
    const opts = [
      ['config', 'no'],
      ['load-scripts', 'no'],
      ['vo', 'null'],
      ['ao', 'null'],
      ['idle', 'yes'],
      ['pause', 'yes'],
      ['keep-open', 'yes'],
      ['force-window', 'no'],
      ['terminal', 'no'],
      ['msg-level', 'all=fatal'],
      ['hwdec', 'no'],
    ];
    for (const [k, v] of opts) this.setOption(k, v);
    this.initialize();

    this.queue = [];
    this.current = null;
    this.busy = false;
    this.onDuration = null;
    this.stopped = false;
  }

  /** 用新队列替换旧队列（切目录时直接覆盖即可）。 */
  enqueue(items) {
    this.queue = items.slice();
    this._advance();
  }

  clear() {
    this.queue = [];
    this.current = null;
    this.busy = false;
  }

  /** 由主进程的事件泵调用。 */
  handleEvent(ev) {
    if (ev.event_id === EVENT.FILE_LOADED || ev.event_id === EVENT.END_FILE ||
        ev.event_id === EVENT.IDLE) {
      if (this.current && this.busy) {
        const d = this.getDouble('duration');
        const item = this.current;
        this.current = null;
        if (this.onDuration && d && isFinite(d) && d > 0) this.onDuration(item.id, d);
      }
      this.busy = false;
      this._advance();
    }
  }

  _advance() {
    if (this.stopped || this.busy || !this.queue.length) return;
    const item = this.queue.shift();
    this.current = item;
    this.busy = true;
    try {
      this.commandAsync('loadfile', item.path, 'replace');
    } catch (e) {
      this.busy = false;
      this.current = null;
    }
  }

  destroy() {
    this.stopped = true;
    super.destroy();
  }
}

module.exports = {
  MpvPlayer,
  MpvProbe,
  MpvThumb,
  EVENT,
  END_REASON,
  FORMAT,
  OBSERVED,
};
