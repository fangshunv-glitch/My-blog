// 最小视口撑宽探针：谁在逼着布局视口变宽
// 用法：node tools/probe_w.mjs <url> <宽>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, w = '390'] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9335);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));

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

const PROBE = `(function(){
  var d = document.documentElement;
  var before = window.innerWidth;
  var out = { before: before, scrollW: d.scrollWidth };
  // 逐类关掉可疑的东西，看布局视口会不会缩回去
  function try2(label, css) {
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
    var v = window.innerWidth;
    s.remove();
    out[label] = v;
  }
  try2('noInfoDot', '.info-dot{display:none!important}');
  try2('noTabs', '.admin-tabs,.auth-tabs{display:none!important}');
  try2('noForm2', '.form-row-2{display:block!important}');
  try2('noAdmBar', '.adm-bar{display:none!important}');
  // 最宽的若干元素（只算还在文档流里的）
  var wide = [];
  Array.prototype.forEach.call(document.querySelectorAll('body *'), function(n){
    var r = n.getBoundingClientRect();
    if (r.width > before - 4) {
      wide.push((n.id || n.className || n.tagName) + '=' + Math.round(r.width));
    }
  });
  out.wide = wide.slice(0, 10);
  return out;
})()`;

try {
  await waitPort();
  const tab = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
    width: Number(w), height: 900, deviceScaleFactor: 1, mobile: true,
  });
  await rpc(ws, 'Page.navigate', { url });
  await sleep(2500);
  const r = await rpc(ws, 'Runtime.evaluate', { returnByValue: true, expression: PROBE });
  console.log(JSON.stringify(r.result.value, null, 1));
  ws.close();
} finally {
  chrome.kill();
}
