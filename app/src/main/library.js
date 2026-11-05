'use strict';

/**
 * 目录遍历：异步扫描视频文件。
 *
 * 产出 {id, name, path, size, ext, mtime, dir, hasSubs, hasAudio}：
 *   - 只做「轻量」信息（名字/大小/修改时间），秒级呈现；
 *   - 精确时长由后台的第二个 libmpv 实例逐个补齐（见 mpv.js 的 MpvProbe）；
 *   - 同目录的同名 .srt/.ass/.vtt 字幕与 .m4a/.aac 音轨会被识别出来，
 *     在列表上点亮 CC / 音轨徽标。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.flv', '.avi', '.webm', '.m4v', '.mpg', '.mpeg',
  '.ts', '.m2ts', '.wmv', '.rmvb', '.rm', '.vob', '.3gp', '.ogv', '.mts',
  '.av1', '.hevc', '.divx', '.f4v', '.asf', '.dat', '.nsv', '.y4m',
]);

/** 伴生字幕 */
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx']);
/** 外部音轨 / 解说轨 */
const AUDIO_EXT = new Set(['.m4a', '.aac', '.mp3', '.flac', '.wav', '.ogg', '.opus', '.mka']);

const MAX_FILES = 20000;
const MAX_DEPTH = 6;

function isVideo(name) {
  return VIDEO_EXT.has(path.extname(name).toLowerCase());
}

/** 取文件主名（小写），用于匹配同名伴生文件 */
function baseName(name) {
  const ext = path.extname(name);
  return (ext ? name.slice(0, -ext.length) : name).toLowerCase();
}

/**
 * @param dir        要扫描的目录
 * @param recursive  是否递归子目录
 * @param onProgress 每扫到 200 个回调一次
 */
async function scanFolder(dir, recursive, onProgress) {
  const items = [];
  let stopped = false;

  async function walk(current, depth) {
    if (stopped || items.length >= MAX_FILES) {
      stopped = true;
      return;
    }
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (e) {
      return; // 无权限 / 路径消失（拔盘），跳过
    }

    // 先做一遍「同目录伴生文件」索引
    const subs = new Set();
    const audios = new Set();
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (SUB_EXT.has(ext)) subs.add(baseName(e.name));
      else if (AUDIO_EXT.has(ext)) audios.add(baseName(e.name));
    }

    const dirs = [];
    for (const entry of entries) {
      if (items.length >= MAX_FILES) { stopped = true; break; }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < MAX_DEPTH && !entry.name.startsWith('.')) dirs.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      if (!isVideo(entry.name)) continue;

      let size = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
      } catch (e) { /* 忽略 */ }

      const bn = baseName(entry.name);
      items.push({
        id: full,
        name: entry.name,
        path: full,
        dir: current,
        size,
        mtime,
        ext: path.extname(entry.name).toLowerCase().replace('.', '').toUpperCase(),
        duration: 0,
        hasSubs: subs.has(bn),
        hasAudio: audios.has(bn),
      });
      if (items.length % 200 === 0 && onProgress) onProgress(items.length);
    }

    for (const d of dirs) await walk(d, depth + 1);
  }

  await walk(dir, 0);

  // 默认自然排序（01/02 顺序正确），渲染层还可以按用户选择重新排
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', {
    numeric: true, sensitivity: 'base',
  }));
  return items;
}

/** 取某个视频的伴生字幕 / 音轨文件（同名同目录） */
function findCompanions(filePath) {
  const dir = path.dirname(filePath);
  const bn = baseName(path.basename(filePath));
  const out = { subs: [], audios: [] };
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return out;
  }
  for (const name of entries) {
    if (baseName(name) !== bn) continue;
    const ext = path.extname(name).toLowerCase();
    if (SUB_EXT.has(ext)) out.subs.push(path.join(dir, name));
    else if (AUDIO_EXT.has(ext)) out.audios.push(path.join(dir, name));
  }
  return out;
}

module.exports = { scanFolder, isVideo, findCompanions, VIDEO_EXT, SUB_EXT, AUDIO_EXT, MAX_FILES };
