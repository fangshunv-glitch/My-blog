/*!
 * 像素日常 · 云端互动模块
 * ============================
 * 负责「留言板」「文章评论」「侧边栏最近互动」的读取与提交。
 *
 * 设计原则：
 *   1. 页面里的静态内容只作降级打底——JS 一旦拿到云端数据就整块替换；
 *      拿不到（断网 / 脚本没加载）则原样保留，页面照样能看。
 *   2. 所有写操作走数据库的行级安全策略，前端不做权限判断。
 *   3. 任何一条失败路径都要给出人能看懂的中文提示，不许静默失败。
 *
 * 依赖：本文件之前必须已经加载 WorkBuddy Cloud SDK（全局 WorkBuddyCloud）
 *       以及页面内联的 window.SITE_DATA（本站数据，由 build.py 注入）
 */
(function () {
  'use strict';

  // publicConfig —— 见 cloud-config.js（admin.js 共用同一份，避免写重复）
  var CONFIG = window.PIXEL_CLOUD_CONFIG || {};

  var LIMIT_NAME = 24;      // 与数据库 WITH CHECK 保持一致
  var LIMIT_TEXT = 800;
  var LIST_LIMIT = 100;     // 单页最多显示多少条

  var D = window.SITE_DATA || {};
  var AUTHOR = D.author || '站长';
  var BASE = D.base || '';
  var POSTS = D.posts || {};

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

  // -------------------------------------------------------------------------
  // 云客户端
  // -------------------------------------------------------------------------
  var _db = null;

  function db() {
    if (_db) return _db;
    var S = window.WorkBuddyCloud;
    if (!S || typeof S.createWorkBuddyCloud !== 'function') {
      throw new Error('SDK_MISSING');
    }
    _db = S.createWorkBuddyCloud(CONFIG).database;
    return _db;
  }

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
    switch (err.code) {
      case '42501': return '服务器拒绝了这次操作，可能是内容不合规。';
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
  // 渲染：单条留言 / 评论
  // -------------------------------------------------------------------------
  function itemHTML(row) {
    var out = '<div class="comment">'
      + '<div class="comment-head">'
      + '<div class="comment-avatar"></div>'
      + '<span class="comment-name">' + esc(row.name) + '</span>'
      + '<span class="comment-time">' + esc(fmtTime(row.created_at)) + '</span>'
      + '</div>'
      + '<div class="comment-text">' + esc(row.content) + '</div>';
    if (row.reply) {
      out += '<div class="comment-reply"><span class="comment-name">'
        + esc(AUTHOR) + '</span> 回复：' + esc(row.reply) + '</div>';
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
  function say(form, msg, isError) {
    var box = form.querySelector('.form-msg');
    if (!box) return;
    box.textContent = msg;
    box.className = 'form-msg ' + (isError ? 'is-error' : 'is-ok');
  }

  function bindForm(opt) {
    var form = el(opt.formId);
    if (!form) return;

    var btn = form.querySelector('button[type=submit]');
    var busy = false;

    function fail(msg, field) {
      say(form, msg, true);
      if (field && field.focus) field.focus();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;

      var fName = form.querySelector('[name=name]');
      var fMail = form.querySelector('[name=email]');
      var fText = form.querySelector('[name=content]');

      var name = (fName.value || '').trim();
      var mail = (fMail.value || '').trim();
      var body = (fText.value || '').trim();

      if (!name) return fail('昵称还没填。', fName);
      if (name.length > LIMIT_NAME) return fail('昵称太长了，最多 ' + LIMIT_NAME + ' 个字。', fName);
      if (!body) return fail('内容还是空的。', fText);
      if (body.length > LIMIT_TEXT) return fail('内容太长了，最多 ' + LIMIT_TEXT + ' 个字。', fText);
      if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
        return fail('邮箱格式看着不太对，检查一下。', fMail);
      }

      var row = { name: name, content: body };
      if (opt.slug) row.post_slug = opt.slug;

      busy = true;
      if (btn) { btn.disabled = true; btn.textContent = '正在提交…'; }
      say(form, '正在提交…', false);

      var insert = db().from(opt.table).insert(row).select('id, name, content, reply, created_at');

      run(insert).then(function (rows) {
        // 邮箱单独写到 contact_emails。
        // 为什么不放在留言表里：留言表对访客是公开读的，
        // 而这个环境里列级授权挡不住 select('*')，邮箱放一起等于公开。
        // contact_emails 对未登录访客连读权限都没有，只有站长能看。
        var newId = rows && rows[0] ? rows[0].id : null;
        if (!mail || !newId) return null;
        return run(db().from('contact_emails').insert({
          source: opt.table, ref_id: newId, email: mail
        })).then(null, function () {
          return null;   // 邮箱没存上不该连累留言本身
        });
      }).then(function () {
        if (fName.value) { try { localStorage.setItem('pd_name', name); } catch (x) {} }
        if (fMail.value) { try { localStorage.setItem('pd_mail', mail); } catch (x) {} }
        form.reset();
        say(form, '已发布，谢谢你的留言。', false);
        loadRecent();                 // 侧边栏也要跟着刷新
        return loadList(opt.list);
      }).catch(function (err) {
        say(form, friendly(err) + ' 你写的内容还在，可以直接重试。', true);
      }).then(function () {
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = opt.buttonText; }
      });
    });

    // 回填上次用过的昵称 / 邮箱，省得每次重打
    try {
      var n = localStorage.getItem('pd_name');
      var m = localStorage.getItem('pd_mail');
      var fN = form.querySelector('[name=name]');
      var fM = form.querySelector('[name=email]');
      if (n && fN) fN.value = n;
      if (m && fM) fM.value = m;
    } catch (x) {}
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
        var meta = POSTS[c.post_slug];
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
    countId: 'guestbook-count',
    countLabel: '{n} MESSAGES',
    emptyTip: '还没有留言，来说第一句。',
    buttonText: '发表留言'
  };

  function boot() {
    loadRecent();
    loadList(GB);
    bindForm({ formId: GB.formId, table: GB.table, buttonText: GB.buttonText, list: GB });

    var postBox = el('comment-list');
    if (postBox) {
      var slug = postBox.getAttribute('data-slug') || '';
      var opt = {
        table: 'post_comments',
        boxId: 'comment-list',
        formId: 'comment-form',
        countId: 'comment-count',
        countLabel: '{n} COMMENTS',
        emptyTip: '还没有评论，来说第一句。',
        buttonText: '发表评论',
        slug: slug
      };
      loadList(opt);
      bindForm({
        formId: opt.formId, table: opt.table,
        buttonText: opt.buttonText, slug: slug, list: opt
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
