/*!
 * 像素日常 · 页脚统计（foot-stats.js）
 * ====================================
 * 页脚那句「开站第 N 天 · 文章 N 篇 · 照片 N 张」，后两个数字由这里填。
 *
 * 为什么单独一个文件：
 *   页脚是全站都有的，包括封面 page（index.html）—— 而封面页连 SDK 都不加载，
 *   feed.js 也不在那儿。可静态 HTML 里这两个数字是**构建期的快照**，
 *   文章和照片全在云端，构建时永远是 0，所以不填就是错的。
 *
 * 为什么不用 SDK：
 *   只要一个「一共几行」的计数，犯不上为它加载整个 SDK。
 *   直接打数据库的 REST 接口，取 id 列数长度 —— 每行十几个字节，
 *   比拉正文（几十 KB）和缩略图（几十 KB）便宜得多。
 *
 * 读不到就保持静态值不动。宁可数字不动，也不要它显示一个假的 0。
 */
(function () {
  'use strict';

  var C = window.PIXEL_CLOUD_CONFIG || {};
  if (!C.endpoint || !C.publishableKey) return;

  var REST = String(C.endpoint).replace(/\/+$/, '') + '/.cloud/database/rest';

  function count(table, filter) {
    return fetch(REST + '/' + table + '?select=id&' + filter, {
      headers: { 'x-wb-webapp-access-key': C.publishableKey }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (rows) {
      return Array.isArray(rows) ? rows.length : null;
    });
  }

  function fill(id, n) {
    var node = document.getElementById(id);
    if (node && n !== null && n !== undefined && !isNaN(n)) node.textContent = n;
  }

  function boot() {
    if (!document.getElementById('foot-posts') && !document.getElementById('foot-photos')) return;

    // 和 feed.js 里的 PUBLIC 一个口径：能看见的才算。
    // 访客查不到 custom 的行（数据库策略挡着），所以这里对访客就是 public 的数量。
    count('posts', 'visibility=in.(public,custom)')
      .then(function (n) { fill('foot-posts', n); }, function () {});
    count('photos', 'visibility=eq.public')
      .then(function (n) { fill('foot-photos', n); }, function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
