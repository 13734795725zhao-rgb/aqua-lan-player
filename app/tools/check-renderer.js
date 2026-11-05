/**
 * 静态一致性检查：渲染层 HTML 里定义的 id，
 * 与对应 JS 里 $('#xxx') / querySelector('#xxx') 的引用是否对得上。
 * 不启动 Electron，纯文本比对，用于改完控件后快速自查。
 *
 *   node tools/check-renderer.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
let problems = 0;

for (const file of fs.readdirSync(RENDERER)) {
  if (!file.endsWith('.html')) continue;
  const html = fs.readFileSync(path.join(RENDERER, file), 'utf8');
  const jsFile = file.replace(/\.html$/, '.js');
  const jsPath = path.join(RENDERER, jsFile);
  if (!fs.existsSync(jsPath)) {
    console.log(`[跳过] ${file} 没有对应的 ${jsFile}`);
    continue;
  }
  const js = fs.readFileSync(jsPath, 'utf8');

  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);

  const refs = new Set();
  for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) refs.add(m[1]);
  for (const m of js.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)) refs.add(m[1]);

  const missing = [...refs].filter((id) => !ids.has(id));
  if (missing.length) {
    problems++;
    console.log(`[FAIL] ${jsFile} 引用了不存在的 id: ${missing.join(', ')}`);
  } else {
    console.log(`[ OK ] ${jsFile}：${refs.size} 个 id 引用全部命中（页面共 ${ids.size} 个 id）`);
  }

  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const p = path.join(RENDERER, m[1]);
    if (!fs.existsSync(p)) {
      problems++;
      console.log(`[FAIL] ${file} 引用的脚本不存在: ${m[1]}`);
    }
  }
  for (const m of html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)) {
    const p = path.join(RENDERER, m[1]);
    if (!fs.existsSync(p)) {
      problems++;
      console.log(`[FAIL] ${file} 引用的样式不存在: ${m[1]}`);
    }
  }
}

console.log(problems === 0 ? '\n渲染层引用全部一致' : `\n${problems} 处不一致`);

// ------------------------------------------------------- IPC 通道比对 ---
const MAIN = path.join(__dirname, '..', 'src', 'main', 'main.js');
const mainSrc = fs.readFileSync(MAIN, 'utf8');
const handled = new Set();
for (const m of mainSrc.matchAll(/ipcMain\.(?:on|handle)\('([^']+)'/g)) handled.add(m[1]);

const used = new Set();
for (const file of fs.readdirSync(RENDERER)) {
  if (!file.endsWith('.js')) continue;
  const js = fs.readFileSync(path.join(RENDERER, file), 'utf8');
  for (const m of js.matchAll(/aqua\.(?:send|invoke)\('([^']+)'/g)) used.add(m[1]);
}

const unhandled = [...used].filter((c) => !handled.has(c));
if (unhandled.length) {
  problems++;
  console.log(`[FAIL] 渲染层发送了主进程没接的通道: ${unhandled.join(', ')}`);
} else {
  console.log(`[ OK ] IPC 通道：渲染层用到的 ${used.size} 个通道主进程都有处理`);
}

console.log(problems === 0 ? '全部检查通过' : `${problems} 处问题`);
process.exit(problems === 0 ? 0 : 1);
