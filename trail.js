/*!
 * 像素日常 · 访客足迹（trail.js）
 * ================================
 * 每次打开一个页面，往云端 site_events 记一条「谁看了哪一页」。
 * 站长在后台的「足迹」里能看到最近谁来串过门 —— 这是 QQ 空间最有人情味
 * 的一个功能，博客没有人气统计，写了半天不知道有没有人看。
 *
 * 三条规矩：
 *   1. **一次会话同一页只记一条**。用 sessionStorage 记着，来回点不刷数。
 *      不这么做，访客每刷新一次就是一条，一天能顶几百条。
 *   2. **只有站长读得到**。site_events 的策略是 pixel_is_admin()，
 *      访客写完当场就读不回来，别人也看不见自己或别人的足迹。
 *   3. **记不上就算了**。这是背景动作，任何失败都不许影响页面。
 *
 * 写用 SDK（有登录态就顺带记上是谁），首页这种没引 SDK 的页面
 * 退回到公开键直连，记成一位匿名访客。
 */
(function () {
  'use strict';

  var C = window.PIXEL_CLOUD_CONFIG || {};
  if (!C.endpoint || !C.publishableKey) return;

  var REST = String(C.endpoint).replace(/\/+$/, '') + '/.cloud/database/rest';

  // 这一页叫什么。带着 ?slug= 的文章页要单算 —— 否则所有文章都是 post.html，
  // 站长只知道自己被看了 30 次，不知道是哪一篇。
  function pageId() {
    var file = location.pathname.split('/').pop() || 'index.html';
    var m = /[?&]slug=([^&]*)/.exec(location.search);
    if (m) return file + '?slug=' + decodeURIComponent(m[1]);
    var c = /[?&]c=([^&]*)/.exec(location.search);
    if (c) return file + '?c=' + decodeURIComponent(c[1]);
    return file;
  }

  // 同一次会话里记过就不再记
  function once(id) {
    try {
      var KEY = 'pixel_trail';
      var seen = window.sessionStorage.getItem(KEY) || ',';
      if (seen.indexOf(',' + id + ',') >= 0) return false;
      window.sessionStorage.setItem(KEY, seen + id + ',');
      return true;
    } catch (e) {
      return true;    // 隐私模式下 sessionStorage 会抛错，那就照记
    }
  }

  function viaRest(row) {
    return fetch(REST + '/site_events', {
      method: 'POST',
      headers: {
        'x-wb-webapp-access-key': C.publishableKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row),
      keepalive: true
    }).then(function (r) { return r.ok; });
  }

  function viaSdk(row) {
    var S = window.WorkBuddyCloud;
    if (!S || typeof S.createWorkBuddyCloud !== 'function') return viaRest(row);
    var client = S.createWorkBuddyCloud(C);
    return Promise.resolve(client.database.from('site_events').insert(row))
      .then(function (res) {
        if (res && res.error) return viaRest(row);
        return true;
      }, function () { return viaRest(row); });
  }

  function boot() {
    var id = pageId();
    if (!id || !once(id)) return;
    // 后台自己不算足迹 —— 站长蹲在自己的管理页上调样式，不该出现在「谁来过」里
    if (/^(admin|login)\.html/.test(id)) return;
    Promise.resolve().then(function () {
      return viaSdk({ kind: 'view', detail: id.slice(0, 120) });
    }).catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
