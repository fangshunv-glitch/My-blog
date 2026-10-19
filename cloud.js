/*!
 * 像素日常 · 云端互动模块
 * ============================
 * 负责「留言板」「文章评论」「侧边栏最近互动」的读取与提交。
 *
 * 设计原则：
 *   1. 页面里的静态内容只作降级打底——JS 一旦拿到云端数据就整块替换；
 *      拿不到（断网 / 脚本没加载）则原样保留，页面照样能看。
 *   2. 发言需要对身份：未登录时把表单换成登录引导，登录后只填内容。
 *   3. **提交时不带 uid、也不带昵称**。这两样都由数据库自己填：
 *      uid 走列默认值 auth.uid()，昵称走默认值 pixel_display_name()，
 *      行级策略再核对一遍。客户端硬塞的值只会被拒——所以伪造不出来。
 *   4. 所有写操作走数据库的行级安全策略，前端不做权限判断。
 *   5. 任何一条失败路径都要给出人能看懂的中文提示，不许静默失败。
 *
 * 依赖：本文件之前必须已经加载 WorkBuddy Cloud SDK（全局 WorkBuddyCloud）
 *       以及页面内联的 window.SITE_DATA（本站数据，由 build.py 注入）
 */
(function () {
  'use strict';

  // publicConfig —— 见 cloud-config.js（admin.js / login.js 共用同一份）
  var CONFIG = window.PIXEL_CLOUD_CONFIG || {};

  var LIMIT_TEXT = 800;
  var LIST_LIMIT = 100;     // 单页最多显示多少条

  var D = window.SITE_DATA || {};
  var AUTHOR = D.author || '站长';
  var BASE = D.base || '';
  var POSTS = D.posts || {};

  // 当前访客的身份。未登录时 name 为空。
  var ME = { uid: '', name: '', loggedIn: false };

  // 文章标题映射：feed.js 从数据库读到之后挂到 window.PIXEL_POSTS 上，
  // 这里优先用它；静态兜底的那份（SITE_DATA.posts）只在它还没到位时顶一下。
  function postMeta(slug) {
    if (window.PIXEL_POSTS && window.PIXEL_POSTS[slug]) return window.PIXEL_POSTS[slug];
    return POSTS[slug] || null;
  }

  // 侧边栏的「最近互动」要靠文章标题，而文章是 feed.js 异步读出来的。
  // 等它一声，但别死等——它要是挂了，3 秒后照常跑，顶多显示不出文章名。
  function whenPostsReady(cb) {
    if (window.PIXEL_POSTS_READY) { cb(); return; }
    var fired = false;
    function once() {
      if (fired) return;
      fired = true;
      window.removeEventListener('pixel:posts-ready', once);
      cb();
    }
    window.addEventListener('pixel:posts-ready', once);
    setTimeout(once, 3000);
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // -------------------------------------------------------------------------
  // 表情
  // -------------------------------------------------------------------------
  // 名单由 build.py 从 content.py 注入到 window.PIXEL_EMOJI。
  // 写法是 :smile: 这种短代码，渲染时换成 assets/emoji/<k>.png。
  var EMO_INDEX = {};
  (function () {
    var list = window.PIXEL_EMOJI || [];
    for (var i = 0; i < list.length; i++) EMO_INDEX[list[i].k] = list[i].n;
  })();

  function emoImg(key, title) {
    return '<img class="emo" src="' + BASE + 'assets/emoji/' + key + '.png"'
      + ' alt="' + esc(title) + '" title="' + esc(title) + '" loading="lazy">';
  }

  // 顺序很重要：先 esc 再做替换。反过来的话用户写个 <img onerror=...>
  // 就能直接插进页面了。
  function emo(text) {
    return esc(text).replace(/:([a-z][a-z_]{1,15}):/g, function (m, key) {
      return EMO_INDEX[key] ? emoImg(key, EMO_INDEX[key]) : m;
    });
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // 数据库返回的是 ISO 时间，转成本地时区的「年-月-日 时:分」
  function fmtTime(v) {
    var d = new Date(v);
    if (!v || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function trunc(s, n) {
    s = String(s == null ? '' : s).trim();
    return s.length <= n ? s : s.slice(0, n) + '…';
  }

  function el(id) {
    return document.getElementById(id);
  }

  function show(node, on) {
    if (node) node.hidden = !on;
  }

  // -------------------------------------------------------------------------
  // 云客户端
  // -------------------------------------------------------------------------
  var _sdk = null;

  function sdk() {
    if (_sdk) return _sdk;
    var S = window.WorkBuddyCloud;
    if (!S || typeof S.createWorkBuddyCloud !== 'function') {
      throw new Error('SDK_MISSING');
    }
    _sdk = S.createWorkBuddyCloud(CONFIG);
    return _sdk;
  }

  function db() { return sdk().database; }

  // 把 PostgREST 的 { data, error } 信封拆成 Promise
  function run(query) {
    return Promise.resolve(query).then(function (res) {
      if (res && res.error) throw res.error;
      return res && res.data ? res.data : [];
    });
  }

  function friendly(err) {
    if (!err) return '操作没成功，请稍后再试。';
    if (err.message === 'SDK_MISSING') return '云端脚本没加载成功——检查网络后刷新页面。';
    switch (err.kind) {
      case 'unauthenticated': return '登录状态已失效，重新登录一次再来。';
      case 'network':
      case 'backend-unavailable': return '网络不太顺，稍后再试。';
      default: break;
    }
    switch (err.code) {
      case '42501': return '服务器拒绝了这次操作——多半是登录状态掉了，重新登录一次。';
      case '23502': return '云端没认出你的身份。去账号页重新登录一次再试。';
      case '23505': return '这条内容已经提交过了。';
      case '42P01': return '云端还没准备好，请稍后再试。';
      default: break;
    }
    if (err.message && /fetch|network|Failed/i.test(err.message)) {
      return '连不上云端——检查网络后重试。';
    }
    return '操作没成功：' + (err.message || '未知错误');
  }

  // 加载失败时不清空页面，只在顶部挂一条提示
  function notice(box, msg) {
    if (!box || box.querySelector('.cloud-notice')) return;
    var d = document.createElement('div');
    d.className = 'cloud-notice';
    d.textContent = msg;
    box.insertBefore(d, box.firstChild);
  }

  // -------------------------------------------------------------------------
  // 身份：会话 + 昵称
  // -------------------------------------------------------------------------
  function currentUser() {
    return Promise.resolve(sdk().auth.getUser()).then(function (res) {
      if (!res || res.error) return null;
      var u = res.data;
      return (u && (u.user || u)) || null;
    }, function () { return null; });
  }

  // profiles 的行级策略只放行自己那一行，所以「查得到 == 我有昵称」。
  function loadProfile() {
    return run(db().from('profiles').select('uid, display_name').limit(1))
      .then(function (rows) {
        var r = rows && rows[0];
        ME.uid = r ? (r.uid || '') : '';
        ME.name = r ? (r.display_name || '') : '';
        return !!r;
      }, function () {
        ME.uid = '';
        ME.name = '';
        return false;
      });
  }

  // 未登录 → 显示登录引导；登录了但还没取昵称 → 引导去取昵称。
  function paintGate(opt) {
    var gate = el(opt.gateId);
    var form = el(opt.formId);
    if (!gate || !form) return;

    // 登录页做完该做的事之后回到当前页
    var loginUrl = BASE + 'login.html?next='
      + encodeURIComponent(location.pathname + location.search);
    var link = el(opt.loginId);
    if (link) link.href = loginUrl;
    var edit = form.querySelector('.me-edit');
    if (edit) edit.href = loginUrl;

    if (ME.name) {
      show(gate, false);
      show(form, true);
      var meBox = el(opt.meId);
      if (meBox) meBox.textContent = ME.name;
      return;
    }

    show(gate, true);
    show(form, false);

    var lines = gate.querySelector('.gate-lines');
    if (lines) {
      if (!gate.dataset.anonHtml) gate.dataset.anonHtml = lines.innerHTML;
      if (ME.loggedIn) {
        lines.innerHTML = '<p class="auth-gate-line">还差一步：给账号<b>取个昵称</b>，'
          + '之后留言和评论旁边显示的就是它。</p>';
        if (link) link.textContent = '去取昵称';
      } else {
        lines.innerHTML = gate.dataset.anonHtml;
        if (link) link.textContent = '登录 / 注册';
      }
    }
  }

  // -------------------------------------------------------------------------
  // 页眉右上角的账号入口
  // —— 静态 HTML 里写的是「登录 / 注册」（JS 挂了也能点进账号页），
  //    这里拿到会话后改文案：登录了显示自己的昵称，身份就摆在明面上。
  // -------------------------------------------------------------------------
  function paintHeadLogin() {
    var a = el('head-login');
    if (!a) return;
    a.href = BASE + 'login.html?next='
      + encodeURIComponent(location.pathname + location.search);

    var txt = a.querySelector('.txt');
    if (!txt) return;
    if (ME.name) {
      txt.textContent = trunc(ME.name, 8);
      a.className = 'head-login is-in';
      a.title = '已登录，点这里进账号页';
    } else if (ME.loggedIn) {
      txt.textContent = '去取昵称';
      a.className = 'head-login is-in';
    }
  }

  // -------------------------------------------------------------------------
  // 渲染：单条留言 / 评论
  // -------------------------------------------------------------------------
  function itemHTML(row) {
    var out = '<div class="comment">'
      + '<div class="comment-head">'
      + '<div class="comment-avatar"></div>'
      + '<span class="comment-name">' + esc(row.name) + '</span>'
      + '<span class="comment-time">' + esc(fmtTime(row.created_at)) + '</span>'
      + '</div>'
      + '<div class="comment-text">' + emo(row.content) + '</div>';
    if (row.reply) {
      out += '<div class="comment-reply"><span class="comment-name">'
        + esc(AUTHOR) + '</span> 回复：' + emo(row.reply) + '</div>';
    }
    return out + '</div>';
  }

  // -------------------------------------------------------------------------
  // 读取：留言板 / 文章评论
  // -------------------------------------------------------------------------
  function loadList(opt) {
    var box = el(opt.boxId);
    if (!box) return Promise.resolve();

    var q = db().from(opt.table).select('id, name, content, reply, created_at');
    if (opt.slug) q = q.eq('post_slug', opt.slug);
    q = q.eq('status', 'published').order('created_at', { ascending: false }).limit(LIST_LIMIT);

    return run(q).then(function (rows) {
      rows = rows || [];
      box.innerHTML = rows.length
        ? rows.map(itemHTML).join('')
        : '<div class="empty-tip">' + esc(opt.emptyTip) + '</div>';
      if (opt.countId) {
        var c = el(opt.countId);
        if (c) c.textContent = opt.countLabel.replace('{n}', rows.length);
      }
    }, function (err) {
      notice(box, friendly(err));
    });
  }

  // -------------------------------------------------------------------------
  // 写入：表单提交
  // -------------------------------------------------------------------------
  function say(form, text, isError) {
    var box = form.querySelector('.form-msg');
    if (!box) return;
    box.textContent = text;
    box.className = 'form-msg ' + (isError ? 'is-error' : 'is-ok');
  }

  // -------------------------------------------------------------------------
  // 表情面板：在输入框下面挂一排小图，点了就把 :key: 插到光标处
  // -------------------------------------------------------------------------
  function mountEmoji(form) {
    if (!form || form.querySelector('.emo-bar')) return;
    var ta = form.querySelector('[name=content]');
    var list = window.PIXEL_EMOJI || [];
    if (!ta || !list.length) return;

    var bar = document.createElement('div');
    bar.className = 'emo-bar';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'emo-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '表情 <span class="emo-caret">▼</span>';

    var panel = document.createElement('div');
    panel.className = 'emo-panel';
    panel.hidden = true;
    panel.innerHTML = list.map(function (it) {
      return '<button type="button" class="emo-item" data-k="' + esc(it.k)
        + '" title="' + esc(it.n) + '">' + emoImg(it.k, it.n) + '</button>';
    }).join('');

    panel.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.emo-item') : null;
      if (!b) return;
      ev.preventDefault();
      var code = ':' + b.getAttribute('data-k') + ':';
      var s = ta.selectionStart;
      var e2 = ta.selectionEnd;
      if (typeof s === 'number' && typeof e2 === 'number') {
        ta.value = ta.value.slice(0, s) + code + ta.value.slice(e2);
        ta.selectionStart = ta.selectionEnd = s + code.length;
      } else {
        ta.value += code;
      }
      ta.focus();
    });

    toggle.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    });

    // 点到面板外面就收起来
    document.addEventListener('click', function (ev) {
      if (panel.hidden || bar.contains(ev.target)) return;
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    });

    bar.appendChild(toggle);
    bar.appendChild(panel);
    ta.parentNode.insertBefore(bar, ta.nextSibling);
  }

  function bindForm(opt) {
    var form = el(opt.formId);
    if (!form) return;

    mountEmoji(form);

    var btn = form.querySelector('button[type=submit]');
    var busy = false;

    function fail(text, field) {
      say(form, text, true);
      if (field && field.focus) field.focus();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;

      // 没有昵称 = 还没走完登录流程。正常情况下表单是藏着的，
      // 这里再挡一道，防止有人手动改 DOM 绕过。
      if (!ME.name) {
        return fail('先在账号页登录并取好昵称，再回来发言。');
      }

      var fText = form.querySelector('[name=content]');
      var body = fText ? (fText.value || '').trim() : '';
      if (!body) return fail('内容还是空的。', fText);
      if (body.length > LIMIT_TEXT) {
        return fail('内容太长了，最多 ' + LIMIT_TEXT + ' 个字。', fText);
      }

      // 只发内容。uid 和昵称交给数据库的默认值 + 行级策略。
      var row = { content: body };
      if (opt.slug) row.post_slug = opt.slug;

      busy = true;
      if (btn) { btn.disabled = true; btn.textContent = '正在提交…'; }
      say(form, '正在提交…', false);

      var insert = db().from(opt.table).insert(row)
        .select('id, name, content, reply, created_at');

      run(insert).then(function () {
        if (fText) fText.value = '';
        say(form, '已发布，谢谢。', false);
        loadRecent();                 // 侧边栏也要跟着刷新
        return loadList(opt.list);
      }).catch(function (err) {
        say(form, friendly(err) + ' 你写的内容还在，可以直接重试。', true);
      }).then(function () {
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = opt.buttonText; }
      });
    });
  }

  // -------------------------------------------------------------------------
  // 文章评论：登录访客都能发（策略是 uid = auth.uid()，站长没有特权）
  // -------------------------------------------------------------------------
  function startComments(slug) {
    if (COMMENT || !slug) return;      // 同一个页面只装一次
    COMMENT = {
      table: 'post_comments',
      boxId: 'comment-list',
      formId: 'comment-form',
      gateId: 'comment-gate',
      loginId: 'comment-login',
      meId: 'comment-me',
      countId: 'comment-count',
      countLabel: '{n} COMMENTS',
      emptyTip: '还没有评论，来说第一句。',
      buttonText: '发表评论',
      slug: slug
    };
    loadList(COMMENT);
    bindForm({
      formId: COMMENT.formId, table: COMMENT.table,
      buttonText: COMMENT.buttonText, slug: slug, list: COMMENT
    });
    // 身份可能已经解析过了（boot 跑在前面），所以这里自己再问一次，
    // 拿到结果直接绘一次门控，别让评论区停在「登录引导 / 表单」的默认态。
    currentUser().then(function (user) {
      if (!user) throw new Error('NO_SESSION');
      ME.loggedIn = true;
      return loadProfile();
    }).then(function () {
      paintGate(COMMENT);
      paintHeadLogin();
    }, function () {
      ME.loggedIn = false;
      paintGate(COMMENT);
      paintHeadLogin();
    });
  }

  // -------------------------------------------------------------------------
  // 侧边栏「最近互动」：文章评论 + 留言板合并，标明来源
  // -------------------------------------------------------------------------
  function loadRecent() {
    var box = el('recent-list');
    if (!box) return Promise.resolve();

    var a = run(db().from('post_comments')
      .select('id, post_slug, name, content, created_at')
      .eq('status', 'published').order('created_at', { ascending: false }).limit(5));

    var b = run(db().from('guestbook')
      .select('id, name, content, created_at')
      .eq('status', 'published').order('created_at', { ascending: false }).limit(5));

    return Promise.all([a, b]).then(function (r) {
      var feed = [];

      (r[0] || []).forEach(function (c) {
        var meta = postMeta(c.post_slug);
        if (!meta) return;
        feed.push({
          time: c.created_at, name: c.name, kind: 'post',
          url: BASE + meta.url, title: meta.title
        });
      });

      (r[1] || []).forEach(function (g) {
        feed.push({
          time: g.created_at, name: g.name, kind: 'guest',
          url: BASE + 'guestbook.html', text: g.content
        });
      });

      if (!feed.length) return;

      feed.sort(function (x, y) {
        return x.time < y.time ? 1 : (x.time > y.time ? -1 : 0);
      });

      box.innerHTML = feed.slice(0, 5).map(function (it) {
        var badge, body;
        if (it.kind === 'post') {
          badge = '<a class="src src-post" href="' + esc(it.url) + '">博文</a>';
          body = '评论了《<a href="' + esc(it.url) + '">' + esc(trunc(it.title, 14)) + '</a>》';
        } else {
          badge = '<a class="src src-guest" href="' + esc(it.url) + '">留言板</a>';
          body = esc(trunc(it.text, 30));
        }
        return '<li><div class="act-head">'
          + '<span class="act-name">' + esc(it.name) + '</span>' + badge
          + '<span class="act-time">' + esc(fmtTime(it.time).slice(5, 10)) + '</span>'
          + '</div><div class="act-body">' + body + '</div></li>';
      }).join('');
    }, function () {
      /* 拉不到就保留静态那份 */
    });
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  var GB = {
    table: 'guestbook',
    boxId: 'guestbook-list',
    formId: 'guestbook-form',
    gateId: 'guestbook-gate',
    loginId: 'guestbook-login',
    meId: 'guestbook-me',
    countId: 'guestbook-count',
    countLabel: '{n} MESSAGES',
    emptyTip: '还没有留言，来说第一句。',
    buttonText: '发表留言'
  };

  var COMMENT = null;

  function boot() {
    if (el(GB.boxId)) {
      loadList(GB);
      bindForm({ formId: GB.formId, table: GB.table, buttonText: GB.buttonText, list: GB });
    }

    // 文章详情页的 slug 是 feed.js 读出来才填上的，所以这里只在已经填好时启动；
    // 没填好的，等 feed.js 叫 startComments()（挂在 window.PixelCloud 上）。
    var postBox = el('comment-list');
    if (postBox && postBox.getAttribute('data-slug')) {
      startComments(postBox.getAttribute('data-slug'));
    }

    whenPostsReady(loadRecent);

    // 身份解析放在最后：拿到之前两个门控区都保持默认（引导登录）状态，
    // 拿到之后再决定是藏起来门、露出表单，还是提示去取昵称。
    currentUser().then(function (user) {
      if (!user) throw new Error('NO_SESSION');
      ME.loggedIn = true;
      return loadProfile();
    }).then(function () {
      if (GB) paintGate(GB);
      if (COMMENT) paintGate(COMMENT);
      paintHeadLogin();
    }, function () {
      ME.loggedIn = false;
      if (GB) paintGate(GB);
      if (COMMENT) paintGate(COMMENT);
      paintHeadLogin();
    });
  }

  // 给 feed.js 用的接口：文章是异步读出来的，slug 到位得由它来叫一声。
  window.PixelCloud = window.PixelCloud || {};
  window.PixelCloud.initComments = startComments;
  window.PixelCloud.ME = ME;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  window.dispatchEvent(new CustomEvent('pixel:cloud-ready'));
})();
