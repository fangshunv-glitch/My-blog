/*!
 * 像素日常 · 站长管理后台
 * ============================
 * 给站长一个人用的后台：邮箱登录后，管理留言板和文章评论
 * （回复 / 隐藏 / 删除）。
 *
 * 三条边界，写在最前面：
 *   1. 访客看博客**永远不需要登录**。这个页面对浏览毫无影响，
 *      它只是站长的后台入口。
 *   2. 前端不做权限判断。所有权限由数据库的行级安全策略裁决——
 *      就算有人绕过界面直接调接口，非管理员一样改不动任何数据。
 *   3. 登录方式只做邮箱。Web 应用不支持手机号/微信登录，这是平台边界，
 *      不是没做。
 *
 * 依赖：cloud-config.js → WorkBuddy Cloud SDK → 本文件，顺序不能变。
 */
(function () {
  'use strict';

  var CONFIG = window.PIXEL_CLOUD_CONFIG || {};
  var LIMIT = 200;
  var NAME_MAX = 24;
  var TEXT_MAX = 800;

  var D = window.SITE_DATA || {};
  var POSTS = D.posts || {};

  // -------------------------------------------------------------------------
  // SDK：auth 与 database 共用同一个实例
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
  function auth() { return sdk().auth; }

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function show(node, on) {
    if (node) node.hidden = !on;
  }

  // 拆 { data, error } 信封
  function run(q) {
    return Promise.resolve(q).then(function (res) {
      if (res && res.error) throw res.error;
      return res && res.data ? res.data : [];
    });
  }

  // -------------------------------------------------------------------------
  // 时间 / 提示
  // -------------------------------------------------------------------------
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(v) {
    var d = new Date(v);
    if (!v || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function msg(box, text, isError) {
    if (!box) return;
    box.textContent = text || '';
    box.className = 'form-msg ' + (text ? (isError ? 'is-error' : 'is-ok') : '');
  }

  // 事件处理器的安全壳。
  // 处理器里任何一处同步抛错（比如取到 null 去读 .value），浏览器只会往控制台
  // 丢一行红字，页面上「点了没反应」——用户完全无从判断是坏了还是没生效。
  // 套一层之后，异常会变成一句看得见的中文提示。
  function guard(msgId, fn) {
    return function (e) {
      try {
        return fn.call(this, e);
      } catch (err) {
        if (window.console && console.error) {
          console.error('[像素日常后台]', err);
        }
        msg(el(msgId), '页面出错了：' + ((err && err.message) || err)
          + '。刷新页面再试，或把这句话发给站长助手。', true);
        return undefined;
      }
    };
  }

  // RPC 返回值形状不稳定（标量 / 单元素数组 / 包一层对象），统一成字符串
  function asStatus(data) {
    var v = data;
    if (Array.isArray(v)) v = v.length ? v[0] : '';
    if (v && typeof v === 'object') {
      var k = Object.keys(v)[0];
      if (k) v = v[k];
    }
    return String(v == null ? '' : v).trim();
  }

  // 按 error.kind 分支，不看 message 文案
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
      case '42501': return '没有权限做这个操作。';
      case '23505': return '这条已经存在了。';
      case '23514': return '内容不符合要求（长度或状态不合法）。';
      case '42P01': return '云端还没准备好，请稍后再试。';
      default: break;
    }
    if (err.message && /fetch|network|Failed/i.test(err.message)) {
      return '连不上云端——检查网络后重试。';
    }
    return '操作没成功：' + (err.message || '未知错误');
  }

  // -------------------------------------------------------------------------
  // 会话与身份
  // -------------------------------------------------------------------------
  var ME = { uid: '', email: '', isAdmin: false, claimed: false };

  function pickUid(u) {
    if (!u) return '';
    return u.id || u.uid || u.sub || u.userId || '';
  }

  function pickEmail(u) {
    if (!u) return '';
    return u.email || (u.user_metadata && u.user_metadata.email) || '';
  }

  // 兜底：不同版本 SDK 的 user 对象字段名不完全一致。
  // 万一对不上，直接从 access_token 的 payload 里读 sub —— JWT 里一定有它。
  function uidFromToken(token) {
    var parts = String(token || '').split('.');
    if (parts.length < 2) return '';
    try {
      var base = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base.length % 4) base += '=';
      var bin = atob(base);
      var json = decodeURIComponent(bin.split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      var p = JSON.parse(json);
      return p.sub || p.uid || p.user_id || '';
    } catch (e) {
      return '';
    }
  }

  function withUid(user, uid) {
    if (pickUid(user) || !uid) return user;
    var u = {}, k;
    for (k in user) {
      if (Object.prototype.hasOwnProperty.call(user, k)) u[k] = user[k];
    }
    u.id = uid;
    return u;
  }

  // -------------------------------------------------------------------------
  // 界面切换
  // -------------------------------------------------------------------------
  var decided = false;   // 是否已经决定了显示登录区还是后台区

  function showAuth() {
    decided = true;
    show(el('auth-view'), true);
    show(el('panel-view'), false);
    document.body.setAttribute('data-stage', 'auth');
  }

  function showPanel() {
    decided = true;
    show(el('auth-view'), false);
    show(el('panel-view'), true);
    document.body.setAttribute('data-stage', 'panel');
    var em = el('account-email');
    if (em) em.textContent = ME.email || '（未取到邮箱）';
    var uidBox = el('account-uid');
    if (uidBox) uidBox.textContent = ME.uid || '云端不下发，不影响使用';
    show(el('claim-card'), !ME.isAdmin);
    show(el('admin-panel'), ME.isAdmin);
    if (ME.isAdmin) switchPanel(currentKind || 'guestbook');
  }

  // 判断「我是不是站长」：site_admins 的行级策略只放行自己那一行，
  // 所以能查到行 == 我是管理员。不用前端比对任何 uid。
  function loadIdentity(user) {
    ME.uid = pickUid(user);
    ME.email = pickEmail(user);
    return run(db().from('site_admins').select('uid, email')).then(function (rows) {
      ME.isAdmin = !!(rows && rows.length);
      return ME.isAdmin;
    }, function () {
      ME.isAdmin = false;
      return false;
    });
  }

  // -------------------------------------------------------------------------
  // 认证：登录 / 注册 / 找回密码
  // -------------------------------------------------------------------------
  var pending = null;   // { email, verificationId, isExistingUser }

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

  // 「获取验证码」——只负责发送，不参与校验
  function bindSendCode(btnId, mailId, msgId) {
    var btn = el(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
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
    });
  }

  // 校验验证码：只用保存下来的那一次，绝不重发
  //
  // 注意 codeInputId 必须显式传进来。这里原先靠 msgId 反推
  // （msgId.replace('-msg', '-code')），但登录的提示框叫 login-code-msg，
  // 反推出来是 login-code-code —— 根本不存在，取 .value 当场抛异常，
  // 于是「验证码登录」按钮点了没有任何反应。登录和留言板用了两套 ID 命名，
  // 反推这种事迟早出错，直接传参最稳。
  function verify(mailInputId, codeInputId, msgId, password) {
    var email = (el(mailInputId).value || '').trim();
    var box = el(msgId);
    if (!pending || pending.email !== email) {
      msg(box, '先点「获取验证码」，拿当前邮箱的验证码。', true);
      return Promise.reject(new Error('NO_PENDING'));
    }
    var codeEl = el(codeInputId);
    var token = codeEl ? (codeEl.value || '').trim() : '';
    if (!codeEl) {
      msg(box, '页面元素丢了（找不到验证码输入框），刷新页面再来。', true);
      return Promise.reject(new Error('NO_TOKEN_FIELD'));
    }
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

  // 顶部三个标签页（登录 / 注册 / 忘记密码）的切换。
  // keepPending = true 用于「注册时发现邮箱已有账号，自动带去登录」这种程序内跳转：
  // 刚发出去的那次验证码还要接着用，不能清掉。
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

  // 登录区两种方式：密码 / 邮箱验证码
  function setLoginMode(mode) {
    var byCode = mode === 'code';
    document.body.setAttribute('data-login-mode', byCode ? 'code' : 'password');
    var toggle = el('login-mode-toggle');
    if (toggle) toggle.textContent = byCode ? '改用密码登录' : '改用邮箱验证码登录';
    // 整块切换，而不是只藏表单里的某个按钮。
    // 之前只藏提交按钮，靠的是 hidden 属性；而 .btn 自带 display:inline-block，
    // 把浏览器的 [hidden] 盖掉了，于是验证码模式下页面同时出现两个「登录」按钮。
    show(el('login-form'), !byCode);
    show(el('login-code-form'), byCode);
    msg(el('login-msg'), '', false);
    msg(el('login-code-msg'), '', false);
  }

  // 注册页发现邮箱已有账号 → 带着邮箱和刚收到的验证码切到登录页，
  // 用同一个挑战直接登录。提示语保持中性，不透露「这个邮箱注册过没有」。
  function handoffToLogin(email) {
    var code = (el('signup-code').value || '').trim();
    switchTab('login', true);          // 保留 pending，同一份挑战接着用
    el('login-email').value = email;
    if (code) el('login-code').value = code;
    setLoginMode('code');
    msg(el('login-code-msg'),
      '这个邮箱可以直接登录。验证码已经带过来了，点「登录」即可。', false);
  }

  // --- 登录（密码 / 验证码） ---
  function bindLogin() {
    var form = el('login-form');
    if (!form) return;

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

    // 密码 / 验证码 两种登录方式切换
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

  // --- 注册（邮箱验证码 + 密码） ---
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
      // 这个邮箱已经有账号了。直接把「已有账号」说出口等于账号探测，
      // 所以不点破，改成带着邮箱和验证码切到登录页继续。
      if (pending.isExistingUser) {
        handoffToLogin(email);
        return;
      }
      if (!pwd || pwd.length < 6) {
        return msg(box, '密码至少 6 位。', true);
      }
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

  // --- 找回密码 ---
  //
  // 这里的验证码必须由 resetPasswordForEmail 发出：它会返回一个句柄，
  // 重设时要用这个句柄带上 nonce 去 updateUser。
  // 原先接的是登录用的 sendOtp，发出来的是另一种用途的凭据，
  // 和 updateUser 要的 nonce 对不上，重设必然失败。
  var resetHandle = null;

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
          msg(box, '密码已重设，正在进入后台…', false);
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

  // 登录成功后统一入口
  function afterSignIn(data) {
    var session = (data && data.session) || data || null;
    var user = (data && data.user) || (session && session.user) || null;
    if (!user) {
      // 少数情况只回 session，重新拉一次更稳
      return auth().getUser().then(function (res) {
        user = (res && res.data && (res.data.user || res.data)) || null;
        return settle(user, session);
      });
    }
    return settle(user, session);
  }

  function settle(user, session) {
    // UID 取不到就从 token 里兜底，否则认领会卡住
    if (!pickUid(user) && session && session.access_token) {
      user = withUid(user, uidFromToken(session.access_token));
    }
    return loadIdentity(user).then(function () {
      showPanel();
    });
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

  // --- 认领站长 ---
  //
  // 认领走数据库函数 pixel_claim_admin()，不再从前端拼一条 insert。
  //
  // 原因：直接插入的话，uid 必须正好等于服务端认定的 auth.uid()，而行级策略
  // 就是拿它比对的。前端只能从 SDK 返回的 user 对象或 JWT 里「猜」这个 uid，
  // 猜错就被策略静默挡掉——用户看到的就是「点了认领没反应」。
  // 这个环境里 SDK 返回的用户对象恰好就没有可用的 id，所以必然会错。
  // 交给函数之后，uid 由数据库自己用 auth.uid() 填，前端根本不需要知道它是什么。
  function bindClaim() {
    var btn = el('claim-btn');
    if (!btn) return;
    var box = el('claim-msg');
    btn.addEventListener('click', guard('claim-msg', function () {
      btn.disabled = true;
      msg(box, '正在认领…', false);
      run(db().rpc('pixel_claim_admin', { p_email: ME.email || '' }))
        .then(function (data) {
          var status = asStatus(data);

          if (status === 'ok' || status === 'already') {
            return loadIdentity({ id: ME.uid, email: ME.email }).then(function () {
              if (ME.isAdmin) {
                msg(box, '认领成功，正在进入后台…', false);
                showPanel();
              } else {
                msg(box, '数据库已经记下了，但权限没回读到。刷新一次页面就行。', true);
              }
            });
          }
          if (status === 'taken') {
            return msg(box, '这台博客已经有站长了，而且不是你当前登录的这个账号。', true);
          }
          if (status === 'no-auth') {
            return msg(box, '云端没认出你的登录状态（auth.uid() 是空的）。'
              + '先退出登录，用「邮箱 + 密码」重新登录一次，再来认领。', true);
          }
          msg(box, '认领返回了意外的结果：' + (status || '(空值)'), true);
        })
        .catch(function (err) {
          msg(box, errText(err), true);
        })
        .then(function () {
          btn.disabled = false;
        });
    }));
  }

  // -------------------------------------------------------------------------
  // 管理面板：留言板 / 文章评论
  // -------------------------------------------------------------------------
  var currentKind = 'guestbook';

  var TABLES = {
    guestbook: {
      table: 'guestbook',
      cols: 'id, name, content, status, reply, created_at',
      empty: '留言板还是空的。',
      label: '条留言'
    },
    comments: {
      table: 'post_comments',
      cols: 'id, post_slug, name, content, status, reply, created_at',
      empty: '还没有任何文章评论。',
      label: '条评论'
    }
  };

  function itemHTML(kind, row) {
    var from = '';
    if (kind === 'comments') {
      var meta = POST_MAP[row.post_slug] || POSTS[row.post_slug];
      var t = meta ? meta.title : row.post_slug;
      from = '<div class="adm-from">来自《'
        + (meta ? '<a href="' + esc(meta.url) + '">' + esc(t) + '</a>' : esc(t))
        + '》</div>';
    }
    var hidden = row.status !== 'published';
    return '<div class="adm-item' + (hidden ? ' is-hidden' : '') + '" data-id="' + esc(row.id) + '">'
      + '<div class="adm-head">'
      + '<span class="adm-name">' + esc(row.name) + '</span>'
      + (hidden ? '<span class="adm-badge">已隐藏</span>' : '')
      + '<span class="adm-time">' + esc(fmtTime(row.created_at)) + '</span>'
      + '</div>'
      + from
      + '<div class="adm-text">' + esc(row.content) + '</div>'
      + (row.reply ? '<div class="adm-reply-view">站长回复：' + esc(row.reply) + '</div>' : '')
      + '<div class="adm-tools">'
      + '<button type="button" class="btn-mini" data-act="reply">'
      + (row.reply ? '改回复' : '回复') + '</button>'
      + '<button type="button" class="btn-mini" data-act="toggle">'
      + (hidden ? '恢复显示' : '隐藏') + '</button>'
      + '<button type="button" class="btn-mini btn-danger" data-act="del">删除</button>'
      + '</div>'
      + '<div class="adm-reply-box" hidden>'
      + '<textarea maxlength="' + TEXT_MAX + '" placeholder="回复给 ' + esc(row.name) + '…"></textarea>'
      + '<div class="adm-reply-actions">'
      + '<button type="button" class="btn-mini" data-act="save">保存回复</button>'
      + '<button type="button" class="btn-mini" data-act="cancel">取消</button>'
      + '</div>'
      + '</div>'
      + '</div>';
  }

  function loadItems(kind) {
    var cfg = TABLES[kind] || TABLES.guestbook;
    var box = el('admin-list');
    var msgBox = el('admin-msg');
    if (!box) return Promise.resolve();

    var q = db().from(cfg.table).select(cfg.cols).order('created_at', { ascending: false }).limit(LIMIT);

    return run(q).then(function (rows) {
      rows = rows || [];
      var hidden = rows.filter(function (r) { return r.status !== 'published'; }).length;
      box.innerHTML = rows.length
        ? rows.map(function (r) { return itemHTML(kind, r); }).join('')
        : '<div class="empty-tip">' + esc(cfg.empty) + '</div>';
      var c = el('admin-count');
      if (c) {
        c.textContent = '共 ' + rows.length + ' ' + cfg.label
          + (hidden ? '（其中 ' + hidden + ' 条已隐藏，访客看不到）' : '');
      }
      msg(msgBox, '', false);
    }, function (err) {
      msg(msgBox, errText(err), true);
    });
  }

  function bindAdminList() {
    var box = el('admin-list');
    if (!box) return;

    box.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var item = btn.closest('.adm-item');
      if (!item) return;
      var id = item.getAttribute('data-id');
      var act = btn.getAttribute('data-act');
      var cfg = TABLES[currentKind] || TABLES.guestbook;
      var replyBox = item.querySelector('.adm-reply-box');
      var ta = item.querySelector('textarea');
      var msgBox = el('admin-msg');

      function doUpdate(patch, okText) {
        btn.disabled = true;
        return run(db().from(cfg.table).update(patch).eq('id', id))
          .then(function () {
            return loadItems(currentKind);
          })
          .then(function () {
            msg(msgBox, okText, false);
          })
          .catch(function (err) {
            msg(msgBox, errText(err), true);
          })
          .then(function () {
            btn.disabled = false;
          });
      }

      if (act === 'reply') {
        if (replyBox) {
          replyBox.hidden = false;
          if (ta) {
            ta.value = item.querySelector('.adm-reply-view')
              ? item.querySelector('.adm-reply-view').textContent.replace(/^站长回复：/, '')
              : '';
            ta.focus();
          }
        }
        return;
      }

      if (act === 'cancel') {
        if (replyBox) replyBox.hidden = true;
        return;
      }

      if (act === 'save') {
        var text = (ta.value || '').trim();
        if (text.length > TEXT_MAX) {
          return msg(msgBox, '回复太长了，最多 ' + TEXT_MAX + ' 个字。', true);
        }
        return doUpdate({ reply: text || null }, text ? '回复已保存。' : '回复已清空。');
      }

      if (act === 'toggle') {
        var nowHidden = item.classList.contains('is-hidden');
        return doUpdate(
          { status: nowHidden ? 'published' : 'hidden' },
          nowHidden ? '已恢复显示。' : '已隐藏，访客看不到了。'
        );
      }

      if (act === 'del') {
        if (!window.confirm('确定删除这条吗？删了就找不回来了。')) return;
        btn.disabled = true;
        return run(db().from(cfg.table).delete().eq('id', id))
          .then(function () { return loadItems(currentKind); })
          .then(function () { msg(msgBox, '已删除。', false); })
          .catch(function (err) { msg(msgBox, errText(err), true); })
          .then(function () { btn.disabled = false; });
      }
    });

    var tabs = document.querySelectorAll('[data-panel]');
    Array.prototype.forEach.call(tabs, function (t) {
      t.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs, function (x) {
          x.classList.toggle('active', x === t);
        });
        switchPanel(t.getAttribute('data-panel'));
      });
    });
  }

  // 三个 tab 之间的切换
  function switchPanel(kind) {
    currentKind = kind;
    var isPrivate = kind === 'private';
    var isPosts = kind === 'posts';
    var isPhotos = kind === 'photos';
    var isFeed = !isPrivate && !isPosts && !isPhotos;   // 留言板 / 文章评论共用一块列表

    show(el('admin-list'), isFeed);
    show(el('admin-count'), isFeed);
    show(el('private-pane'), isPrivate);
    show(el('posts-pane'), isPosts);
    show(el('photos-pane'), isPhotos);

    if (isPrivate) {
      loadPrivate();
    } else if (isPosts) {
      loadPosts();
    } else if (isPhotos) {
      loadPhotos();
    } else {
      loadItems(kind);
    }
  }

  // -------------------------------------------------------------------------
  // 文章：写、改、删，以及发布时选可见范围
  // -------------------------------------------------------------------------
  var edPostId = null;
  var POST_ROWS = [];
  var POST_MAP = {};        // slug → { title, url }，评论列表要用来显示「来自《…》」

  var VIS_LABEL = {
    public: '公开', unlisted: '有链接可见', private: '仅自己可见', draft: '草稿'
  };
  var VIS_CLASS = {
    public: 'vb-public', unlisted: 'vb-unlisted', private: 'vb-private', draft: 'vb-draft'
  };

  function postRowHTML(row) {
    var vis = row.visibility || 'draft';
    return '<div class="adm-item" data-id="' + esc(row.id) + '">'
      + '<div class="adm-head">'
      + '<span class="adm-name">' + esc(row.title) + '</span>'
      + '<span class="adm-badge ' + (VIS_CLASS[vis] || '') + '">' + esc(VIS_LABEL[vis] || vis) + '</span>'
      + (row.featured ? '<span class="adm-badge">置顶</span>' : '')
      + '<span class="adm-time">' + esc(String(row.published_on || '').slice(0, 10)) + '</span>'
      + '</div>'
      + '<div class="adm-from">' + esc(row.slug) + ' · ' + esc(row.category || '未分类')
      + ' · ' + String(row.body || '').length + ' 字</div>'
      + '<div class="adm-text">' + esc(row.excerpt || String(row.body || '').slice(0, 60)) + '</div>'
      + '<div class="adm-tools">'
      + '<a class="btn-mini" href="post.html?slug=' + encodeURIComponent(row.slug)
      + '" target="_blank" rel="noopener">看页面</a>'
      + '<button type="button" class="btn-mini" data-act="edit">编辑</button>'
      + '<button type="button" class="btn-mini btn-danger" data-act="del">删除</button>'
      + '</div></div>';
  }

  function loadPostMap() {
    return run(db().from('posts').select('id,slug,title,category,visibility,published_on'))
      .then(function (rows) {
        (rows || []).forEach(function (r) {
          POST_MAP[r.slug] = { title: r.title, url: 'post.html?slug=' + r.slug };
        });
      }, function () { /* 拿不到就算了，评论列表退回显示 slug */ });
  }

  // 相册里「挂到哪篇文章下」的下拉
  function fillPostSelect(rows) {
    var sel = el('ph-post');
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">不挂，只放相册</option>' + (rows || []).map(function (r) {
      return '<option value="' + esc(r.slug) + '">' + esc(r.title) + '</option>';
    }).join('');
    sel.value = cur || '';
  }

  function loadPosts() {
    var box = el('po-list');
    if (!box) return Promise.resolve();
    return run(db().from('posts')
      .select('id,slug,title,excerpt,body,category,tags,visibility,featured,published_on,created_at,updated_at')
      .order('published_on', { ascending: false })
      .order('id', { ascending: false })
      .limit(LIMIT)
    ).then(function (rows) {
      POST_ROWS = rows || [];
      POST_MAP = {};
      POST_ROWS.forEach(function (r) {
        POST_MAP[r.slug] = { title: r.title, url: 'post.html?slug=' + r.slug };
      });
      box.innerHTML = POST_ROWS.length
        ? POST_ROWS.map(postRowHTML).join('')
        : '<div class="empty-tip">还没有文章。上面写第一篇吧。</div>';
      fillPostSelect(POST_ROWS);
      var c = el('admin-count');
      if (c && currentKind === 'posts') c.textContent = '共 ' + POST_ROWS.length + ' 篇';
    }, function (err) {
      msg(el('po-msg'), errText(err), true);
    });
  }

  function makeSlug() {
    var d = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var rnd = Math.random().toString(36).slice(2, 6);
    return 'post-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + rnd;
  }

  function todayStr() {
    var d = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  function resetPostForm() {
    edPostId = null;
    el('po-title').value = '';
    el('po-slug').value = makeSlug();
    el('po-tags').value = '';
    el('po-excerpt').value = '';
    el('po-body').value = '';
    el('po-date').value = todayStr();
    el('po-featured').checked = false;
    el('po-vis').value = 'draft';     // 默认草稿：先写，想好了再公开
    show(el('po-cancel'), false);
    el('po-save').textContent = '发布';
  }

  function bindPosts() {
    var saveBtn = el('po-save');
    var list = el('po-list');
    if (!saveBtn || !list) return;
    var msgBox = el('po-msg');

    resetPostForm();

    // 标题写完，别名还空着就顺手生成一个
    el('po-title').addEventListener('blur', function () {
      if (!(el('po-slug').value || '').trim()) el('po-slug').value = makeSlug();
    });

    saveBtn.addEventListener('click', function () {
      var title = (el('po-title').value || '').trim();
      var slug = (el('po-slug').value || '').trim().toLowerCase();
      var body = el('po-body').value || '';
      var vis = el('po-vis').value || 'draft';
      var date = el('po-date').value || todayStr();

      if (!title) { el('po-title').focus(); return msg(msgBox, '标题还没填。', true); }
      if (title.length > 120) return msg(msgBox, '标题太长了，最多 120 个字。', true);
      if (!slug) { el('po-slug').focus(); return msg(msgBox, '链接别名不能空着。', true); }
      if (!/^[a-z0-9][a-z0-9-]{0,78}$/.test(slug)) {
        el('po-slug').focus();
        return msg(msgBox, '别名只能用小写字母、数字和连字符，且以字母或数字开头。', true);
      }
      if (!body.trim()) { el('po-body').focus(); return msg(msgBox, '正文还是空的。', true); }

      var payload = {
        title: title,
        slug: slug,
        excerpt: (el('po-excerpt').value || '').trim(),
        body: body,
        category: el('po-cat').value || '日常',
        tags: (el('po-tags').value || '').trim(),
        visibility: vis,
        featured: !!el('po-featured').checked,
        published_on: date
      };
      if (edPostId) payload.updated_at = new Date().toISOString();

      saveBtn.disabled = true;
      msg(msgBox, '正在保存…', false);

      var q = edPostId
        ? db().from('posts').update(payload).eq('id', edPostId)
        : db().from('posts').insert(payload);

      run(q.select()).then(function (rows) {
        if (!rows || !rows.length) {
          throw new Error('没保存成功 —— 可能这个别名已经被别的文章占用了。');
        }
        resetPostForm();
        return loadPosts();
      }).then(function () {
        msg(msgBox, edPostId ? '已更新。' : ('已保存，可见范围：' + (VIS_LABEL[vis] || vis) + '。'), false);
      }).catch(function (err) {
        var text = errText(err);
        if (String(err && err.code) === '23505' || /duplicate|unique/i.test(text)) {
          text = '这个链接别名已经被占用了，换一个。';
        }
        msg(msgBox, text, true);
      }).then(function () { saveBtn.disabled = false; });
    });

    el('po-cancel').addEventListener('click', function () {
      resetPostForm();
      msg(msgBox, '已取消编辑。', false);
    });

    list.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var item = btn.closest('.adm-item');
      if (!item) return;
      var id = item.getAttribute('data-id');
      var act = btn.getAttribute('data-act');
      var row = null;
      for (var i = 0; i < POST_ROWS.length; i++) {
        if (String(POST_ROWS[i].id) === String(id)) { row = POST_ROWS[i]; break; }
      }
      if (!row) return;

      if (act === 'edit') {
        edPostId = row.id;
        el('po-title').value = row.title || '';
        el('po-slug').value = row.slug || '';
        el('po-body').value = row.body || '';
        el('po-excerpt').value = row.excerpt || '';
        el('po-cat').value = row.category || '日常';
        el('po-tags').value = row.tags || '';
        el('po-vis').value = row.visibility || 'draft';
        el('po-date').value = String(row.published_on || '').slice(0, 10) || todayStr();
        el('po-featured').checked = !!row.featured;
        show(el('po-cancel'), true);
        saveBtn.textContent = '更新';
        msg(msgBox, '正在改《' + row.title + '》，改完点「更新」。', false);
        if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      if (act === 'del') {
        if (!window.confirm('删除《' + row.title + '》？删了就找不回来了。\n'
                            + '只是暂时不想让人看的话，把可见范围改成「仅自己可见」或「草稿」更合适。')) return;
        btn.disabled = true;
        run(db().from('posts').delete().eq('id', id).select()).then(function (rows) {
          if (!rows || !rows.length) throw new Error('没删掉，可能这条已经不在你名下了。');
          if (String(edPostId) === String(id)) resetPostForm();
          return loadPosts();
        }).then(function () {
          msg(msgBox, '已删除。', false);
        }).catch(function (err) {
          msg(msgBox, errText(err), true);
        }).then(function () { btn.disabled = false; });
      }
    });
  }

  // -------------------------------------------------------------------------
  // 相册：在本机压好再传
  // -------------------------------------------------------------------------
  function shrink(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        try {
          resolve({ data: cv.toDataURL('image/jpeg', quality), width: img.width, height: img.height });
        } catch (e) {
          reject(new Error('压缩失败'));
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这张图读不出来（格式可能不被浏览器支持）'));
      };
      img.src = url;
    });
  }

  function photoRowHTML(row) {
    var vis = row.visibility || 'private';
    return '<div class="adm-item" data-id="' + esc(row.id) + '">'
      + '<div class="adm-head">'
      + '<span class="adm-name">' + esc(row.caption || '（没有说明）') + '</span>'
      + '<span class="adm-badge ' + (VIS_CLASS[vis] || '') + '">' + esc(VIS_LABEL[vis] || vis) + '</span>'
      + '<span class="adm-time">' + esc(String(row.taken_on || '').slice(0, 10)) + '</span>'
      + '</div>'
      + '<div class="adm-photo-row">'
      + '<img class="adm-thumb" src="' + esc(row.thumb_data) + '" alt="">'
      + '<div class="adm-from">'
      + (row.album ? '相册：' + esc(row.album) + '<br>' : '')
      + (row.post_slug ? '挂在《' + esc((POST_MAP[row.post_slug] || {}).title || row.post_slug) + '》下' : '只在相册里')
      + '</div></div>'
      + '<div class="adm-tools">'
      + '<button type="button" class="btn-mini btn-danger" data-act="del">删除</button>'
      + '</div></div>';
  }

  function loadPhotos() {
    var box = el('ph-list');
    if (!box) return Promise.resolve();
    return run(db().from('photos')
      .select('id,caption,album,post_slug,taken_on,visibility,thumb_data,created_at')
      .order('taken_on', { ascending: false })
      .order('id', { ascending: false })
      .limit(LIMIT)
    ).then(function (rows) {
      rows = rows || [];
      box.innerHTML = rows.length
        ? rows.map(photoRowHTML).join('')
        : '<div class="empty-tip">相册还是空的。上面传第一张吧。</div>';
      var c = el('admin-count');
      if (c && currentKind === 'photos') c.textContent = '共 ' + rows.length + ' 张照片';
    }, function (err) {
      msg(el('ph-msg'), errText(err), true);
    });
  }

  function bindPhotos() {
    var btn = el('ph-save');
    var list = el('ph-list');
    if (!btn || !list) return;
    var msgBox = el('ph-msg');

    if (el('ph-date') && !el('ph-date').value) el('ph-date').value = todayStr();

    btn.addEventListener('click', function () {
      var input = el('ph-file');
      var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
      if (!files.length) return msg(msgBox, '先选几张照片。', true);

      var caption = (el('ph-caption').value || '').trim();
      var album = (el('ph-album').value || '').trim();
      var taken = el('ph-date').value || '';
      var slug = el('ph-post').value || '';
      var vis = el('ph-vis').value || 'private';

      btn.disabled = true;
      var done = 0, failed = [];
      msg(msgBox, '正在处理 ' + files.length + ' 张…（第一张会慢一点）', false);

      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          return Promise.all([shrink(f, 1280, 0.78), shrink(f, 360, 0.7)])
            .then(function (r) {
              var big = r[0], small = r[1];
              return run(db().from('photos').insert({
                caption: caption,
                album: album,
                taken_on: taken || null,
                post_slug: slug,
                visibility: vis,
                thumb_data: small.data,
                image_data: big.data,
                width: big.width,
                height: big.height
              }));
            })
            .then(function () {
              done++;
              msg(msgBox, '已传 ' + done + ' / ' + files.length + ' 张…', false);
            }, function (err) {
              failed.push(f.name + '（' + errText(err) + '）');
            });
        });
      });

      chain.then(function () {
        input.value = '';
        el('ph-caption').value = '';
        return loadPhotos();
      }).then(function () {
        if (failed.length) {
          msg(msgBox, '传上去 ' + done + ' 张，' + failed.length + ' 张没成功：'
              + failed.join('；'), true);
        } else {
          msg(msgBox, '上传完成，共 ' + done + ' 张。相册页刷新一下就能看到。', false);
        }
      }).then(function () {
        btn.disabled = false;
      });
    });

    list.addEventListener('click', function (e) {
      var del = e.target.closest('button[data-act="del"]');
      if (!del) return;
      var item = del.closest('.adm-item');
      if (!item) return;
      if (!window.confirm('删除这张照片？删了就找不回来了。')) return;
      del.disabled = true;
      var id = item.getAttribute('data-id');
      run(db().from('photos').delete().eq('id', id).select()).then(function (rows) {
        if (!rows || !rows.length) throw new Error('没删掉，可能这张已经不在你名下了。');
        return loadPhotos();
      }).then(function () {
        msg(msgBox, '已删除。', false);
      }).catch(function (err) {
        msg(msgBox, errText(err), true);
      }).then(function () { del.disabled = false; });
    });
  }

  // -------------------------------------------------------------------------
  // 私密内容：只有站长能读写（数据库层面就拦住了访客）
  // -------------------------------------------------------------------------
  var editingId = null;

  function privateItemHTML(row) {
    return '<div class="adm-item" data-id="' + esc(row.id) + '">'
      + '<div class="adm-head">'
      + '<span class="adm-name">' + esc(row.title) + '</span>'
      + '<span class="adm-time">' + esc(fmtTime(row.updated_at || row.created_at)) + '</span>'
      + '</div>'
      + '<div class="adm-private-body">' + esc(row.body) + '</div>'
      + '<div class="adm-tools">'
      + '<button type="button" class="btn-mini" data-act="edit">编辑</button>'
      + '<button type="button" class="btn-mini btn-danger" data-act="del">删除</button>'
      + '</div>'
      + '</div>';
  }

  function loadPrivate() {
    var box = el('pv-list');
    if (!box) return Promise.resolve();
    return run(db().from('private_posts')
      .select('id, title, body, created_at, updated_at')
      .order('updated_at', { ascending: false }).limit(LIMIT)
    ).then(function (rows) {
      rows = rows || [];
      box.innerHTML = rows.length
        ? rows.map(privateItemHTML).join('')
        : '<div class="empty-tip">还没有私密内容。上面写一条试试。</div>';
      var c = el('admin-count');
      if (c) c.textContent = '共 ' + rows.length + ' 条私密内容（只有你能看到）';
    }, function (err) {
      msg(el('pv-msg'), errText(err), true);
    });
  }

  function bindPrivate() {
    var saveBtn = el('pv-save');
    var cancelBtn = el('pv-cancel');
    var list = el('pv-list');
    if (!saveBtn || !list) return;

    function resetForm() {
      editingId = null;
      el('pv-title').value = '';
      el('pv-body').value = '';
      show(cancelBtn, false);
      saveBtn.textContent = '保存';
    }

    saveBtn.addEventListener('click', function () {
      var title = (el('pv-title').value || '').trim();
      var body = (el('pv-body').value || '').trim();
      var box = el('pv-msg');
      if (!title) { el('pv-title').focus(); return msg(box, '标题还没填。', true); }
      if (title.length > 80) return msg(box, '标题太长了，最多 80 个字。', true);
      if (!body) { el('pv-body').focus(); return msg(box, '正文还是空的。', true); }
      if (body.length > 8000) return msg(box, '正文太长了，最多 8000 个字。', true);

      saveBtn.disabled = true;
      msg(box, '正在保存…', false);

      var q;
      if (editingId) {
        q = db().from('private_posts')
          .update({ title: title, body: body, updated_at: new Date().toISOString() })
          .eq('id', editingId);
      } else {
        q = db().from('private_posts').insert({ title: title, body: body });
      }

      run(q).then(function () {
        resetForm();
        return loadPrivate();
      }).then(function () {
        msg(box, '已保存，只有你能看到。', false);
      }).catch(function (err) {
        msg(box, errText(err), true);
      }).then(function () {
        saveBtn.disabled = false;
      });
    });

    cancelBtn.addEventListener('click', function () {
      resetForm();
      msg(el('pv-msg'), '已取消编辑。', false);
    });

    list.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var item = btn.closest('.adm-item');
      if (!item) return;
      var id = item.getAttribute('data-id');
      var act = btn.getAttribute('data-act');
      var box = el('pv-msg');

      if (act === 'edit') {
        el('pv-title').value = item.querySelector('.adm-name').textContent;
        el('pv-body').value = item.querySelector('.adm-private-body').textContent;
        editingId = id;
        show(cancelBtn, true);
        saveBtn.textContent = '更新';
        msg(box, '正在编辑已有内容，改完点「更新」。', false);
        if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
        el('pv-title').focus();
        return;
      }

      if (act === 'del') {
        if (!window.confirm('确定删除吗？删了就找不回来了。')) return;
        btn.disabled = true;
        run(db().from('private_posts').delete().eq('id', id))
          .then(function () {
            if (editingId === id) resetForm();
            return loadPrivate();
          })
          .then(function () { msg(box, '已删除。', false); })
          .catch(function (err) { msg(box, errText(err), true); })
          .then(function () { btn.disabled = false; });
      }
    });
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function boot() {
    bindLogin();
    bindSignup();
    bindReset();
    bindLogout();
    bindClaim();
    bindAdminList();
    bindPrivate();
    bindPosts();
    bindPhotos();
    loadPostMap();

    var tabs = document.querySelectorAll('[data-tab]');
    Array.prototype.forEach.call(tabs, function (t) {
      t.addEventListener('click', guard('login-msg', function (e) {
        e.preventDefault();
        switchTab(t.getAttribute('data-tab'), false);
      }));
    });

    // 默认停在密码登录。
    // 验证码方式要多一次收信、多一个失败点，不该是进门的第一道关。
    setLoginMode('password');

    // 先从会话恢复：已经有登录态就直接进面板。
    // auth() 在 SDK 没加载成功时会「同步」抛错，而这一句在 Promise 链之外——
    // 不接住的话 boot() 会当场中断，#auth-view 又默认 hidden，
    // 结果整个后台一片空白，连登录框都不出现，也看不到任何原因。
    var client;
    try {
      client = auth();
    } catch (err) {
      showAuth();
      msg(el('login-msg'), errText(err), true);
      return;
    }

    client.getSession().then(function (res) {
      var session = res && res.data;
      if (res && res.error) throw res.error;
      if (!session) {
        showAuth();
        return null;
      }
      return auth().getUser().then(function (r) {
        var user = (r && r.data && (r.data.user || r.data)) || (session.user || null);
        return settle(user, session);
      }, function () {
        return settle(session.user || null, session);
      });
    }).catch(function (err) {
      showAuth();
      if (err && err.message === 'SDK_MISSING') {
        msg(el('login-msg'), errText(err), true);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 启动看门狗：正常流程走完一定会显示登录区或后台区之一。
  // 如果过了这么久两个都还藏着，说明出了意料之外的岔子——
  // 那就至少把登录界面亮出来并说明缘由，而不是留一片空白让人猜。
  window.setTimeout(function () {
    if (decided) return;
    showAuth();
    msg(el('login-msg'), '页面没能正常启动，刷新一次再试。', true);
  }, 6000);
})();
