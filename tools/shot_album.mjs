// 相册大图查看器截图（CDP）
// ============================================================
// 相册里的大图是点开才从云端拉 image_data 的，普通截图工具截不到——
// 它会停在「正在读取大图…」那一行。这个脚本负责把整条链路走完再拍：
// 打开相册 → 等照片卡片渲染 → 点第 N 张 → 等大图真正到位 → 可选往右翻几张。
//
// 用法：
//   node tools/shot_album.mjs <url> [第几张] [翻几次] [宽] [高] [输出] [mobile]
// 例：
//   node tools/shot_album.mjs http://127.0.0.1:8781/album.html 2 0 1200 860 lb.png
//   node tools/shot_album.mjs http://127.0.0.1:8781/album.html 1 2 390 844 lb_m.png mobile
//
// 前置：先起本地服务（python -m http.server 8781）。第几张从 1 开始数。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, nth = '1', jump = '0', w = '1200', h = '860',
       out = 'shot_album.png', mobile] = process.argv.slice(2);
if (!url) {
  console.error('用法：node tools/shot_album.mjs <url> [第几张] [翻几次] [宽] [高] [输出] [mobile]');
  process.exit(1);
}

const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9337);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-album-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return; }
    catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('CDP 端口没起来');
}

let seq = 0;
function rpc(ws, method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalIn(ws, expression) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.value;
}

// 轮询等条件成立。照片是从云端的棋盘 형 less than 1s，但偶尔会慢，别写死 sleep。
async function waitFor(ws, expression, tries = 40, gap = 250) {
  for (let i = 0; i < tries; i++) {
    if (await evalIn(ws, expression)) return true;
    await sleep(gap);
  }
  return false;
}

try {
  await waitPort();
  const tab = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
    width: Number(w), height: Number(h), deviceScaleFactor: 1,
    mobile: mobile === undefined ? Number(w) < 600 : mobile !== '0',
  });
  await rpc(ws, 'Page.navigate', { url });

  const hasCards = await waitFor(ws,
    `document.querySelectorAll('.photo-card').length > 0`, 60, 250);
  if (!hasCards) console.error('没等到照片卡片（云端没数据？）');

  await evalIn(ws, `(function(){
    var c = document.querySelectorAll('.photo-card')[${Number(nth) - 1}];
    if (c) c.click();
  })()`);

  const hasImg = await waitFor(ws,
    `!!document.querySelector('.pixel-lightbox .lb-stage img')`, 60, 250);
  if (!hasImg) console.error('没等到大图（image_data 没读到？）');
  await sleep(700);

  for (let i = 0; i < Number(jump); i++) {
    await evalIn(ws, `(function(){
      var b = document.querySelector('.pixel-lightbox .lb-next');
      if (b) b.click();
    })()`);
    await sleep(900);
  }

  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

  const probe = await evalIn(ws, `(function(){
    var img = document.querySelector('.pixel-lightbox .lb-full');
    var th = document.querySelector('.pixel-lightbox .lb-thumb');
    function box(s){var e=document.querySelector(s);if(!e)return null;
      var r=e.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height)+'@'+Math.round(r.left)+','+Math.round(r.top);}
    return {
      full: box('.pixel-lightbox .lb-full'),
      fullNatural: img ? img.naturalWidth + 'x' + img.naturalHeight : null,
      fullSrcLen: img ? String(img.src || '').length : null,
      fullComplete: img ? img.complete : null,
      fullReady: img ? img.classList.contains('ready') : null,
      thumb: box('.pixel-lightbox .lb-thumb'),
      stage: box('.pixel-lightbox .lb-stage'),
      view: box('.pixel-lightbox .lb-view'),
      side: box('.pixel-lightbox .lb-side'),
      next: box('.pixel-lightbox .lb-next'),
      prev: box('.pixel-lightbox .lb-prev'),
      count: (document.querySelector('.pixel-lightbox .lb-count')||{}).textContent,
      album: box('.pixel-lightbox .lb-album'),
      single: (function(){var b=document.getElementById('pixel-lightbox');
        return b ? b.classList.contains('lb-single') : null;})(),
      bg: (function(){var b=document.getElementById('pixel-lightbox');
        return b ? getComputedStyle(b).backgroundColor : null;})(),
      bodyOverflow: getComputedStyle(document.body).overflow,
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  })()`);
  console.log(out, JSON.stringify(probe, null, 1));
  ws.close();
} finally {
  chrome.kill();
}
