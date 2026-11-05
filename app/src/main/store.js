'use strict';

/**
 * 极简配置持久化：userData\config.json，读写失败一律回退到默认值。
 *
 * 观看进度这类高频数据也走这里，所以 _flush 做了防抖，
 * 避免每记一次进度就往磁盘写一次。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  lastDir: '',
  sidebarWidth: 320,
  layout: 'overlay',     // 'overlay' 浮层式 | 'push' 推挤式
  theme: 'auto',         // 'auto' | 'dark' | 'light'
  recursive: true,
  volume: 70,
  muted: false,
  sidebarOpen: true,
  autoplayNext: true,
  bounds: null,

  // —— 目录多路管理 ——
  recentFolders: [],      // 最近访问（最多 5 条）
  pinnedFolders: [],      // 固定到快捷栏
  playMode: 'sequence',   // 'sequence' 顺序 | 'loop' 单曲循环 | 'shuffle' 乱序
  sortBy: 'name',         // 'name' | 'mtime' | 'duration' | 'progress'
  hideExt: false,         // 隐藏通用视频扩展名
  compact: false,         // 紧凑列表视图
  hiddenItems: [],        // 从列表中隐藏（不删磁盘文件）
  progress: {},           // 路径 → { pos, dur, pct, at }
};

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = Object.assign({}, DEFAULTS, this._read());
    this._timer = null;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._flush();
  }

  patch(obj) {
    Object.assign(this.data, obj);
    this._flush();
  }

  _flush() {
    if (this._timer) return;      // 防抖：进度更新很频繁
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      } catch (e) {
        console.warn('[store] 写入失败', e.message);
      }
    }, 400);
  }

  /** 立刻落盘（退出前用）。 */
  flushNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { /* 忽略 */ }
  }
}

module.exports = { Store, DEFAULTS };
