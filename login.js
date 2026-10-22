/*!
 * 像素日常 · 访客账号（邮箱验证码登录 / 取昵称）
 * ============================================
 * 留言和评论改成「先登录再发言」之后，访客需要一个入口。就是这一页。
 *
 * 三条边界：
 *   1. 浏览本站永远不需要登录。这一页只管「发言的身份」。
 *   2. 前端不做权限判断，一切由数据库的行级安全策略裁决。
 *      客户端提交时连 uid 和昵称都不用带——数据库自己用 auth.uid() 和
 *      pixel_display_name() 填，带错了反而会被策略拒掉。
 *   3. 收不到验证码、昵称被占、会话失效，每种失败都要有一句人能看懂的中文。
 *
 * 页面上只有一个主路径：填邮箱 → 收验证码 → 登录。
 * 「注册」在实现上是 verifyOtp 顺手建号，访客不需要知道这个概念，
 * 所以界面上不出现。（后端要求新邮箱账号必须带密码，我们给一个随机的
 * 扔掉的密码，别让这一步挡在访客面前——以后一律走验证码登录。）
 * 密码登录留作备选，给站长和早先设过密码的账号用。
 *
 * 依赖：cloud-config.js → WorkBuddy Cloud SDK → 本文件，顺序不能变。
 */
(function () {
  'use strict';

  var CONFIG = window.PIXEL_CLOUD_CONFIG || {};

  var NAME_MIN = 2;
  var NAME_MAX = 24;

  var ME = { uid: '', email: '', name: '', avatar: '', isAdmin: false };

  var pending = null;      // { email, verificationId, isExistingUser }
  var nextUrl = '';        // 校验过的回跳地址
  var justActed = false;   // 刚登录 / 刚存完昵称，用于决定要不要立刻回跳
  var decided = false;     // 是否已经决定了显示哪一块界面
  var MODE_KEY = 'pixel-login-mode';   // 上次用的是验证码还是密码

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------
  function el(id) { return document.getElementById(id); }

  function show(node, on) { if (node) node.hidden = !on; }

  function run(q) {
    return Promise.resolve(q).then(function (res) {
      if (res && res.error) throw res.error;
      return res && res.data ? res.data : [];
    });
  }

  function msg(box, text, isError) {
    if (!box) return;
    box.textContent = text || '';
    box.className = 'form-msg ' + (text ? (isError ? 'is-error' : 'is-ok') : '');
  }

  // 处理器里任何一处同步抛错，浏览器只会往控制台丢一行红字、页面上毫无反应。
  // 套一层之后异常变成看得见的中文提示。
  function guard(msgId, fn) {
    return function (e) {
      try {
        return fn.call(this, e);
      } catch (err) {
        if (window.console && console.error) console.error('[像素日常账号]', err);
        msg(el(msgId), '页面出错了：' + ((err && err.message) || err)
          + '。刷新页面再试。', true);
        return undefined;
      }
    };
  }

  function errText(err) {
    if (!err) return '操作没成功，请稍后再试。';
    if (err.message === 'SDK_MISSING') return '云端脚本没加载成功——检查网络后刷新页面。';
    switch (err.kind) {
      case 'invalid_grant': return '账号或密码不对。';
      case 'unauthenticated': return '登录状态已失效，请重新登录。';
      case 'network':
      case 'backend-unavailable': return '网络不太顺，稍后再试。';
      default: break;
    }
    switch (err.code) {
      case '42501': return '服务器拒绝了这次操作。退出后用邮箱验证码重新登录一次再试。';
      case '23505': return '这个昵称已经有人用了，换一个。';
      case '23514': return '内容不符合要求（长度或状态不合法）。';
      case '23502': return '云端没认出你的登录状态。退出登录后重新登一次再试。';
      case '42P01': return '云端还没准备好，请稍后再试。';
      default: break;
    }
    if (err.message && /fetch|network|Failed/i.test(err.message)) {
      return '连不上云端——检查网络后重试。';
    }
    // 这一条专指旧版 login.js：它给新邮箱发验证码时没带密码，后端当场拒绝。
    // 浏览器缓存了旧脚本才会出现，刷新一次拿到带版本号的新脚本就好。
    if (err.message && /signUp with email requires a password/i.test(err.message)) {
      return '页面还是上一版的脚本，刷新一下再登录（按 Ctrl+F5 更快）。';
    }
    var raw = err.message || '';
    // 纯英文的多半是 SDK / 后端抛的实现细节，不该摊在访客面前。
    // 原文留在控制台里，排障时还能看见。
    if (raw && !/[\u4e00-\u9fa5]/.test(raw)) {
      if (window.console && console.warn) console.warn('[login]', raw);
      return '操作没成功。刷新一下再试；一直这样的话，去留言板说一声。';
    }
    return '操作没成功：' + (raw || '未知错误');
  }

  // SDK 的 parseUser() 只把 /me 返回里的 email 透出来，而这个环境的 /me
  // 不带邮箱，所以 u.email 常常是空的。顺带翻一遍 raw 兜底。
  function pickEmail(u) {
    if (!u) return '';
    var r = u.raw || {};
    var m = u.user_metadata || {}, rm = r.user_metadata || {};
    return u.email || r.email || m.email || rm.email || '';
  }

  // 再兜一层：直接解 access_token 的 payload。
  // 走邮箱注册/登录拿到的 JWT 里通常带 email 声明。
  function emailFromToken(token) {
    var parts = String(token || '').split('.');
    if (parts.length < 2) return '';
    try {
      var base = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base.length % 4) base += '=';
      var bin = atob(base);
      var json = decodeURIComponent(bin.split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      var p = JSON.parse(json), m = p.user_metadata || {};
      return p.email || m.email || '';
    } catch (e) {
      return '';
    }
  }

  function sessionEmail() {
    return Promise.resolve(auth().getSession()).then(function (res) {
      var s = res && !res.error && res.data;
      return s ? emailFromToken(s.access_token) : '';
    }, function () { return ''; });
  }

  // 回跳地址只接受本站的绝对路径。
  // 不校验的话 next=//evil.com 就成了开放重定向。
  function safeNext(raw) {
    var v = String(raw || '').trim();
    if (!v || v.charAt(0) !== '/') return '';
    if (v.charAt(1) === '/' || v.charAt(1) === '\\') return '';
    if (/[\r\n\t]/.test(v)) return '';
    return v;
  }

  function qs(key) {
    var m = new RegExp('[?&]' + key + '=([^&]*)').exec(location.search || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  // -------------------------------------------------------------------------
  // 云客户端
  // -------------------------------------------------------------------------
  var _sdk = null;

  function sdk() {
    if (_sdk) return _sdk;
    var S = window.WorkBuddyCloud;
    if (!S || typeof S.createWorkBuddyCloud !== 'function') throw new Error('SDK_MISSING');
    _sdk = S.createWorkBuddyCloud(CONFIG);
    return _sdk;
  }

  function db() { return sdk().database; }
  function auth() { return sdk().auth; }

  function currentUser() {
    return Promise.resolve(auth().getUser()).then(function (res) {
      if (!res || res.error) return null;
      var u = res.data;
      return (u && (u.user || u)) || null;
    }, function () { return null; });
  }

  // -------------------------------------------------------------------------
  // 界面切换
  // -------------------------------------------------------------------------
  function showAuth() {
    decided = true;
    show(el('guest-auth'), true);
    show(el('guest-account'), false);
    document.body.setAttribute('data-stage', 'auth');
  }

  function showAccount(hasName) {
    decided = true;
    show(el('guest-auth'), false);
    show(el('guest-account'), true);
    document.body.setAttribute('data-stage', 'account');

    var em = el('me-email');
    if (em) em.textContent = ME.email || '你的账号';
    var nm = el('me-name');
    if (nm) nm.textContent = hasName ? ME.name : '还没取';

    var intro = el('nick-intro');
    if (intro) {
      intro.textContent = hasName
        ? '这是你现在的昵称，想改随时改，改完立刻生效。'
        : '第一次来，先给自己取个昵称——留言和评论旁边显示的就是它。';
    }
    var save = el('nick-save');
    if (save) save.textContent = hasName ? '保存修改' : '就这个';
    var input = el('nick-input');
    if (input) input.value = hasName ? ME.name : '';

    // 头像另取一次：它有自己的一张表，取不到也不该拖垮整页。
    // 站长标记跟它并行查，互不依赖。
    loadAvatar().then(paintAvatar);
    loadAdminFlag();
  }

  // 登录页通常是「从中途被赶过来的」：带着 ?next= 说明那边有活要接着干。
  function maybeLeave() {
    if (!nextUrl) return false;
    location.href = nextUrl;
    return true;
  }

  // -------------------------------------------------------------------------
  // 身份：会话 + 昵称 + 头像
  // -------------------------------------------------------------------------
  function loadProfile() {
    // profiles 的行级策略只放行自己那一行，所以查得到 == 我有昵称。
    // 不需要在前端比对任何 uid，uid 也顺便从这一行里拿到。
    return run(db().from('profiles').select('uid, display_name').limit(1))
      .then(function (rows) {
        var r = rows && rows[0];
        if (!r) { ME.uid = ''; ME.name = ''; return false; }
        ME.uid = r.uid || '';
        ME.name = r.display_name || '';
        return true;
      });
  }

  // 头像单独一张表（avatars），不塞进 profiles：profiles 只放行自己那一行，
  // 访客读不到别人的，头像就没法显示在留言旁边了。avatars 是公开可读的。
  // 也正因为公开可读，select 必须自己带上 uid 过滤 —— 不带的话拉到的是全站头像。
  function loadAvatar() {
    if (!ME.uid) { ME.avatar = ''; return Promise.resolve(); }
    return run(db().from('avatars').select('uid, data').eq('uid', ME.uid))
      .then(function (rows) {
        ME.avatar = (rows && rows[0] && rows[0].data) || '';
      })
      .catch(function () { ME.avatar = ''; });   // 头像取不到不该影响整页
  }

  // 「我是不是站长」= site_admins 里能不能查到自己那一行（策略只放行自己那行）。
  // 站长的头像除了显示在留言旁边，还要顶掉侧栏和关于页那张构建期生成的静态图，
  // 所以他自己这一行要多一个 is_site 标记，由 owner-avatar.js 全站读取。
  function loadAdminFlag() {
    if (!ME.uid) { ME.isAdmin = false; return Promise.resolve(false); }
    return run(db().from('site_admins').select('uid'))
      .then(function (rows) { ME.isAdmin = !!(rows && rows.length); return ME.isAdmin; })
      .catch(function () { ME.isAdmin = false; return false; });
  }

  // 保存头像之后顺手维护「站点头像」这个标记。非站长根本不会走到这儿：
  // is_site 只允许 pixel_is_admin() 设成 true，硬发请求也会被策略拒。
  // 失败不吭声 —— 头像本身已经存上了，这个标记只影响侧栏那张图。
  function markSiteAvatar(on) {
    if (!ME.uid) return Promise.resolve();
    var ready = ME.isAdmin ? Promise.resolve(true) : loadAdminFlag();
    return ready.then(function (isAdmin) {
      if (!isAdmin) return;
      return run(db().from('avatars')
        .update({ is_site: !!on })
        .eq('uid', ME.uid));
    }).catch(function () {});
  }

  // 当前页面上如果也有站点头像（侧栏 / 关于页），存完立刻换掉，
  // 不用等刷新 —— 否则刚传完图还得手动刷一次才看得到。
  // 第一次改之前把静态图地址记在 data-orig 上，去掉头像时还能回落。
  function paintSiteAvatar(src) {
    var slots = document.querySelectorAll('img[data-site-avatar]');
    for (var i = 0; i < slots.length; i++) {
      var node = slots[i];
      if (!node.getAttribute('data-orig')) {
        node.setAttribute('data-orig', node.getAttribute('src') || '');
      }
      node.src = src || node.getAttribute('data-orig');
    }
  }

  function paintAvatar() {
    var slot = el('avatar-slot');
    if (!slot) return;
    var can = !!ME.uid;
    var img = can ? safeAvatar(ME.avatar) : '';
    slot.innerHTML = img ? '<img src="' + img + '" alt="我的头像">' : '';
    var clear = el('avatar-clear');
    if (clear) clear.disabled = !img;
    var file = el('avatar-file');
    if (file) file.disabled = !can;
    var lab = document.querySelector('label[for="avatar-file"]');
    if (lab) lab.className = 'btn' + (can ? '' : ' is-off');
  }

  // 头像地址会被当成 HTML 插进页面，而 avatars 表是公开可读的 ——
  // 谁都能往自己那一行塞一段 data:image/... 后面接引号和 onerror。
  // 所以只认「规规矩矩的 base64 图片」，别的一律当没设头像。
  function safeAvatar(s) {
    return /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/.test(String(s || ''))
      ? s : '';
  }

  // 缩到 96×96 再存。手机原图动辄三四 MB，直接塞进数据库会让每次读留言
  // 都拖着几百 KB 走。96 这个尺寸是量出来的：列表里显示 26px、侧栏 62px，
  // 只有关于页那张是 108px —— 96 放大到 108 几乎看不出差别，
  // 而 64 放大会明显发虚（`.avatar-lg` 还带 pixelated，糊得更显眼）。
  // 先按短边居中裁成正方形，再缩 —— 不然竖图会被压扁。
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) {
        reject(new Error('这个文件不是图片。'));
        return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var S = 96;
        var side = Math.min(img.width, img.height);
        var sx = (img.width - side) / 2;
        var sy = (img.height - side) / 2;
        var cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
        var cx = cv.getContext('2d');
        cx.drawImage(img, sx, sy, side, side, 0, 0, S, S);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这张图读不出来，换一张试试。'));
      };
      img.src = url;
    });
  }

  function saveAvatar(data) {
    var stamp = new Date().toISOString();
    // 行可能还不存在：先按 uid 更新，一行都没改到再插一条。
    // 不用 upsert —— onConflict 各家实现不完全一致，而「update 没中就 insert」
    // 跟本页存昵称是同一套写法，结果确定，出问题也好查。
    return run(db().from('avatars')
      .update({ data: data, updated_at: stamp })
      .eq('uid', ME.uid).select('uid, data'))
      .then(function (rows) {
        if (rows && rows.length) return rows;
        return run(db().from('avatars')
          .insert({ uid: ME.uid, data: data, updated_at: stamp })
          .select('uid, data'));
      });
  }

  // 两种登录方式共用一条提示位，但提示框得显示在当前看得见的那一栏。
  function modeMsgId() {
    return document.body.getAttribute('data-login-mode') === 'password'
      ? 'login-msg' : 'login-code-msg';
  }

  function refresh() {
    return currentUser().then(function (user) {
      if (!user) { showAuth(); return; }
      ME.email = pickEmail(user);
      return loadProfile().then(function (has) {
        // 还是没邮箱就找 token 要——不然账号页会显示一句「未取到邮箱」，
        // 看着像出错了，其实只是 SDK 没往外带。
        if (ME.email) { showAccount(has); if (justActed && has) maybeLeave(); return; }
        return sessionEmail().then(function (em) {
          ME.email = em;
          showAccount(has);
          if (justActed && has) maybeLeave();
        });
      });
    }).catch(function (err) {
      showAuth();
      msg(el(modeMsgId()), errText(err), true);
    });
  }

  // -------------------------------------------------------------------------
  // 验证码：发送与校验必须分开，校验时绝不重发
  // -------------------------------------------------------------------------
  function bindCountdown(btn, seconds) {
    if (!btn) return;
    var label = btn.textContent;
    var left = seconds;
    btn.disabled = true;
    btn.textContent = left + ' 秒后可重发';
    var t = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(t);
        btn.disabled = false;
        btn.textContent = label;
      } else {
        btn.textContent = left + ' 秒后可重发';
      }
    }, 1000);
  }

  function bindSendCode(btnId, mailId, msgId) {
    var btn = el(btnId);
    if (!btn) return;
    btn.addEventListener('click', guard(msgId, function () {
      if (btn.disabled) return;
      var email = (el(mailId).value || '').trim();
      var box = el(msgId);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return msg(box, '先填一个正确的邮箱。', true);
      }
      btn.disabled = true;
      msg(box, '正在发送验证码…', false);
      auth().sendOtp({ email: email }).then(function (res) {
        if (res.error) throw res.error;
        pending = {
          email: email,
          verificationId: res.data.verificationId,
          isExistingUser: res.data.isExistingUser
        };
        msg(box, '验证码已发到邮箱，去收一下。', false);
        bindCountdown(btn, 60);
      }).catch(function (err) {
        btn.disabled = false;
        msg(box, errText(err), true);
      });
    }));
  }

  // 后端不接受「有邮箱、没密码」的新账号，所以新邮箱第一次验证时必须带一个
  // 密码。这个密码访客不需要知道也不需要记住——他以后一律用验证码进来。
  // 给个随机串把这道门槛绕过去，别让「设密码」挡在访客面前。
  var PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

  function throwawayPassword() {
    var buf = new Uint8Array(18), i, s = 'px-';
    try {
      window.crypto.getRandomValues(buf);
    } catch (e) {
      for (i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    for (i = 0; i < buf.length; i++) s += PW_CHARS.charAt(buf[i] % PW_CHARS.length);
    return s;
  }

  // codeInputId 必须显式传进来：早先靠 msgId 做字符串反推，
  // 遇上命名不统一的元素就会算出一个不存在的 id，取 .value 当场抛异常，
  // 用户看到的就是「点了没反应」。
  function verify(mailInputId, codeInputId, msgId) {
    var email = (el(mailInputId).value || '').trim();
    var box = el(msgId);
    if (!pending || pending.email !== email) {
      msg(box, '先点「获取验证码」，拿当前邮箱的验证码。', true);
      return Promise.reject(new Error('NO_PENDING'));
    }
    var codeEl = el(codeInputId);
    if (!codeEl) {
      msg(box, '页面元素丢了（找不到验证码输入框），刷新页面再来。', true);
      return Promise.reject(new Error('NO_TOKEN_FIELD'));
    }
    var token = (codeEl.value || '').trim();
    if (!token) {
      msg(box, '验证码还没填。', true);
      if (codeEl.focus) codeEl.focus();
      return Promise.reject(new Error('NO_TOKEN'));
    }
    return auth().verifyOtp({
      email: pending.email,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: token,
      // 无条件带上密码。老账号走的是「验证码换会话」那条分支，后端压根不看
      // 这个字段；新账号则必须有它——后端明写「没有密码的邮箱账号永远没法
      // 用密码登录，所以直接拒绝创建」。早先这里写成按 isExistingUser 判断，
      // 一旦那个标记不准（或前端跑的是旧脚本）就会撞上这句拒绝。
      // 访客不需要知道这个密码，以后一律用验证码进门。
      password: throwawayPassword()
    }).then(function (res) {
      if (res.error) throw res.error;
      pending = null;
      return res.data;
    });
  }

  function setLoginMode(mode) {
    var byCode = mode === 'code';
    document.body.setAttribute('data-login-mode', byCode ? 'code' : 'password');
    var lead = el('login-mode-lead');
    if (lead) lead.textContent = byCode ? '以前设过密码？' : '不想输密码？';
    var toggle = el('login-mode-toggle');
    if (toggle) toggle.textContent = byCode ? '用密码登录' : '改用邮箱验证码登录';
    show(el('login-form'), !byCode);
    show(el('login-code-form'), byCode);
    msg(el('login-msg'), '', false);
    msg(el('login-code-msg'), '', false);
  }

  // 默认用验证码。上次用过密码登录（站长多半是这样）就记住，不让他每次多点一下。
  function defaultMode() {
    try {
      return window.localStorage.getItem(MODE_KEY) === 'password' ? 'password' : 'code';
    } catch (e) {
      return 'code';
    }
  }

  function rememberMode(mode) {
    try { window.localStorage.setItem(MODE_KEY, mode); } catch (e) { /* 隐私模式下忽略 */ }
  }

  // -------------------------------------------------------------------------
  // 登录成功后统一入口
  // -------------------------------------------------------------------------
  function afterSignIn(data) {
    justActed = true;
    var session = (data && data.session) || data || null;
    var user = (data && data.user) || (session && session.user) || null;
    if (user) ME.email = pickEmail(user);
    return refresh();
  }

  // -------------------------------------------------------------------------
  // 表单绑定
  // -------------------------------------------------------------------------
  function bindLogin() {
    var form = el('login-form');
    if (form) {
      form.addEventListener('submit', guard('login-msg', function (e) {
        e.preventDefault();
        var email = (el('login-email').value || '').trim();
        var pwd = el('login-password').value || '';
        var box = el('login-msg');
        if (!email) return msg(box, '邮箱还没填。', true);
        if (!pwd) return msg(box, '密码还没填。', true);
        var btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        msg(box, '正在登录…', false);
        auth().signInWithPassword({ email: email, password: pwd }).then(function (res) {
          if (res.error) throw res.error;
          rememberMode('password');
          return afterSignIn(res.data);
        }).catch(function (err) {
          msg(box, errText(err), true);
        }).then(function () {
          btn.disabled = false;
        });
      }));
    }

    var toggle = el('login-mode-toggle');
    if (toggle) {
      toggle.addEventListener('click', guard('login-msg', function (e) {
        e.preventDefault();
        var now = document.body.getAttribute('data-login-mode') === 'code' ? 'code' : 'password';
        setLoginMode(now === 'code' ? 'password' : 'code');
        var mail = el('login-email');
        if (mail && mail.focus) mail.focus();
      }));
    }

    var codeForm = el('login-code-form');
    if (codeForm) {
      codeForm.addEventListener('submit', guard('login-code-msg', function (e) {
        e.preventDefault();
        var btn = codeForm.querySelector('button[type=submit]');
        if (btn) btn.disabled = true;
        verify('login-email', 'login-code', 'login-code-msg')
          .then(function (data) {
            rememberMode('code');
            return afterSignIn(data);
          })
          .catch(function (err) {
            if (err && (err.message === 'NO_PENDING' || err.message === 'NO_TOKEN'
              || err.message === 'NO_TOKEN_FIELD')) return;
            msg(el('login-code-msg'), errText(err), true);
          })
          .then(function () {
            if (btn) btn.disabled = false;
          });
      }));
    }
    bindSendCode('login-send-code', 'login-email', 'login-code-msg');
  }

  // 昵称：没有就插入，有就更新。
  // 客户端一个 uid 都不传——profiles.uid 的默认值就是 auth.uid()，
  // 行级策略再核对一遍，伪造不出来。
  function bindNick() {
    var form = el('nick-form');
    if (!form) return;
    form.addEventListener('submit', guard('nick-msg', function (e) {
      e.preventDefault();
      var box = el('nick-msg');
      var name = (el('nick-input').value || '').trim();
      if (name.length < NAME_MIN || name.length > NAME_MAX) {
        return msg(box, '昵称要 ' + NAME_MIN + ' 到 ' + NAME_MAX + ' 个字。', true);
      }
      if (name === ME.name) return msg(box, '和现在的一样，没改动。', true);

      var btn = el('nick-save');
      if (btn) btn.disabled = true;
      msg(box, '正在保存…', false);

      var q;
      if (ME.uid) {
        q = db().from('profiles')
          .update({ display_name: name, updated_at: new Date().toISOString() })
          .eq('uid', ME.uid).select('uid, display_name');
      } else {
        q = db().from('profiles').insert({ display_name: name }).select('uid, display_name');
      }

      run(q).then(function (rows) {
        var r = rows && rows[0];
        if (r) { ME.uid = r.uid || ME.uid; ME.name = r.display_name || name; }
        else { ME.name = name; }
        msg(box, '昵称已保存。', false);
        showAccount(true);
        if (!maybeLeave()) {
          // 没有回跳目标就留在本页，让用户看到改完了
        }
      }).catch(function (err) {
        msg(box, errText(err), true);
      }).then(function () {
        if (btn) btn.disabled = false;
      });
    }));
  }

  function bindAvatar() {
    var file = el('avatar-file');
    if (file) {
      file.addEventListener('change', function () {
        var box = el('avatar-msg');
        var f = file.files && file.files[0];
        file.value = '';                       // 清掉才能连着选同一张
        if (!f) return;
        if (!ME.uid) return msg(box, '先在下面取个昵称，再回来设头像。', true);
        msg(box, '正在处理…', false);
        shrink(f).then(function (data) {
          if (data.length > 60000) throw new Error('这张图压完还是太大，换一张。');
          return saveAvatar(data).then(function () {
            ME.avatar = data;
            paintAvatar();
            paintSiteAvatar(data);             // 站长：侧栏 / 关于页当场跟着换
            return markSiteAvatar(true);
          }).then(function () {
            msg(box, '头像已保存。', false);
          });
        }).catch(function (err) {
          msg(box, err.message || errText(err), true);
        });
      });
    }

    var clear = el('avatar-clear');
    if (clear) {
      clear.addEventListener('click', guard('avatar-msg', function () {
        var box = el('avatar-msg');
        if (!ME.avatar) return msg(box, '现在就没有头像。', true);
        clear.disabled = true;
        msg(box, '正在保存…', false);
        // 存空串而不是删行：建约束允许 data=''，读到空串就当没设头像。
        saveAvatar('').then(function () {
          ME.avatar = '';
          paintAvatar();
          paintSiteAvatar('');               // 侧栏 / 关于页回落成原来那张静态图
          return markSiteAvatar(false);
        }).then(function () {
          msg(box, '头像已去掉。', false);
        }).catch(function (err) {
          msg(box, errText(err), true);
          clear.disabled = false;
        });
      }));
    }
  }

  function bindLogout() {
    var btn = el('logout-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      auth().signOut().then(function () {
        location.reload();
      }, function () {
        location.reload();
      });
    });
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function boot() {
    nextUrl = safeNext(qs('next'));
    bindLogin();
    bindNick();
    bindAvatar();
    bindLogout();
    setLoginMode(defaultMode());

    refresh().catch(function (err) {
      showAuth();
      msg(el(modeMsgId()), errText(err), true);
    });

    // 界面默认 hidden，靠 JS 显示。启动逻辑一旦中断就是一片空白，
    // 所以留个看门狗兜底。
    window.setTimeout(function () {
      if (decided) return;
      showAuth();
      msg(el(modeMsgId()), '页面没能正常启动，刷新一次再试。', true);
    }, 6000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
