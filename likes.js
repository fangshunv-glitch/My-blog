/*!
 * 像素日常 · 点赞（likes.js）
 * ============================
 * 文章卡片和文章详情下面那颗心。以前只能用评论说话，「看过、不错」这种
 * 一秒钟的态度没有地方表达 —— 补上。
 *
 * 数据在云端 likes 表：一行 = 一个人赞了一个东西。
 *   target_kind  post / photo
 *   target_key   文章的 slug，或照片 id
 *   uid          默认值 auth.uid()，客户端不传（伪造不了）
 *   唯一约束 (kind, key, uid) —— 同一个人重复点会撞 23505，正好当「已经赞过」
 *
 * 读用 REST 直连：赞的数量是公开信息，谁都能看到，不必为它加载什么；
 * 而且这个脚本挂在页脚、全站都有，包括没引 SDK 的封面页（那种页面没有
 * 按钮，脚本会自己退出）。
 *
 * 写用 SDK：点赞要认人，SDK 手里有登录态，会自己带上令牌。
 */
(function () {
  'use strict';

  var C = window.PIXEL_CLOUD_CONFIG || {};
  if (!C.endpoint || !C.publishableKey) return;

  var D = window.SITE_DATA || {};
  var BASE = D.base || '';
  var REST = String(C.endpoint).replace(/\/+$/, '') + '/.cloud/database/rest';
  var HDR = { 'x-wb-webapp-access-key': C.publishableKey };

  var CNT = {};        // 'post:slug' → 赞数
  var MINE = {};       // 'post:slug' → true 表示我赞过
  var RAW = [];        // [{ k, uid }]，拿到自己的 uid 之后再算 MINE
  var ME = '';         // 我的 uid；空 = 没登录
  var busy = {};       // 'post:slug' → true，防止连点
  var loaded = false;

  // -------------------------------------------------------------------------
  // SDK：只在写的时候用
  // -------------------------------------------------------------------------
  var _sdk = null;
  function sdk() {
    if (_sdk) return _sdk;
    var S = window.WorkBuddyCloud;
    if (!S || typeof S.createWorkBuddyCloud !== 'function') throw new Error('SDK_MISSING');
    _sdk = S.createWorkBuddyCloud(C);
    return _sdk;
  }
  function db() { return sdk().database; }
  function run(q) {
    return Promise.resolve(q).then(function (res) {
      if (res && res.error) throw res.error;
      return res && res.data ? res.data : [];
    });
  }

  // 我是谁：profiles 的策略只放行自己那一行，所以查到的就是自己。
  // 跟 login.js 一个路子 —— 不去解 JWT，也不用 getUser()（它给的 id 常是空的）。
  function myUid() {
    if (typeof window.WorkBuddyCloud === 'undefined') return Promise.resolve('');
    try {
      return run(db().from('profiles').select('uid').limit(1))
        .then(function (rows) { return (rows && rows[0] && rows[0].uid) || ''; },
              function () { return ''; });
    } catch (e) { return Promise.resolve(''); }
  }

  // -------------------------------------------------------------------------
  // 读：一次把全表拉回来（几百行的量级），统计计数 + 我赞过哪些
  // -------------------------------------------------------------------------
  function load() {
    return fetch(REST + '/likes?select=target_kind,target_key,uid&limit=3000', { headers: HDR })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (rows) {
        RAW = (rows || []).map(function (x) {
          return { k: x.target_kind + ':' + x.target_key, uid: String(x.uid || '') };
        });
        loaded = true;
        recount();
        paint();          // 读完要立刻画，否则要等下一次 refresh 才看得到数字
      })
      .catch(function () {
        // 拿不到就当没有赞 —— 按钮显示 0，点了还能写进去，不用报错吓人
        RAW = [];
        loaded = true;
        recount();
        paint();
      });
  }

  function recount() {
    CNT = {};
    MINE = {};
    for (var i = 0; i < RAW.length; i++) {
      var r = RAW[i];
      CNT[r.k] = (CNT[r.k] || 0) + 1;
      if (ME && r.uid === ME) MINE[r.k] = true;
    }
  }

  // -------------------------------------------------------------------------
  // 画：所有带 data-like 的按钮照同一份数据刷新
  // -------------------------------------------------------------------------
  function paint() {
    var btns = document.querySelectorAll('[data-like]');
    for (var i = 0; i < btns.length; i++) {
      var bt = btns[i];
      var k = bt.getAttribute('data-like');
      var n = CNT[k] || 0;
      var on = !!MINE[k];
      bt.classList.toggle('on', on);
      bt.setAttribute('aria-pressed', on ? 'true' : 'false');
      bt.setAttribute('title', on ? '取消赞' : '赞一下');
      var num = bt.querySelector('.lk-n');
      if (num) num.textContent = n > 0 ? String(n) : '赞';
    }
  }

  // 页面里有按钮才值得去读。封面页那种没有按钮的页面，一个请求都不发。
  function refresh() {
    return READY.then(function () {
      if (!document.querySelector('[data-like]')) return;
      return loaded ? paint() : load();
    });
  }

  // -------------------------------------------------------------------------
  // 点：乐观更新，失败再翻回去
  // -------------------------------------------------------------------------
  function bump(k, delta) {
    CNT[k] = Math.max(0, (CNT[k] || 0) + delta);
    if (delta > 0) MINE[k] = true; else delete MINE[k];
    paint();
  }

  function toggle(k) {
    var cut = k.indexOf(':');
    if (cut < 0) return;
    var kind = k.slice(0, cut);
    var key = k.slice(cut + 1);

    if (!ME) {
      // 没登录：去登录页，回来还能找到这一页
      location.href = BASE + 'login.html';
      return;
    }
    if (busy[k]) return;
    busy[k] = true;

    var on = !!MINE[k];
    bump(k, on ? -1 : 1);

    var q = on
      ? db().from('likes').delete()
          .eq('target_kind', kind).eq('target_key', key).eq('uid', ME)
      : db().from('likes').insert({ target_kind: kind, target_key: key });

    run(q).then(function () {
      busy[k] = false;
      // 重新读一遍：别人也可能同时赞了，本地算的未必准
      return load();
    }, function (err) {
      busy[k] = false;
      // 23505 = 已经赞过（多半是另一个标签页点过了），那就当成功
      if (err && String(err.code) === '23505') { MINE[k] = true; paint(); return; }
      bump(k, on ? 1 : -1);            // 回滚
      var tip = document.getElementById('like-msg');
      if (tip) {
        tip.textContent = (err && err.code === '42501')
          ? '赞没存上 —— 登录状态可能掉了，刷新一下再试。'
          : '赞没存上，网络不太顺，稍后再点一下。';
        tip.hidden = false;
        setTimeout(function () { tip.hidden = true; }, 4000);
      }
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document.documentElement) {
      if (t.getAttribute && t.getAttribute('data-like')) {
        e.preventDefault();
        toggle(t.getAttribute('data-like'));
        return;
      }
      t = t.parentNode;
    }
  });

  // 身份先读一次，之后所有画图都等它 —— 否则按钮先画出来「没赞过」，
  // 半秒后又跳成「赞过」，看着像闪了一下。
  var READY = (typeof window.WorkBuddyCloud === 'undefined')
    ? Promise.resolve('')
    : myUid().then(function (uid) { ME = uid; return uid; });

  // feed.js 的卡片是异步渲染的，第一次跑的时候页面上很可能一个按钮都还没有。
  // 这里盯着点赞按钮的数量：数量一变就重画一次（paint 只改文字不动按钮，
  // 所以不会自己触发自己）。比「猜它几秒渲染完」靠谱。
  var lastBtnCount = 0;

  function maybeRefresh() {
    var n = document.querySelectorAll('[data-like]').length;
    if (n === lastBtnCount) return;
    lastBtnCount = n;
    refresh();
  }

  function boot() {
    refresh();
    lastBtnCount = document.querySelectorAll('[data-like]').length;
    if (typeof MutationObserver === 'undefined') return;
    var timer = null;
    var ob = new MutationObserver(function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(maybeRefresh, 120);
    });
    ob.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // feed.js 渲染完卡片会叫一声，让它跟着重画
  window.PixelLikes = { refresh: refresh, reload: load };
})();
