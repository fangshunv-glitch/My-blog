/*!
 * 像素日常 · 内容渲染模块（feed.js）
 * ==================================
 * 文章和相册都存在云端数据库里，站长在后台随时增删改。这一层负责把数据变成页面：
 *
 *   1. 博客列表（blog.html）、分类页（category/*.html）、归档页（archive.html）
 *   2. 文章详情页（post.html?slug=xxx）
 *   3. 相册页（album.html），含点开看大图
 *   4. 侧边栏分类/归档计数、页脚「文章 N 篇 · 照片 N 张」
 *
 * 设计原则：
 *   1. **能不能看由数据库说了算**，不是这里过滤的。行级策略只放行
 *      visibility in (public, unlisted) 给访客，private / draft 连查都查不到。
 *      所以下面「只把 public 放进列表」只是显示规则，不是安全边界。
 *   2. 静态生成的空壳是兜底：JS 没跑起来、或者云端连不上，
 *      页面上会留一句说明，而不是变成一片空白。
 *   3. 留言和评论不在这里 —— 那是 cloud.js 的活。本文件只负责「内容」。
 *
 * 依赖：先加载 SDK（全局 WorkBuddyCloud）、cloud-config.js、页面内联的 SITE_DATA。
 */
(function () {
  'use strict';

  var CONFIG = window.PIXEL_CLOUD_CONFIG || {};
  var D = window.SITE_DATA || {};
  var BASE = D.base || '';
  var AUTHOR = D.author || '站长';

  // 分类名单存在云端 categories 表里，站长在后台自己增删改 ——
  // 所以 CATS（名字 → slug）是页面打开后从云端读回来的，不再由 build.py 注入。
  var CATS = {};
  var CAT_ROWS = [];

  // 博客相册：发帖时顺带传的照片统一收进这个名字的相册，
  // 不跟站长在相册页另外建的相册（比如「披萨猫专属」）混在一起。
  var BLOG_ALBUM = '博客';
  var LOOSE_ALBUM = '散片';

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
  function el(id) { return document.getElementById(id); }

  function run(query) {
    return Promise.resolve(query).then(function (res) {
      if (res && res.error) throw res.error;
      return res && res.data ? res.data : [];
    });
  }

  function friendly(err) {
    var m = (err && (err.message || err.error_description)) || '';
    if (/SDK_MISSING/.test(m)) return '云端脚本没加载上，稍后刷新试试。';
    if (/Failed to fetch|NetworkError|fetch/i.test(m)) return '网络好像不通，检查一下连接。';
    return m || '出了点问题，稍后再试。';
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  // 表情名单由 build.py 从 content.py 注入，这里只建索引。
  var EMO = {};
  (function () {
    var l = window.PIXEL_EMOJI || [];
    for (var i = 0; i < l.length; i++) EMO[l[i].k] = l[i].n;
  })();

  function emoTag(key) {
    return '<img class="emo" src="' + BASE + 'assets/emoji/' + key + '.png'
      + (window.EMOJI_V ? '?v=' + window.EMOJI_V : '') + '"'
      + ' alt="' + escAttr(EMO[key]) + '" title="' + escAttr(EMO[key]) + '" loading="lazy">';
  }
  // 按码点切。手机打的 emoji 是代理对，按 UTF-16 下标切会剩下半个 →「�」。
  function trunc(s, n) {
    s = String(s == null ? '' : s).trim();
    var chars = Array.from(s);
    return chars.length <= n ? s : chars.slice(0, n).join('') + '…';
  }
  function catUrl(slug) {
    return BASE + 'category.html?c=' + encodeURIComponent(slug);
  }
  function catLink(name) {
    if (!name) return '';
    var slug = CATS[name];
    // 分类被改名或删掉之后，老文章身上的旧分类名就没 slug 了 —— 那就别给假链接
    if (!slug) return esc(name);
    return '<a href="' + escAttr(catUrl(slug)) + '">' + esc(name) + '</a>';
  }
  function postUrl(slug) {
    return BASE + 'post.html?slug=' + encodeURIComponent(slug);
  }
  function dayOf(v) {
    // 数据库给的是 YYYY-MM-DD（date 类型），保险起见截前 10 位
    return String(v == null ? '' : v).slice(0, 10);
  }
  function hhmm(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 站长在后台登录成功过，admin.js 会留一个记号。前台只拿它决定
  // 「要不要显示编辑入口」—— 真正的门在 admin.html 和数据库策略上，
  // 改这个记号最多让人看到一个点进去会被拦住的按钮。
  function isAdminHint() {
    try { return localStorage.getItem('pixel_is_admin') === '1'; }
    catch (e) { return false; }
  }

  // -------------------------------------------------------------------------
  // 极简 Markdown → HTML（与 build.py 的 md() 对齐，所见即所得）
  // -------------------------------------------------------------------------
  function isWordChar(ch) {
    return !!ch && ch.charCodeAt(0) < 128 && /[0-9A-Za-z]/.test(ch);
  }

  function mdInline(s) {
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[(.+?)\]\((.+?)\)/g, function (m, t, u) {
      // 只允许安全的链接形状，别让正文里塞进 javascript:
      var href = /^(https?:\/\/|\/|#|mailto:)/.test(u) ? u : '#';
      return '<a href="' + escAttr(href) + '">' + t + '</a>';
    });
    // :smile: → 表情小图。放在最后，因为前面已经把 HTML 转义过了。
    s = s.replace(/:([a-z][a-z0-9_]{1,15}):/g, function (m, key) {
      return EMO[key] ? emoTag(key) : m;
    });
    return s;
  }

  // 中文按行折行的段落，拼接时不插空格；英文单词之间补回来
  function joinLines(buf) {
    var out = '';
    for (var i = 0; i < buf.length; i++) {
      var seg = buf[i];
      if (i && out && isWordChar(out.charAt(out.length - 1)) && isWordChar(seg.charAt(0))) {
        out += ' ';
      }
      out += seg;
    }
    return out;
  }

  function md(text) {
    var lines = String(text == null ? '' : text).replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
    var out = [], i = 0;
    while (i < lines.length) {
      var ln = lines[i].replace(/\s+$/, '');
      if (!ln.trim()) { i++; continue; }

      if (ln.indexOf('## ') === 0) {
        out.push('<h3>' + mdInline(ln.slice(3).trim()) + '</h3>');
        i++; continue;
      }
      if (ln.indexOf('> ') === 0) {
        var qb = [];
        while (i < lines.length && lines[i].indexOf('> ') === 0) {
          qb.push(lines[i].slice(2).trim()); i++;
        }
        out.push('<blockquote>' + mdInline(joinLines(qb)) + '</blockquote>');
        continue;
      }
      if (ln.indexOf('- ') === 0) {
        var lb = [];
        while (i < lines.length && lines[i].indexOf('- ') === 0) {
          lb.push('<li>' + mdInline(lines[i].slice(2).trim()) + '</li>'); i++;
        }
        out.push('<ul>' + lb.join('') + '</ul>');
        continue;
      }
      var pb = [];
      while (i < lines.length && lines[i].trim()
             && lines[i].indexOf('## ') !== 0
             && lines[i].indexOf('> ') !== 0
             && lines[i].indexOf('- ') !== 0) {
        pb.push(lines[i].trim()); i++;
      }
      out.push('<p>' + mdInline(joinLines(pb)) + '</p>');
    }
    return out.join('\n');
  }

  // -------------------------------------------------------------------------
  // 可见范围：给站长看的提示（访客根本读不到非公开内容）
  // -------------------------------------------------------------------------
  var VIS = {
    public: '',
    members: '<div class="vis-note"><span class="badge">好友可见</span>'
      + '<span>这一篇<b>只给登录过本站的人看</b>，没登录的访客看不到。</span></div>',
    unlisted: '<div class="vis-note"><span class="badge">有链接可见</span>'
      + '<span>这一篇<b>没有公开</b>：不在首页、分类、归档和相册里出现，'
      + '只有拿着链接的人能看到。想让它公开，把可见范围改成「所有人可见」。</span></div>',
    // 部分人可见 / 部分人不可见：不给提示。能看到的人本来就在名单里，
    // 对他说「这篇只给几个人看」是废话；站长看后台的徽标就够了。
    custom: '',
    except: '',
    private: '<div class="vis-note"><span class="badge">仅自己可见</span>'
      + '<span>这一篇<b>只有你自己能看到</b>。访客连数据都查不到，'
      + '换成别的账号登录也读不出来。</span></div>',
    draft: '<div class="vis-note"><span class="badge">草稿</span>'
      + '<span>这是<b>草稿</b>，访客看不到。在这里预览一下没问题，'
      + '确认好了回后台把可见范围改成「公开」。</span></div>'
  };

  // -------------------------------------------------------------------------
  // 行内表情 / 点赞按钮
  //
  // 说说（kind=note）的正文要直接铺在列表上，所以这里有一份「按行渲染」的
  // 轻量版：esc 之后转义换行、再把 :key: 换成图。**顺序不能反** ——
  // 先替换再 esc 就是把人写的东西当 HTML 用。
  // -------------------------------------------------------------------------
  var EMO_RE = /:([a-z][a-z0-9_]{1,15}):/g;

  function emoLines(text, max) {
    var chars = Array.from(String(text == null ? '' : text).trim());
    var cut = false;
    if (max && chars.length > max) { chars = chars.slice(0, max); cut = true; }
    var out = esc(chars.join('')).replace(EMO_RE, function (m, k) {
      return EMO[k] ? emoTag(k) : m;
    }).replace(/\n/g, '<br>');
    return out + (cut ? '<span class="note-more">…</span>' : '');
  }

  // 按钮只是一副壳子，数字和「我赞过没有」由 likes.js 统一填。
  // 这样一处逻辑管全站的心，不会出现列表算 3、详情算 2 的情况。
  function likeHTML(kind, key) {
    return '<button class="like-btn" type="button" data-like="'
      + escAttr(kind + ':' + key) + '" aria-pressed="false" title="赞一下">'
      + '<span class="lk-heart">♥</span><span class="lk-n">赞</span></button>';
  }

  // -------------------------------------------------------------------------
  // 文章卡片
  //
  // 发文章时带的配图挂在 photos 表里（post_slug = 文章 slug），以前只有点进
  // 文章详情才看得到 —— 列表上只剩一行摘要，图文帖看着像纯文字帖。
  // 现在列表把「每篇的第一张」当封面用：一篇只取一张缩略图（约 27KB），
  // 多了就把篇数标在角上。
  // -------------------------------------------------------------------------
  var COVER = {};       // slug → { thumb, n }

  function loadCovers() {
    var slugs = PUBLIC.map(function (p) { return p.slug; }).slice(0, 60);
    if (!slugs.length) return Promise.resolve();
    // 只取缩略图，不取原图；按时间正序，第一条就当作封面
    return run(db().from('photos')
      .select('post_slug,thumb_data,taken_on')
      .in('post_slug', slugs)
      .in('visibility', LISTED_VIS)
      .order('taken_on', { ascending: true })
      .order('id', { ascending: true }))
      .then(function (rows) {
        COVER = {};
        (rows || []).forEach(function (ph) {
          var k = ph.post_slug;
          if (!k || !ph.thumb_data) return;
          if (!COVER[k]) COVER[k] = { thumb: ph.thumb_data, n: 0 };
          COVER[k].n++;
        });
      }, function () { COVER = {}; });
  }

  function coverHTML(slug, cls) {
    var c = COVER[slug];
    if (!c || !c.thumb) return '';
    return '<a class="' + (cls || 'post-cover') + '" href="' + escAttr(postUrl(slug))
      + '"><img src="' + escAttr(c.thumb) + '" alt="" loading="lazy">'
      + (c.n > 1 ? '<span class="pc-n">' + c.n + ' 张</span>' : '')
      + '</a>';
  }

  // 说说的正文：列表查询故意不带 body（正文可能几十 KB，绝大多数卡片用不上），
  // 所以只给「说说」再补一次，一次多带几篇也就几百字。
  var NOTE_BODY = {};

  function loadNotes() {
    var slugs = PUBLIC.filter(function (p) { return p.kind === 'note'; })
      .map(function (p) { return p.slug; }).slice(0, 20);
    if (!slugs.length) return Promise.resolve();
    return run(db().from('posts').select('slug,body').in('slug', slugs))
      .then(function (rows) {
        NOTE_BODY = {};
        (rows || []).forEach(function (r) { NOTE_BODY[r.slug] = r.body || ''; });
      }, function () { NOTE_BODY = {}; });
  }

  // 说说：标题是空的，正文就是全部内容。QQ 空间那种「随手一句 + 一张图」，
  // 不该逼人先想一个标题。挂在 posts 表里，评论、可见范围、点赞全都通用。
  function noteHTML(p, opts) {
    opts = opts || {};
    var url = postUrl(p.slug);
    var meta = ['<span class="m-date">' + esc(dayOf(p.published_on)) + '</span>'];
    if (opts.showCat !== false && p.category) {
      meta.push('<span class="m-cat">' + catLink(p.category) + '</span>');
    }
    meta.push('<span class="m-kind">说说</span>');
    return '<article class="post note">'
      + '<div class="post-meta">' + meta.join('') + '</div>'
      + '<div class="note-body">' + emoLines(NOTE_BODY[p.slug] || '', 260) + '</div>'
      + coverHTML(p.slug)
      + '<div class="post-foot">'
      + '<a class="more" href="' + escAttr(url) + '">评论 <span class="arrow">▸</span></a>'
      + likeHTML('post', p.slug)
      + '</div></article>';
  }

  function cardHTML(p, opts) {
    opts = opts || {};
    if (p.kind === 'note') return noteHTML(p, opts);
    var url = postUrl(p.slug);
    var meta = ['<span class="m-date">' + esc(dayOf(p.published_on)) + '</span>'];
    if (opts.showCat !== false && p.category) {
      meta.push('<span class="m-cat">分类：' + catLink(p.category) + '</span>');
    }
    var tags = String(p.tags || '').split(',').filter(function (t) { return t.trim(); });
    var chips = tags.slice(0, 3).map(function (t) {
      return '<span class="chip">' + esc(t.trim()) + '</span>';
    }).join('');

    return '<article class="post">'
      + '<h3 class="post-title"><a href="' + escAttr(url) + '">' + esc(p.title) + '</a></h3>'
      + '<div class="post-meta">' + meta.join('') + '</div>'
      + (p.excerpt ? '<p class="post-excerpt">' + esc(p.excerpt) + '</p>' : '')
      + coverHTML(p.slug)
      + '<div class="post-foot">'
      + '<a class="more" href="' + escAttr(url) + '">阅读全文 <span class="arrow">▸</span></a>'
      + likeHTML('post', p.slug)
      + '<span class="post-tags">' + chips + '</span>'
      + '</div></article>';
  }

  function featuredHTML(p) {
    var url = postUrl(p.slug);
    return '<article class="post featured"><div class="feat-flex"><div class="feat-body">'
      + '<h3 class="post-title"><a href="' + escAttr(url) + '">' + esc(p.title)
      + '</a><span class="pill">置顶</span></h3>'
      + '<div class="post-meta"><span class="m-date">' + esc(dayOf(p.published_on)) + '</span>'
      + (p.category ? '<span class="m-cat">分类：' + catLink(p.category) + '</span>' : '')
      + '</div>'
      + (p.excerpt ? '<p class="post-excerpt">' + esc(p.excerpt) + '</p>' : '')
      + coverHTML(p.slug)
      + '<div class="post-foot"><a class="more" href="' + escAttr(url) + '">阅读全文 ▸</a>'
      + likeHTML('post', p.slug) + '</div>'
      + '</div>' + (COVER[p.slug] && COVER[p.slug].thumb
        ? ''                                  // 有首图就不再摆那块像素画，免得一个卡片两张图
        : '<div class="thumb">PIXEL<br>TOP</div>')
      + '</div></article>';
  }

  function emptyTip(text) {
    return '<div class="empty-tip">' + esc(text) + '</div>';
  }

  // -------------------------------------------------------------------------
  // 各视图
  // -------------------------------------------------------------------------
  var ALL = [];        // 能读到的全部（能读到多少由数据库策略决定）
  var PUBLIC = [];     // 该出现在列表里的那些

  // 哪些档位属于「正常展示」：所有人 / 好友 / 部分人可见 / 部分人不可见。
  // 「有链接可见」不进列表；私密和草稿只有站长读得到，当然也不进。
  // 这些档位读不读得到由 RLS 在服务端拦，前端的过滤只管「要不要出现在列表里」。
  var LISTED_VIS = ['public', 'members', 'custom', 'except'];

  function viewList() {
    var box = el('feed-posts');
    if (!box) return;
    var mode = box.getAttribute('data-view') || 'all';
    var cat = box.getAttribute('data-cat') || '';
    var count = el('feed-count');

    // 分类不存在：prepareCategoryPage 已经把话说清楚了，这里别再盖一层空提示
    if (mode === 'missing') {
      if (count) count.textContent = '';
      return;
    }

    var list = cat ? PUBLIC.filter(function (p) { return p.category === cat; }) : PUBLIC;
    if (count) count.textContent = '共 ' + list.length + ' 篇';

    if (!list.length) {
      box.innerHTML = emptyTip(cat ? '这个分类下还没有文章。' : '还没有文章。');
      return;
    }
    var feat = list.filter(function (p) { return p.featured; });
    var rest = list.filter(function (p) { return !p.featured; });
    box.innerHTML = feat.map(featuredHTML).join('') + rest.map(function (p) { return cardHTML(p); }).join('');
  }

  function viewArchive() {
    var box = el('feed-archive');
    if (!box) return;
    var count = el('feed-count');
    if (count) count.textContent = PUBLIC.length;

    if (!PUBLIC.length) {
      box.innerHTML = emptyTip('还没有文章可以归档。');
      return;
    }
    var groups = {};
    PUBLIC.forEach(function (p) {
      var ym = dayOf(p.published_on).slice(0, 7);
      (groups[ym] = groups[ym] || []).push(p);
    });
    var months = Object.keys(groups).sort().reverse();
    box.innerHTML = months.map(function (ym) {
      var rows = groups[ym].map(function (p) {
        return '<li><span class="a-date">' + esc(dayOf(p.published_on).slice(5)) + '</span>'
          + '<a class="a-title" href="' + escAttr(postUrl(p.slug)) + '">' + esc(p.title) + '</a>'
          + '<span class="a-cat">' + catLink(p.category) + '</span></li>';
      }).join('');
      return '<div class="cell" id="' + escAttr(ym) + '">'
        + '<div class="cell-title bar-3">'
        + '<img class="pixel" src="' + BASE + 'assets/t_arch.png" alt="文章归档">'
        + '<span class="en">' + esc(ym.replace('-', ' / ')) + ' · ' + groups[ym].length + ' POSTS</span>'
        + '</div><div class="cell-body"><ul class="archive-list">' + rows + '</ul></div></div>';
    }).join('');
  }

  function viewCounts() {
    var byMonth = {};
    PUBLIC.forEach(function (p) {
      var ym = dayOf(p.published_on).slice(0, 7);
      byMonth[ym] = (byMonth[ym] || 0) + 1;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-arch-count]'), function (n) {
      n.textContent = '(' + (byMonth[n.getAttribute('data-arch-count')] || 0) + ')';
    });
    var fp = el('foot-posts');
    if (fp) fp.textContent = PUBLIC.length;
  }

  // -------------------------------------------------------------------------
  // 分类：名单在云端，侧边栏由这里填
  // -------------------------------------------------------------------------
  function loadCats() {
    // 读不到就当没有分类：文章照样能看，只是侧边栏那块空着，不阻塞别的。
    return run(db().from('categories').select('id,slug,name,descr,sort')
      .order('sort', { ascending: true })
      .order('id', { ascending: true })
    ).then(function (rows) {
      CAT_ROWS = rows || [];
      CATS = {};
      CAT_ROWS.forEach(function (c) { CATS[c.name] = c.slug; });
    }, function () {
      CAT_ROWS = [];
      CATS = {};
    });
  }

  function paintCatList() {
    var box = el('cat-list');
    if (!box) return;
    if (!CAT_ROWS.length) {
      box.innerHTML = '<li class="side-empty">还没有分类。</li>';
      return;
    }
    box.innerHTML = CAT_ROWS.map(function (c) {
      var n = 0;
      for (var i = 0; i < PUBLIC.length; i++) {
        if (PUBLIC[i].category === c.name) n++;
      }
      return '<li><a href="' + escAttr(catUrl(c.slug)) + '">' + esc(c.name)
        + '</a><span class="n">(' + n + ')</span></li>';
    }).join('');
  }

  // 侧边栏的归档也交给云端数据来填：文章都在后台写，
  // 静态那一份（来自 content.py）是空的，不填就永远显示「还没有归档」。
  function paintArchList() {
    var box = el('arch-list');
    if (!box) return;
    var byMonth = {};
    PUBLIC.forEach(function (p) {
      var ym = dayOf(p.published_on).slice(0, 7);
      if (ym) byMonth[ym] = (byMonth[ym] || 0) + 1;
    });
    var keys = Object.keys(byMonth).sort().reverse();
    if (!keys.length) {
      box.innerHTML = '<li class="side-empty">文章按月分组之后，这里会长出归档。</li>';
      return;
    }
    box.innerHTML = keys.map(function (ym) {
      return '<li><a href="' + escAttr(BASE + 'archive.html#' + ym) + '">'
        + ym.slice(0, 4) + ' 年 ' + Number(ym.slice(5, 7)) + ' 月</a>'
        + '<span class="n">(' + byMonth[ym] + ')</span></li>';
    }).join('');
  }

  // 分类页（category.html?c=<slug>）：标题、说明、面包屑都按 ?c= 现填。
  // 分类不存在（被改名或删了）就明确说一句，别让人对着空白猜。
  function prepareCategoryPage() {
    var box = el('feed-posts');
    if (!box || box.getAttribute('data-view') !== 'category') return;

    var m = /[?&]c=([^&]*)/.exec(location.search);
    var slug = m ? decodeURIComponent(m[1]) : '';
    var found = null;
    for (var i = 0; i < CAT_ROWS.length; i++) {
      if (CAT_ROWS[i].slug === slug) { found = CAT_ROWS[i]; break; }
    }

    var t = el('cat-title'), d = el('cat-desc'), crumb = el('cat-crumb-now');
    if (!found) {
      box.setAttribute('data-view', 'missing');
      box.innerHTML = '';
      if (t) t.textContent = slug ? '找不到这个分类' : '没说要看哪个分类';
      if (d) d.innerHTML = '它可能被改过名字，或者已经删掉了 —— 去'
        + ' <a href="' + escAttr(BASE + 'blog.html') + '">博客列表</a> 看全部文章。';
      return;
    }

    if (t) t.textContent = '分类：' + found.name;
    if (d) d.textContent = (found.descr || '这个分类下的全部文章') + ' · 按发布时间倒序';
    if (crumb) crumb.textContent = found.name;
    document.title = found.name + ' · ' + (D.siteName || '博客');
    box.setAttribute('data-cat', found.name);
  }

  // -------------------------------------------------------------------------
  // 文章详情
  // -------------------------------------------------------------------------
  function stateBox(tip, linkText, linkHref) {
    var st = el('post-state'), t = el('post-state-tip');
    if (t) {
      t.innerHTML = esc(tip) + (linkText
        ? ' <a href="' + escAttr(linkHref) + '">' + esc(linkText) + '</a>' : '');
    }
    if (st) st.hidden = false;
  }

  function viewPost() {
    var article = el('post-article');
    if (!article) return;

    var m = /[?&]slug=([^&]*)/.exec(location.search);
    var slug = m ? decodeURIComponent(m[1]) : '';
    if (!slug) {
      stateBox('这个地址少了文章编号（?slug=…）。', '回博客列表', BASE + 'blog.html');
      return;
    }

    run(db().from('posts').select('*').eq('slug', slug).limit(1))
      .then(function (rows) {
        var p = rows && rows[0];
        if (!p) {
          // 三种可能：真没有，或者这是一篇 private / draft（策略拦住了，查不到）
          stateBox('没找到这篇文章 —— 它可能被删掉了，或者没有公开。',
                   '回博客列表', BASE + 'blog.html');
          return;
        }
        paintPost(p);
      }, function (err) {
        stateBox('文章没能读出来：' + friendly(err), '回博客列表', BASE + 'blog.html');
      });
  }

  function paintPost(p) {
    var article = el('post-article');
    var st = el('post-state');
    if (!article) return;

    document.title = p.title + ' · ' + (D.siteName || '博客');
    if (st) st.hidden = true;
    article.hidden = false;

    if (p.category && el('post-crumb')) {
      el('post-crumb').innerHTML = '<a href="' + BASE + 'index.html">封面</a>'
        + '<span class="sep">›</span><a href="' + BASE + 'blog.html">叁 博客</a>'
        + '<span class="sep">›</span>' + catLink(p.category)
        + '<span class="sep">›</span><span>' + esc(trunc(p.title, 24)) + '</span>';
    }

    var visBox = el('post-vis');
    if (visBox) visBox.innerHTML = VIS[p.visibility] || '';

    el('post-title').textContent = p.title;

    var meta = ['<span class="m-date">发布于 ' + esc(dayOf(p.published_on)) + '</span>'];
    if (p.category) meta.push('<span class="m-cat">分类：' + catLink(p.category) + '</span>');
    meta.push('<span>作者：' + esc(p.owner_name || AUTHOR) + '</span>');
    if (p.updated_at && hhmm(p.updated_at).slice(0, 4) === dayOf(p.published_on).slice(0, 4)
        && hhmm(p.updated_at) !== dayOf(p.published_on)) {
      meta.push('<span class="m-upd">最后更新于 ' + esc(hhmm(p.updated_at)) + '</span>');
    }
    el('post-meta').innerHTML = meta.join('');

    el('post-body').innerHTML = md(p.body);

    var tags = String(p.tags || '').split(',').filter(function (t) { return t.trim(); });
    el('post-tags').innerHTML = (tags.length
      ? '<span class="label">标签：</span>' + tags.map(function (t) {
          return '<span class="chip">' + esc(t.trim()) + '</span>';
        }).join('')
      : '')
      + '<button class="btn-mini post-copy" type="button">复制本文链接</button>'
      // 站长在后台登录过：文章页直接给一个「编辑本篇」的入口，
      // 点了进后台并自动把这一篇调出来，省得再从列表里翻。
      + (isAdminHint()
        ? '<a class="btn-mini post-edit" href="'
          + escAttr(BASE + 'admin.html?edit=' + encodeURIComponent(p.slug)) + '">编辑本篇</a>'
        : '');

    var copyBtn = el('post-tags').querySelector('.post-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        copyPostLink(location.origin + location.pathname
          + '?slug=' + encodeURIComponent(p.slug), copyBtn);
      });
    }

    // 详情页也放一颗心。容器只建一次，重新渲染时只换里面的内容，
    // 否则来回进两篇文章会叠出两颗心。
    var likeBox = el('post-like');
    if (!likeBox) {
      likeBox = document.createElement('div');
      likeBox.id = 'post-like';
      likeBox.className = 'post-like';
      var anchor = el('post-tags');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(likeBox, anchor.nextSibling);
    }
    likeBox.innerHTML = likeHTML('post', p.slug);
    if (window.PixelLikes) window.PixelLikes.refresh();

    paintPostNav(p);
    paintPostPhotos(p);
    unlockComments(p.slug);
  }

  // 分享页那套思路搬到文章页：直接复制这一篇的地址，发群里比发首页更容易被点开。
  function copyPostLink(url, btn) {
    var label = btn.textContent;
    function done(ok) {
      btn.textContent = ok ? '已复制' : '复制没成功';
      window.setTimeout(function () { btn.textContent = label; }, 1800);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  function paintPostNav(p) {
    var box = el('post-nav');
    if (!box) return;
    var order = PUBLIC.slice().sort(function (a, b) {
      return dayOf(a.published_on) < dayOf(b.published_on) ? -1 : 1;
    });
    var idx = -1;
    for (var i = 0; i < order.length; i++) { if (order[i].slug === p.slug) { idx = i; break; } }
    var prev = idx > 0 ? order[idx - 1] : null;
    var next = (idx >= 0 && idx < order.length - 1) ? order[idx + 1] : null;

    box.innerHTML = (prev
        ? '<a href="' + escAttr(postUrl(prev.slug)) + '"><span class="dir">上一篇</span>◀ '
          + esc(trunc(prev.title, 22)) + '</a>'
        : '<span class="pn-empty"><span class="dir">上一篇</span>没有了，这是最早的一篇</span>')
      + (next
        ? '<a class="pn-next" href="' + escAttr(postUrl(next.slug)) + '"><span class="dir">下一篇</span>'
          + esc(trunc(next.title, 22)) + ' ▶</a>'
        : '<span class="pn-empty pn-next"><span class="dir">下一篇</span>还没有更新的</span>');
    box.hidden = false;
  }

  function paintPostPhotos(p) {
    var box = el('post-photos');
    if (!box) return;
    run(db().from('photos')
      .select('id,caption,taken_on,thumb_data')
      .eq('post_slug', p.slug).in('visibility', LISTED_VIS)
      .order('taken_on', { ascending: true }).limit(60))
      .then(function (rows) {
        if (!rows.length) { box.innerHTML = ''; return; }
        box.innerHTML = '<div class="article-photos"><div class="sub-head">本篇照片</div>'
          + '<div class="album-grid">' + rows.map(function (ph) {
              return '<div class="album-item">'
                + '<div class="album-ph"><img src="' + escAttr(ph.thumb_data) + '" alt="'
                + escAttr(ph.caption || '照片') + '"></div>'
                + '<div class="album-cap">' + esc(ph.caption || '没有说明')
                + '<span class="d">' + esc(dayOf(ph.taken_on)) + '</span></div></div>';
            }).join('') + '</div></div>';
      }, function () { box.innerHTML = ''; });
  }

  function unlockComments(slug) {
    var box = el('comment-box'), form = el('comment-form-box'), list = el('comment-list');
    if (list) list.setAttribute('data-slug', slug);
    if (box) box.hidden = false;
    if (form) form.hidden = false;
    // cloud.js 负责评论区，但那时它还不知道 slug（文章是异步读出来的），
    // 所以这里把 slug 填好之后再叫它一声。
    if (window.PixelCloud && window.PixelCloud.initComments) {
      window.PixelCloud.initComments(slug);
    } else {
      window.addEventListener('pixel:cloud-ready', function () {
        if (window.PixelCloud && window.PixelCloud.initComments) {
          window.PixelCloud.initComments(slug);
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // 相册
  // -------------------------------------------------------------------------
  // 列表只取 thumb_data（一张约 27KB），原图（300KB 上下）等真要看了再单独取
  // 那一张 —— 不然进一次相册就要下几十兆。
  //
  // 照片是分相册的：发帖时顺带传的照片统一进「博客」相册，不跟别的照片混。
  // 页面上按相册分栏看，大图左右翻也只在当前这个相册里翻。
  var ALBUM_ALL = [];   // 从云端取回的全部照片
  var ALBUM = [];       // 当前相册里的照片（与网格顺序一致，供大图左右切换）
  var ALBUM_KEY = '';   // 当前看的是哪个相册；空字符串 = 全部
  var LB_I = -1;        // 当前在看第几张

  // 一张照片算在哪个相册：
  //   挂在某篇文章下 → 「博客」（发帖时带的照片都归这儿）
  //   自己填了相册名 → 就用那个名字
  //   什么都没填     → 「散片」
  function albumOf(ph) {
    if (ph.post_slug) return BLOG_ALBUM;
    return ph.album || LOOSE_ALBUM;
  }

  function albumMeta() {
    var count = {}, names = [];
    ALBUM_ALL.forEach(function (ph) {
      var a = albumOf(ph);
      if (!count[a]) { count[a] = 0; names.push(a); }
      count[a]++;
    });
    // 「博客」永远排第一，其余按张数从多到少
    names.sort(function (a, b) {
      if (a === BLOG_ALBUM) return -1;
      if (b === BLOG_ALBUM) return 1;
      return count[b] - count[a];
    });
    return { names: names, count: count };
  }

  function albumTab(key, label, n) {
    return '<button type="button" class="album-tab' + (key === ALBUM_KEY ? ' on' : '')
      + '" data-album="' + escAttr(key) + '">' + esc(label)
      + '<span class="n">' + n + '</span></button>';
  }

  function viewAlbum() {
    var box = el('feed-album');
    if (!box) return;

    // 委托挂在容器上，容器本身不会被 innerHTML 换掉，所以只挂一次。
    // （挂在 .then() 里的话，每次重渲染都会多叠一层监听。）
    if (!box.getAttribute('data-lb-bound')) {
      box.setAttribute('data-lb-bound', '1');
      box.addEventListener('click', onPhotoClick);
      box.addEventListener('click', onAlbumTab);
    }

    run(db().from('photos')
      .select('id,album,post_slug,caption,taken_on,width,height,thumb_data')
      .in('visibility', LISTED_VIS)
      .order('taken_on', { ascending: false })
      .order('sort', { ascending: true })
      .limit(200))
      .then(function (rows) {
        ALBUM_ALL = rows || [];
        var fp = el('foot-photos');
        if (fp) fp.textContent = ALBUM_ALL.length;

        if (!ALBUM_ALL.length) {
          var c0 = el('feed-photo-count');
          if (c0) c0.textContent = '';
          box.innerHTML = emptyTip('相册还是空的。');
          return;
        }
        // 正在看的相册要是照片被删空了，退回「全部」
        if (ALBUM_KEY && albumMeta().names.indexOf(ALBUM_KEY) < 0) ALBUM_KEY = '';
        renderAlbum();
      }, function (err) {
        box.innerHTML = '<div class="empty-tip">相册没能读出来：' + esc(friendly(err)) + '</div>';
      });
  }

  function onAlbumTab(e) {
    var btn = e.target.closest ? e.target.closest('.album-tab') : null;
    if (!btn) return;
    ALBUM_KEY = btn.getAttribute('data-album') || '';
    renderAlbum();
  }

  function renderAlbum() {
    var box = el('feed-album');
    if (!box) return;

    var meta = albumMeta();
    ALBUM = ALBUM_KEY
      ? ALBUM_ALL.filter(function (ph) { return albumOf(ph) === ALBUM_KEY; })
      : ALBUM_ALL.slice();
    LB_I = -1;

    var count = el('feed-photo-count');
    if (count) count.textContent = ALBUM_KEY
      ? (ALBUM_KEY + ' · ' + ALBUM.length + ' 张')
      : ('共 ' + ALBUM.length + ' 张');

    // 只有一个相册时，那排切换键没有意义，不占地方
    var tabs = meta.names.length > 1
      ? '<div class="album-tabs">'
        + albumTab('', '全部', ALBUM_ALL.length)
        + meta.names.map(function (n) { return albumTab(n, n === BLOG_ALBUM ? '博客相册' : n, meta.count[n]); }).join('')
        + (isAdminHint()
          ? '<a class="album-manage" href="' + escAttr(BASE + 'admin.html?pane=photos') + '">管理照片</a>'
          : '')
        + '</div>'
      : (isAdminHint()
        ? '<div class="album-tabs"><span class="album-tabs-hint">' + esc(meta.names[0] || '') + '</span>'
          + '<a class="album-manage" href="' + escAttr(BASE + 'admin.html?pane=photos') + '">管理照片</a></div>'
        : '');

    box.innerHTML = '<div class="cell"><div class="cell-title bar-1">'
      + '<img class="pixel" src="' + BASE + 'assets/t_wall.png" alt="照片墙">'
      + '<span class="en">' + ALBUM.length + ' PHOTOS</span></div>'
      + '<div class="cell-body">' + tabs + '<div class="album-grid">'
      + ALBUM.map(function (ph, i) {
          var d = dayOf(ph.taken_on);
          var a = albumOf(ph);
          return '<button class="photo-card" type="button" data-i="' + i + '">'
            + '<div class="album-ph"><img src="' + escAttr(ph.thumb_data) + '" alt="'
            + escAttr(ph.caption || '照片') + '" loading="lazy"></div>'
            + '<div class="album-cap">' + esc(ph.caption || '没有说明')
            + '<span class="d">' + esc(d) + '</span>'
            + '<span class="d from">' + esc(a) + '</span>'
            + '</div></button>';
        }).join('')
      + '</div></div></div>';
  }

  function onPhotoClick(e) {
    var btn = e.target.closest ? e.target.closest('.photo-card') : null;
    if (!btn) return;
    openLightbox(Number(btn.getAttribute('data-i')));
  }

  // 大图查看器：左图右信息、左右翻页、底部缩略图条（照 QQ 空间相册那套排的）。
  // 不用模态库，纯 DOM + 事件；样式全在 style.css 的 .pixel-lightbox 段落。
  function ensureLightbox() {
    var box = el('pixel-lightbox');
    if (box) return box;

    box = document.createElement('div');
    box.className = 'pixel-lightbox';
    box.id = 'pixel-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '照片大图');
    box.innerHTML =
      '<div class="lb-shell">'
      + '<div class="lb-bar">'
      +   '<span class="lb-album"></span>'
      +   '<span class="lb-count"></span>'
      +   '<button class="lb-close" type="button" aria-label="关闭">✕</button>'
      + '</div>'
      + '<div class="lb-body">'
      +   '<div class="lb-view">'
      +     '<button class="lb-nav lb-prev" type="button" aria-label="上一张">‹</button>'
      +     '<div class="lb-stage"></div>'
      +     '<button class="lb-nav lb-next" type="button" aria-label="下一张">›</button>'
      +   '</div>'
      +   '<aside class="lb-side">'
      +     '<div class="lb-cap"></div>'
      +     '<div class="lb-meta"></div>'
      +     '<div class="lb-from"></div>'
      +     '<div class="lb-hint">← → 翻页 · Esc 关闭</div>'
      +     '<div class="lb-strip"></div>'
      +   '</aside>'
      + '</div>'
      + '</div>';
    document.body.appendChild(box);

    box.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t.closest) return;
      if (t === box || t.closest('.lb-close')) { closeLightbox(); return; }
      if (t.closest('.lb-prev')) { showPhoto(LB_I - 1); return; }
      if (t.closest('.lb-next')) { showPhoto(LB_I + 1); return; }
      var th = t.closest('.lb-strip button');
      if (th) showPhoto(Number(th.getAttribute('data-i')));
    });

    document.addEventListener('keydown', function (ev) {
      if (!box.classList.contains('on')) return;
      if (ev.key === 'Escape') { closeLightbox(); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); showPhoto(LB_I - 1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); showPhoto(LB_I + 1); }
    });

    // 手机上左右划
    var tx = 0, ty = 0;
    box.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 1) return;
      tx = ev.touches[0].clientX; ty = ev.touches[0].clientY;
    }, { passive: true });
    box.addEventListener('touchend', function (ev) {
      var t = ev.changedTouches[0];
      if (!t) return;
      var dx = t.clientX - tx, dy = t.clientY - ty;
      if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        showPhoto(LB_I + (dx < 0 ? 1 : -1));
      }
    });

    return box;
  }

  function openLightbox(i) {
    if (!ALBUM.length) return;
    var box = ensureLightbox();
    box.classList.add('on');
    document.body.style.overflow = 'hidden';

    // 缩略图条只在第一次打开时建，之后照片变动由 viewAlbum 重渲染时重置
    var strip = box.querySelector('.lb-strip');
    if (strip.getAttribute('data-n') !== String(ALBUM.length)) {
      strip.setAttribute('data-n', String(ALBUM.length));
      strip.innerHTML = ALBUM.map(function (p, k) {
        return '<button type="button" data-i="' + k + '" aria-label="第 ' + (k + 1) + ' 张">'
          + '<img src="' + escAttr(p.thumb_data) + '" alt="" loading="lazy"></button>';
      }).join('');
    }
    showPhoto(i);
  }

  function closeLightbox() {
    var box = el('pixel-lightbox');
    if (!box) return;
    box.classList.remove('on');
    document.body.style.overflow = '';
    LB_I = -1;       // 图留在 DOM 里，下次打开不用重下；但正在加载的那张作废
  }

  function photoFull(i) {
    var ph = ALBUM[i];
    if (!ph) return Promise.resolve('');
    if (ph.full !== undefined) return Promise.resolve(ph.full);
    return run(db().from('photos').select('image_data').eq('id', Number(ph.id)).limit(1))
      .then(function (rows) {
        ph.full = (rows && rows[0] && rows[0].image_data) || '';
        return ph.full;
      }, function () { return ''; });
  }

  function showPhoto(i) {
    if (!ALBUM.length) return;
    var n = ALBUM.length;
    i = ((i % n) + n) % n;          // 首尾循环：第一张再往左就是最后一张
    LB_I = i;
    var ph = ALBUM[i];
    var box = el('pixel-lightbox');
    if (!box) return;

    // 只有一张照片时不摆翻页键和「1 / 1」——点了也是同一张，纯属噪声
    if (n < 2) box.classList.add('lb-single'); else box.classList.remove('lb-single');

    box.querySelector('.lb-album').textContent = albumOf(ph);
    box.querySelector('.lb-count').textContent = (i + 1) + ' / ' + n;
    box.querySelector('.lb-hint').textContent =
      n < 2 ? 'Esc 关闭' : '← → 翻页 · Esc 关闭';

    box.querySelector('.lb-cap').textContent = ph.caption || '没有说明';
    var meta = [];
    if (ph.taken_on) meta.push(['拍摄', dayOf(ph.taken_on)]);
    if (ph.width && ph.height) meta.push(['像素', ph.width + ' × ' + ph.height]);
    meta.push(['相册', albumOf(ph)]);
    box.querySelector('.lb-meta').innerHTML = meta.map(function (m) {
      return '<div class="lb-meta-row"><span class="k">' + esc(m[0])
        + '</span><span class="v">' + esc(m[1]) + '</span></div>';
    }).join('');

    // 来源文章只认前台已经公开的标题；映射不到就不给链接，免得把未公开的标题带出来
    var from = box.querySelector('.lb-from');
    var map = (window.SITE_DATA && window.SITE_DATA.posts) || {};
    var post = map[ph.post_slug];
    from.innerHTML = post
      ? '<a href="' + escAttr(postUrl(ph.post_slug)) + '">出自《' + esc(post.title) + '》→</a>'
      : '';

    var ths = box.querySelectorAll('.lb-strip button');
    for (var k = 0; k < ths.length; k++) {
      if (k === i) ths[k].classList.add('on'); else ths[k].classList.remove('on');
    }
    var cur = ths[i];
    if (cur && cur.scrollIntoView) {
      cur.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    // 先把缩略图糊上去顶着，原图到了再淡入 —— 不然要空一两秒
    var stage = box.querySelector('.lb-stage');
    stage.innerHTML =
      '<img class="lb-thumb" src="' + escAttr(ph.thumb_data) + '" alt="">'
      + '<img class="lb-full" alt="' + escAttr(ph.caption || '照片') + '">';

    var full = stage.querySelector('.lb-full');
    var mine = i;
    photoFull(i).then(function (src) {
      if (LB_I !== mine) return;    // 已经翻走了，别把旧图贴上来
      if (!src) { full.classList.add('fail'); return; }
      full.onload = function () { full.classList.add('ready'); };
      full.src = src;
    });

    // 这张看稳了再把前后两张的原图拉回来，翻页就不用等
    window.setTimeout(function () {
      if (LB_I !== mine) return;
      photoFull((mine + 1) % n);
      photoFull(((mine - 1 + n) % n));
    }, 900);
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function needsContent() {
    return !!(el('feed-posts') || el('feed-archive') || el('feed-album') || el('post-article')
      || el('cat-list') || el('arch-list') || el('cat-title'));
  }

  function loadPosts() {
    // 只拉需要的列：正文可能在几十 KB，列表页用不上
    return run(db().from('posts')
      .select('id,slug,title,excerpt,category,tags,kind,visibility,featured,published_on,owner_name,updated_at')
      .order('published_on', { ascending: false })
      .order('id', { ascending: false })
      .limit(500));
  }

  function broadcast() {
    // cloud.js 的「最近互动」要认得出文章标题，靠的就是这份映射
    var map = {};
    ALL.forEach(function (p) { map[p.slug] = { title: p.title, url: 'post.html?slug=' + p.slug }; });
    window.PIXEL_POSTS = map;
    window.PIXEL_POSTS_READY = true;
    window.dispatchEvent(new CustomEvent('pixel:posts-ready'));
  }

  function boot() {
    if (!needsContent()) return;

    // 先读分类再读文章：文章卡片上的分类链接、侧边栏那份名单都靠它。
    // loadCats() 自己吞掉错误，读不到不影响下面继续拉文章。
    loadCats().then(function () {
      return loadPosts();
    }).then(function (rows) {
      ALL = rows || [];
      // 能被列出来的是这几档：所有人 / 好友 / 部分人可见 / 部分人不可见。
      // 读不读得到由数据库策略在服务端管，这里只决定要不要进列表。
      PUBLIC = ALL.filter(function (p) {
        return LISTED_VIS.indexOf(p.visibility) >= 0;
      });
      return loadCovers();
    }).then(function () {
      return loadNotes();
    }).then(function () {
      prepareCategoryPage();
      viewList();
      viewArchive();
      viewCounts();
      paintCatList();
      paintArchList();
      broadcast();
      viewPost();
      if (window.PixelLikes) window.PixelLikes.refresh();
    }, function (err) {
      // 读不到就保住静态兜底，只补一句人话
      var note = '<div class="empty-tip">内容没能从云端读出来：' + esc(friendly(err))
        + ' 刷新一下试试。</div>';
      ['feed-posts', 'feed-archive', 'feed-album'].forEach(function (id) {
        var box = el(id);
        if (box) box.innerHTML = note;
      });
      if (el('post-article')) {
        stateBox('文章没能读出来：' + friendly(err), '回博客列表', BASE + 'blog.html');
      }
      prepareCategoryPage();
      paintCatList();
      paintArchList();
      broadcast();
    });

    viewAlbum();
  }

  // 前台「写一篇 / 传照片」存完要立刻看到新内容，不用整页刷新。
  // 暴露 boot 而不是 viewList：boot 会重新读分类和文章再重绘所有视图，
  // 只重绘列表的话新文章还在旧数组里，看不见。
  window.PixelFeed = { reload: boot };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
