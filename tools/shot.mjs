// 真机视口截图 / 页面体检（CDP）
// ============================================================
// 为什么不用 `chrome --headless --window-size=390,844 --screenshot`？
// 那种跑法**不认 viewport meta**，会按 980px 的桌面布局宽度排版，
// 再用 390px 的窗口去裁 —— 出来的图看着像「文字被切掉」，
// 其实线上手机端完全正常。照着它去修，会修一个不存在的 bug。
// 必须用 CDP 的 Emulation.setDeviceMetricsOverride(mobile: true)。
//
// 用法：
//   node tools/shot.mjs <url> [宽] [高] [滚动Y] [输出文件] [mobile]
// 例：
//   node tools/shot.mjs http://127.0.0.1:8781/blog.html 390 844 0 m_blog.png
//   node tools/shot.mjs http://127.0.0.1:8781/posts/x.html 1200 900 600 d_post.png
// 会顺带打印 scrollWidth / 阅读进度条宽度 / 是否出现跑马灯，方便判断有没有横向溢出。
//
// 前置：先起一个本地服务（python -m http.server 8781）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, w = '1200', h = '900', scroll = '0', out = 'shot.png', mobile] = process.argv.slice(2);
if (!url) {
  console.error('用法：node tools/shot.mjs <url> [宽] [高] [滚动Y] [输出文件] [mobile]');
  process.exit(1);
}

const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-profile-'));

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
  await sleep(2500);
  if (Number(scroll)) await rpc(ws, 'Runtime.evaluate', { expression: `window.scrollTo(0, ${Number(scroll)})` });
  await sleep(600);

  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

  const probe = await rpc(ws, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(function(){
      var d = document.documentElement;
      var bar = document.querySelector('.px-readbar i');
      return { overflow: d.scrollWidth > window.innerWidth + 1,
               scrollW: d.scrollWidth, innerW: window.innerWidth,
               readbar: bar ? Math.round(parseFloat(bar.style.width)) : null,
               marquee: !!document.querySelector('.foot-marquee') };
    })()`,
  });
  console.log(out, JSON.stringify(probe.result.value));
  ws.close();
} finally {
  chrome.kill();
}
