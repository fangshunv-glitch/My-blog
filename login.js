/*!
 * 像素日常 · 访客账号（登录 / 注册 / 取昵称）
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
 * 依赖：cloud-config.js → WorkBuddy Cloud SDK → 本文件，顺序不能变。
 */
(function () {
  'use strict';

  var CONFIG = window.PIXEL_CLOUD_CONFIG || {};

  var NAME_MIN = 2;
  var NAME_MAX = 24;

  var ME = { uid: '', email: '', name: '' };

  var pending = null;      // { email, verificationId, isExistingUser }
  var resetHandle = null;  // 找回密码专用句柄
  var nextUrl = '';        // 校验过的回跳地址
  var justActed = false;   // 刚登录 / 刚存完昵称，用于决定要不要立刻回跳
  var decided = false;     // 是否已经决定了显示哪一块界面

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
      case '42501': return '服务器拒绝了这次操作。退出后用「邮箱 + 密码」重新登录一次再试。';
      case '23505': return '这个昵称已经有人用了，换一个。';
      case '23514': return '内容不符合要求（长度或状态不合法）。';
      case '23502': return '云端没认出你的登录状态。退出登录后重新登一次再试。';
      case '42P01': return '云端还没准备好，请稍后再试。';
      default: break;
    }
    if (err.message && /fetch|network|Failed/i.test(err.message)) {
      return '连不上云端——检查网络后重试。';
    }
    return '操作没成功：' + (err.message || '未知错误');
  }

  function pickEmail(u) {
    if (!u) return '';
    return u.email || (u.user_metadata && u.user_metadata.email) || '';
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
    if (em) em.textContent = ME.email || '（未取到邮箱）';
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
  }

  // 登录页通常是「从中途被赶过来的」：带着 ?next= 说明那边有活要接着干。
  function maybeLeave() {
    if (!nextUrl) return false;
    location.href = nextUrl;
    return true;
  }

  // -------------------------------------------------------------------------
  // 身份：会话 + 昵称
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

  function refresh() {
    return currentUser().then(function (user) {
      if (!user) { showAuth(); return; }
      ME.email = pickEmail(user);
      return loadProfile().then(function (has) {
        showAccount(has);
        if (justActed && has) maybeLeave();
      });
    }).catch(function (err) {
      showAuth();
      msg(el('login-msg'), errText(err), true);
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

  // codeInputId 必须显式传进来：早先靠 msgId 做字符串反推，
  // 遇上命名不统一的元素就会算出一个不存在的 id，取 .value 当场抛异常，
  // 用户看到的就是「点了没反应」。
  function verify(mailInputId, codeInputId, msgId, password) {
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
      password: pending.isExistingUser ? undefined : password
    }).then(function (res) {
      if (res.error) throw res.error;
      pending = null;
      return res.data;
    });
  }

  function switchTab(key, keepPending) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (x) {
      var k = x.getAttribute('data-tab');
      x.classList.toggle('active', k === key);
      var pane = el('pane-' + k);
      if (pane) pane.hidden = (k !== key);
    });
    if (keepPending) return;
    pending = null;
    resetHandle = null;
    msg(el('login-msg'), '', false);
    msg(el('login-code-msg'), '', false);
    msg(el('signup-msg'), '', false);
    msg(el('reset-msg'), '', false);
  }

  function setLoginMode(mode) {
    var byCode = mode === 'code';
    document.body.setAttribute('data-login-mode', byCode ? 'code' : 'password');
    var toggle = el('login-mode-toggle');
    if (toggle) toggle.textContent = byCode ? '改用密码登录' : '改用邮箱验证码登录';
    show(el('login-form'), !byCode);
    show(el('login-code-form'), byCode);
    msg(el('login-msg'), '', false);
    msg(el('login-code-msg'), '', false);
  }

  // 注册页发现邮箱已有账号 → 带着邮箱和刚收到的验证码切到登录页。
  // 不点破「这个邮箱注册过」，避免变成账号探测器。
  function handoffToLogin(email) {
    var code = (el('signup-code').value || '').trim();
    switchTab('login', true);
    el('login-email').value = email;
    if (code) el('login-code').value = code;
    setLoginMode('code');
    msg(el('login-code-msg'), '这个邮箱可以直接登录。验证码已经带过来了，点「登录」即可。', false);
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
  function bindTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (x) {
      x.addEventListener('click', guard('login-msg', function (e) {
        e.preventDefault();
        switchTab(x.getAttribute('data-tab'));
      }));
    });
  }

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
      }));
    }

    var codeForm = el('login-code-form');
    if (codeForm) {
      codeForm.addEventListener('submit', guard('login-code-msg', function (e) {
        e.preventDefault();
        var btn = codeForm.querySelector('button[type=submit]');
        if (btn) btn.disabled = true;
        verify('login-email', 'login-code', 'login-code-msg')
          .then(afterSignIn)
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

  function bindSignup() {
    var form = el('signup-form');
    if (!form) return;
    bindSendCode('signup-send-code', 'signup-email', 'signup-msg');
    form.addEventListener('submit', guard('signup-msg', function (e) {
      e.preventDefault();
      var box = el('signup-msg');
      var pwd = el('signup-password').value || '';
      var email = (el('signup-email').value || '').trim();
      if (!pending || pending.email !== email) {
        return msg(box, '先点「获取验证码」，拿当前邮箱的验证码。', true);
      }
      if (pending.isExistingUser) { handoffToLogin(email); return; }
      if (!pwd || pwd.length < 6) return msg(box, '密码至少 6 位。', true);
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      msg(box, '正在创建账号…', false);
      verify('signup-email', 'signup-code', 'signup-msg', pwd).then(function (data) {
        msg(box, '账号建好了。', false);
        return afterSignIn(data);
      }).catch(function (err) {
        if (err && (err.message === 'NO_PENDING' || err.message === 'NO_TOKEN'
          || err.message === 'NO_TOKEN_FIELD')) return;
        msg(box, errText(err), true);
      }).then(function () {
        btn.disabled = false;
      });
    }));
  }

  // 找回密码的验证码必须由 resetPasswordForEmail 发出：
  // 它返回一个句柄，重设时带 nonce 用。拿登录用的 sendOtp 去发，
  // 凭据用途对不上，重设必然失败。
  function bindReset() {
    var form = el('reset-form');
    if (!form) return;

    var sendBtn = el('reset-send-code');
    if (sendBtn) {
      sendBtn.addEventListener('click', guard('reset-msg', function () {
        if (sendBtn.disabled) return;
        var email = (el('reset-email').value || '').trim();
        var box = el('reset-msg');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return msg(box, '先填一个正确的邮箱。', true);
        }
        sendBtn.disabled = true;
        msg(box, '正在发送验证码…', false);
        auth().resetPasswordForEmail(email).then(function (res) {
          if (res.error) throw res.error;
          resetHandle = res.data;
          msg(box, '验证码已发到邮箱，去收一下。', false);
          bindCountdown(sendBtn, 60);
        }).catch(function (err) {
          sendBtn.disabled = false;
          msg(box, errText(err), true);
        });
      }));
    }

    form.addEventListener('submit', guard('reset-msg', function (e) {
      e.preventDefault();
      var box = el('reset-msg');
      var email = (el('reset-email').value || '').trim();
      var code = (el('reset-code').value || '').trim();
      var next = el('reset-password').value || '';
      if (!email) return msg(box, '邮箱还没填。', true);
      if (!resetHandle) return msg(box, '先点「获取验证码」，拿当前邮箱的验证码。', true);
      if (!code) return msg(box, '验证码还没填。', true);
      if (!next || next.length < 6) return msg(box, '新密码至少 6 位。', true);
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      msg(box, '正在重设…', false);
      Promise.resolve(resetHandle.updateUser({ nonce: code, password: next }))
        .then(function (res) {
          if (res && res.error) throw res.error;
          resetHandle = null;
          return afterSignIn(res && res.data);
        })
        .catch(function (err) {
          msg(box, errText(err), true);
        })
        .then(function () {
          btn.disabled = false;
        });
    }));
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
    bindTabs();
    bindLogin();
    bindSignup();
    bindReset();
    bindNick();
    bindLogout();
    setLoginMode('password');

    refresh().catch(function (err) {
      showAuth();
      msg(el('login-msg'), errText(err), true);
    });

    // 界面默认 hidden，靠 JS 显示。启动逻辑一旦中断就是一片空白，
    // 所以留个看门狗兜底。
    window.setTimeout(function () {
      if (decided) return;
      showAuth();
      msg(el('login-msg'), '页面没能正常启动，刷新一次再试。', true);
    }, 6000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
