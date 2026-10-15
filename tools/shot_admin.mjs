// 后台面板体检（一次性工具）
// ============================================================
// admin.html 的编辑面板藏在两道 hidden 后面（#admin-panel 要登录，pane 要切 tab），
// 所以直接用 shot.mjs 截不到。这里在截图前用 JS 把它们强制显形，
// 只为看布局有没有崩，不代表权限逻辑。
//
// 用法：node tools/shot_admin.mjs <pane> [宽] [高] [输出文件] [点开第几个 info-dot]
//   pane: posts | photos
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [pane = 'posts', w = '1200', h = '900', out = `adm_${pane}.png`,
       dot = ''] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9334);
const URL = 'http://127.0.0.1:8781/admin.html';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-adm-'));

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

const REVEAL = `(function(){
  // 面板外头还套着几层容器（有的用 hidden 属性，有的靠 CSS 类），
  // 光解开 #admin-panel 一层不够，得顺着祖先链一路放行。
  var n = document.getElementById('admin-panel');
  while (n && n !== document.body) {
    n.hidden = false;
    if (getComputedStyle(n).display === 'none') n.style.display = 'block';
    n = n.parentElement;
  }
  ['admin-list','private-pane','posts-pane','photos-pane'].forEach(function(id){
    var e = document.getElementById(id);
    if (e) e.hidden = (id !== '${pane}-pane');
  });
  var c = document.getElementById('admin-count'); if (c) c.hidden = true;
  var pane = document.getElementById('${pane}-pane');
  if (pane) window.scrollTo(0, pane.getBoundingClientRect().top + window.scrollY - 12);
  return {
    panelDisplay: (function(){ var p = document.getElementById('admin-panel');
                               return p ? getComputedStyle(p).display : null; })(),
    paneDisplay: pane ? getComputedStyle(pane).display : null,
    panelParent: (function(){ var p = document.getElementById('admin-panel');
                              return p && p.parentElement ? p.parentElement.id
                                   + '|' + p.parentElement.className : null; })()
  };
})()`;

try {
  await waitPort();
  const tab = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
    width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 600,
  });
  await rpc(ws, 'Page.navigate', { url: URL });
  await sleep(2500);
  await rpc(ws, 'Runtime.evaluate', { expression: REVEAL });
  // 需要看 ⓘ 弹层时，把第 N 个圆点点开（真点，走的是页面上那套委托）
  if (dot !== '') {
    await rpc(ws, 'Runtime.evaluate', {
      expression: `(function(){
        var d = document.querySelectorAll('.info-dot')[${Number(dot)}];
        if (d) { d.scrollIntoView({ block: 'center' }); d.click(); }
        return !!d;
      })()`,
    });
  }
  await sleep(500);

  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

  const probe = await rpc(ws, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(function(){
      var d = document.documentElement;
      var pane = document.getElementById('${pane}-pane');
      // 面板里有没有元素戳出容器右边（横溢出的典型症状）
      var over = [];
      if (pane) Array.prototype.forEach.call(pane.querySelectorAll('*'), function(n){
        var r = n.getBoundingClientRect();
        if (r.width && r.right > d.clientWidth + 1) {
          over.push((n.id || n.className || n.tagName) + '@' + Math.round(r.right));
        }
      });
      return { overflow: d.scrollWidth > window.innerWidth + 1,
               scrollW: d.scrollWidth, innerW: window.innerWidth,
               paneHidden: pane ? pane.hidden : null,
               paneH: pane ? Math.round(pane.getBoundingClientRect().height) : null,
               infoDots: document.querySelectorAll('.info-dot').length,
               // 弹层是 ::after，拿不到它的 rect；但它会撑大 scrollWidth，
               // 所以上面的 overflow 就是它的越界检查。这里记一下圆点位置好判断方向。
               dotAt: (function(){
                 var on = document.querySelector('.info-dot.on');
                 if (!on) return null;
                 var r = on.getBoundingClientRect();
                 return Math.round(r.left) + ',' + Math.round(r.top);
               })(),
               spill: over.slice(0, 8) };
    })()`,
  });
  console.log(out, JSON.stringify(probe.result.value));
  ws.close();
} finally {
  chrome.kill();
}
