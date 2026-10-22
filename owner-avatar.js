/*!
 * 像素日常 · 站点头像（owner-avatar.js）
 * ======================================
 * 侧栏「关于我」和关于页顶部那张头像，原来永远是构建期生成的那张
 * assets/avatar.png —— 站长在账号页传了新头像，这两处也不会变。
 *
 * 现在改成从云端读：avatars 表里 is_site = true 的那一行就是站点头像。
 * 站长在账号页保存头像时会顺手把这个标记置上（见 login.js 的 markSiteAvatar）。
 *
 * 为什么用 REST 直连而不用 SDK：
 *   跟 foot-stats.js 一样，只要一行数据，犯不上为它加载整个 SDK。
 *   而且这个脚本挂在页脚、全站都有，包括不加载 cloud.js 的封面页。
 *
 * 为什么不在 avatars 表上按 uid 硬查：
 *   站长的 uid 只有登录后自己看得到（site_admins 策略只放行自己那行），
 *   访客拿不到；而头像本身是公开的，用 is_site 标记正好。
 *
 * 读不到 / 没设头像就不动，保留静态图 —— 页面不会出现一个空头像框。
 */
(function () {
  'use strict';

  var C = window.PIXEL_CLOUD_CONFIG || {};
  if (!C.endpoint || !C.publishableKey) return;

  var REST = String(C.endpoint).replace(/\/+$/, '') + '/.cloud/database/rest';

  // 头像地址会被塞进 img.src。虽然 src 里塞 javascript: 现代浏览器不执行，
  // 但这张表谁都能写自己那一行，所以只认规规矩矩的 base64 图片。
  var SAFE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/;

  function boot() {
    var slots = document.querySelectorAll('img[data-site-avatar]');
    if (!slots.length) return;

    fetch(REST + '/avatars?select=data&is_site=eq.true&limit=1', {
      headers: { 'x-wb-webapp-access-key': C.publishableKey }
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (rows) {
        var data = rows && rows[0] && rows[0].data;
        if (!SAFE.test(String(data || ''))) return;
        for (var i = 0; i < slots.length; i++) slots[i].src = data;
      })
      .catch(function () {});   // 取不到就保持静态图，不用提示
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
