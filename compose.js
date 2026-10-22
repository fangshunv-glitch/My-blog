/* 站长的「就地新增」：博客页写一篇、相册页传照片。
 *
 * 以前加内容必须去 admin.html —— 写一段日记要跳页、传一张照片也要跳页，
 * 过去了还得等后台那一整套登录态和面板初始化。QQ 空间那套更顺手：
 * 按钮就在列表标题旁边，点开是个浮层，存完当场就出现在最上面。
 * 这里照着做，不离开当前这一页。
 *
 * 身份：先查 site_admins 有没有自己那一行（策略只放行自己那行），
 * 查得到才把按钮显出来。这只是「要不要显示」—— 真正拦人的是数据库
 * 策略（posts / photos 的写操作一律 pixel_is_admin()）。
 */
(function () {
  'use strict';

  var CONFIG = window.PIXEL_CLOUD_CONFIG || {};
  var D = window.SITE_DATA || {};
  var BLOG_ALBUM = '博客';

  // -------------------------------------------------------------------------
  // 基础
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
  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function run(query) {
    return Promise.resolve(query).then(function (res) {
      if (res && res.error) throw res.error;
      return res && res.data ? res.data : [];
    });
  }

  function errText(err) {
    var m = (err && (err.message || err.error_description)) || '';
    if (/SDK_MISSING/.test(m)) return '云端脚本没加载上，刷新一下再试。';
    if (/Failed to fetch|NetworkError|fetch/i.test(m)) return '网络好像不通。';
    if (/row-level security|permission denied|42501/i.test(m)) {
      return '这个账号没有权限，先确认是站长身份登录的。';
    }
    return m || '出了点问题，稍后再试。';
  }

  function msg(box, text, isError) {
    if (!box) return;
    box.textContent = text || '';
    // 沿用站点既有的 .form-msg.is-ok / .is-error，别自己另起一套
    box.className = 'form-msg' + (text ? (isError ? ' is-error' : ' is-ok') : '');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function makeSlug() {
    var d = new Date();
    return 'post-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + '-' + Math.random().toString(36).slice(2, 6);
  }

  // -------------------------------------------------------------------------
  // 图片压缩：与 admin.js 那套保持一致
  // -------------------------------------------------------------------------
  function shrink(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) {
        reject(new Error(file.name + ' 不是图片'));
        return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        try {
          resolve({ data: cv.toDataURL('image/jpeg', quality), width: img.width, height: img.height });
        } catch (e) {
          reject(new Error(file.name + ' 转不出来'));
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error(file.name + ' 读不出来（格式可能不支持）'));
      };
      img.src = url;
    });
  }

  // -------------------------------------------------------------------------
  // 浮层
  //
  // 一律用 display:none 收起来（.cmp-mask[hidden]），不要用 visibility ——
  // 隐藏但仍然参与布局的盒子会把整页撑宽，之前踩过一次。
  // -------------------------------------------------------------------------
  var OPEN = null;
  var PREVIEW_URLS = [];

  function onEsc(e) { if (e.key === 'Escape') closeDialog(); }

  function closeDialog() {
    if (!OPEN) return;
    OPEN.parentNode && OPEN.parentNode.removeChild(OPEN);
    OPEN = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onEsc);
    PREVIEW_URLS.forEach(function (u) { URL.revokeObjectURL(u); });
    PREVIEW_URLS = [];
  }

  function openDialog(html) {
    closeDialog();
    var mask = document.createElement('div');
    mask.className = 'cmp-mask';
    mask.innerHTML = '<div class="cmp-card" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(mask);
    document.body.style.overflow = 'hidden';
    OPEN = mask;
    document.addEventListener('keydown', onEsc);

    // 点遮罩关掉，点卡片里面不关
    mask.addEventListener('click', function (e) {
      if (e.target === mask) closeDialog();
    });
    var x = mask.querySelector('.cmp-close');
    if (x) x.addEventListener('click', closeDialog);
    return mask;
  }

  // 选中文件之后的一排小预览。图多了只画前 6 张，剩下的给个数字。
  function paintPicked(boxId, files, noteId) {
    var box = el(boxId);
    var note = el(noteId);
    if (!box) return;
    box.innerHTML = '';
    PREVIEW_URLS.forEach(function (u) { URL.revokeObjectURL(u); });
    PREVIEW_URLS = [];

    if (!files.length) {
      if (note) note.textContent = '';
      return;
    }
    var total = 0;
    files.forEach(function (f) { total += f.size; });
    if (note) note.textContent = '选了 ' + files.length + ' 张，共 '
      + (total / 1048576).toFixed(1) + ' MB';

    files.slice(0, 6).forEach(function (f) {
      var u = URL.createObjectURL(f);
      PREVIEW_URLS.push(u);
      var im = document.createElement('img');
      im.className = 'cmp-thumb';
      im.src = u;
      im.alt = '';
      box.appendChild(im);
    });
  }

  // 可见范围：照 QQ 空间那套排，从「谁都能看」到「只有自己」。
  // 「好友」在这里 = 用邮箱登录过本站的人（游客不算）。
  // 「部分人可见 / 部分人不可见」要勾人，名单走 pixel_site_members() ——
  // 那是个 security definer 函数，只对站长返回名单，别人调用拿到空数组。
  var VIS_OPTS = [
    ['public', '所有人可见'],
    ['members', '好友可见（登录过本站的人）'],
    ['custom', '部分人可见'],
    ['except', '部分人不可见'],
    ['unlisted', '有链接可见（不进列表）'],
    ['private', '仅自己可见'],
    ['draft', '草稿（先存着）']
  ];

  function visOptions(defaultVis, withDraft) {
    return VIS_OPTS.filter(function (o) {
      return withDraft || o[0] !== 'draft';
    }).map(function (o) {
      return '<option value="' + o[0] + '"'
        + (o[0] === (defaultVis || 'draft') ? ' selected' : '') + '>'
        + esc(o[1]) + '</option>';
    }).join('');
  }

  var MEMBERS = null;
  function loadMembers() {
    if (MEMBERS) return Promise.resolve(MEMBERS);
    return run(db().rpc('pixel_site_members')).then(function (rows) {
      MEMBERS = rows || [];
      return MEMBERS;
    }, function () { MEMBERS = []; return MEMBERS; });
  }

  function paintPeople(listId, selected) {
    var box = el(listId);
    if (!box) return;
    var pick = {};
    (selected || []).forEach(function (u) { pick[String(u)] = true; });
    if (!MEMBERS || !MEMBERS.length) {
      box.innerHTML = '<div class="cmp-people-empty">'
        + '还没有别人登录过这个站。让对方来登录一次、设个昵称，这里就有人可选。</div>';
      return;
    }
    box.innerHTML = MEMBERS.map(function (m) {
      var uid = String(m.m_uid);
      var name = m.m_name || ('匿名 ' + uid.slice(-4));
      return '<button type="button" class="cmp-chip' + (pick[uid] ? ' on' : '')
        + '" data-uid="' + esc(uid) + '">' + esc(name) + '</button>';
    }).join('');
  }

  function pickedUids(listId) {
    var box = el(listId);
    if (!box) return [];
    return Array.prototype.slice.call(box.querySelectorAll('.cmp-chip.on'))
      .map(function (b) { return b.getAttribute('data-uid'); });
  }

  // 选中「部分人可见 / 部分人不可见」就把名单摊出来。
  // 两档共用同一排人：只是存的时候一个进 visible_uids、一个进 hidden_uids。
  function bindVis(selId, wrapId, listId) {
    var sel = el(selId);
    if (!sel) return;
    function sync() {
      var need = (sel.value === 'custom' || sel.value === 'except');
      var wrap = el(wrapId);
      if (wrap) wrap.hidden = !need;
      if (!need) return;
      var keep = pickedUids(listId);
      loadMembers().then(function () { paintPeople(listId, keep); });
    }
    sel.addEventListener('change', sync);
    sync();
  }

  function bindPick(listId) {
    var box = el(listId);
    if (!box) return;
    box.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.cmp-chip') : null;
      if (!chip) return;
      chip.classList.toggle('on');
    });
  }

  // 抽出来给两个表单共用：可见范围 + 名单
  function visPayload(prefix) {
    var vis = el(prefix + '-vis').value || 'draft';
    var need = (vis === 'custom' || vis === 'except');
    var uids = need ? pickedUids(prefix + '-people-list') : [];
    return {
      vis: vis,
      need: need,
      uids: uids,
      visible: vis === 'custom' ? uids : [],
      hidden: vis === 'except' ? uids : []
    };
  }

  function tail(msgBox, text, isError) { msg(msgBox, text, isError); }

  // -------------------------------------------------------------------------
  // 写一篇
  // -------------------------------------------------------------------------
  function composePost() {
    openDialog(
      '<div class="cmp-head"><h3>写一篇</h3>'
      + '<button type="button" class="cmp-close" aria-label="关闭">×</button></div>'

      + '<div class="cmp-body">'
      + '<div class="form-row"><label for="cmp-title">标题 <em>必填</em></label>'
      + '<input id="cmp-title" type="text" maxlength="120" placeholder="这篇写点什么"></div>'

      + '<div class="form-row"><label for="cmp-cat">分类 <em>必填</em></label>'
      + '<select id="cmp-cat"><option value="">正在读分类…</option></select>'
      + '<div class="cmp-newcat" id="cmp-newcat-wrap" hidden>'
      + '<input id="cmp-newcat" type="text" maxlength="12" placeholder="新分类叫什么，比如「读书」">'
      + '</div></div>'

      + '<div class="form-row"><label for="cmp-text">正文 <em>必填</em></label>'
      + '<textarea id="cmp-text" rows="11" placeholder="支持 **粗体**、[链接](地址)、- 列表"></textarea></div>'

      + '<div class="cmp-2col">'
      + '<div class="form-row"><label for="cmp-date">日期</label>'
      + '<input id="cmp-date" type="date" value="' + todayStr() + '"></div>'
      + '<div class="form-row"><label for="cmp-vis">谁能看</label>'
      + '<select id="cmp-vis">' + visOptions('draft', true) + '</select></div>'
      + '</div>'

      + '<div class="cmp-people" id="cmp-people" hidden>'
      + '<div class="cmp-people-tip">勾出来的人：选「部分人可见」就是给他们看，'
      + '选「部分人不可见」就是不给他们看。</div>'
      + '<div class="cmp-people-list" id="cmp-people-list"></div></div>'

      + '<div class="form-row"><label for="cmp-excerpt">摘要</label>'
      + '<input id="cmp-excerpt" type="text" maxlength="200" placeholder="留空就截正文开头"></div>'

      + '<div class="form-row"><label for="cmp-tags">标签</label>'
      + '<input id="cmp-tags" type="text" maxlength="120" placeholder="用空格分开，比如 拍照 骑车"></div>'

      + '<div class="form-row"><label for="cmp-files">配图</label>'
      + '<input id="cmp-files" type="file" accept="image/*" multiple>'
      + '<div class="form-note">可以一次选多张，会挂在这篇文章下面。</div>'
      + '<div class="cmp-picked" id="cmp-picked"></div>'
      + '<div class="form-note" id="cmp-picked-note"></div></div>'
      + '</div>'

      + '<div class="cmp-foot">'
      + '<label class="cmp-check"><input type="checkbox" id="cmp-featured"> 置顶</label>'
      + '<button type="button" class="btn" id="cmp-save">发布</button>'
      + '<span class="form-msg" id="cmp-msg" role="status"></span>'
      + '</div>'
    );

    var msgBox = el('cmp-msg');
    var saveBtn = el('cmp-save');
    var picked = [];
    bindVis('cmp-vis', 'cmp-people', 'cmp-people-list');
    bindPick('cmp-people-list');

    // 分类不写死：名单在云端，站长自己加。下拉最后一项是「新建」，
    // 选它就地展开输入框 —— 发文章的时候顺手就把分类建了，
    // 不用为了加一个分类先跑去后台。
    var CATS = [];
    var NEW_OPT = '__new';

    function newCatVisible(on) {
      var wrap = el('cmp-newcat-wrap');
      if (!wrap) return;
      wrap.hidden = !on;
      if (on) {
        var inp = el('cmp-newcat');
        if (inp) inp.focus();
      }
    }

    function fillCatSelect(rows, pick) {
      var sel = el('cmp-cat');
      if (!sel) return;
      var cur = sel.value;
      var html = (rows || []).map(function (r) {
        return '<option value="' + esc(r.name) + '">' + esc(r.name) + '</option>';
      }).join('');
      html += '<option value="' + NEW_OPT + '">＋ 新建分类…</option>';
      sel.innerHTML = html;
      if (!rows || !rows.length) {
        sel.value = NEW_OPT;
        newCatVisible(true);
        return;
      }
      if (pick && findCat(pick)) sel.value = pick;
      else sel.value = (cur && cur !== NEW_OPT && findCat(cur)) ? cur : rows[0].name;
      newCatVisible(sel.value === NEW_OPT);
    }

    function findCat(name) {
      for (var i = 0; i < CATS.length; i++) {
        if (CATS[i].name === name) return CATS[i];
      }
      return null;
    }

    // 建一个分类。重名就当「已经有了」，直接用那一条，别报错。
    function createCat(name) {
      var sort = 0;
      CATS.forEach(function (r) { if ((r.sort || 0) > sort) sort = r.sort; });
      var slug = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      return run(db().from('categories').insert({
        name: name, descr: '', sort: sort + 10, slug: slug
      }).select('id,slug,name,sort')).then(function (rows) {
        var row = (rows && rows[0]) || { id: '', slug: slug, name: name, sort: sort + 10 };
        CATS.push(row);
        fillCatSelect(CATS, row.name);
        return row;
      }, function (err) {
        var m = (err && (err.message || err.error_description)) || '';
        if (!/23505|duplicate|unique/i.test(m)) throw err;
        return run(db().from('categories').select('id,slug,name,sort')
          .eq('name', name).limit(1)).then(function (rows) {
          var row = (rows && rows[0]) || { id: '', slug: '', name: name, sort: 99 };
          if (!findCat(name)) CATS.push(row);
          fillCatSelect(CATS, row.name);
          return row;
        });
      });
    }

    run(db().from('categories').select('slug,name,sort').order('sort', { ascending: true }))
      .then(function (rows) {
        CATS = rows || [];
        fillCatSelect(CATS);
      }, function () {
        var sel = el('cmp-cat');
        CATS = [];
        if (sel) sel.innerHTML = '<option value="' + NEW_OPT + '">＋ 新建分类…</option>';
        if (sel) sel.value = NEW_OPT;
        newCatVisible(true);
      });

    el('cmp-cat').addEventListener('change', function () {
      newCatVisible(el('cmp-cat').value === NEW_OPT);
    });

    el('cmp-files').addEventListener('change', function (e) {
      picked = Array.prototype.slice.call(e.target.files || []);
      paintPicked('cmp-picked', picked, 'cmp-picked-note');
    });

    // 先发文章，再把配图挂上去。配图失败不回头撤销文章 ——
    // 正文已经存好了，为几张图把它删掉更气人。
    saveBtn.addEventListener('click', function () {
      var title = (el('cmp-title').value || '').trim();
      var catVal = el('cmp-cat').value || '';
      var newCat = (el('cmp-newcat').value || '').trim();
      var body = el('cmp-text').value || '';
      var v = visPayload('cmp');
      var vis = v.vis;
      var date = el('cmp-date').value || todayStr();

      if (!title) { el('cmp-title').focus(); return tail(msgBox, '标题还没填。', true); }
      if (v.need && !v.uids.length) {
        return tail(msgBox, vis === 'custom'
          ? '「部分人可见」得先勾几个人。' : '「部分人不可见」得先勾几个人。', true);
      }
      if (!catVal) { return tail(msgBox, '选一个分类，或者新建一个。', true); }
      if (catVal === NEW_OPT) {
        if (!newCat) { el('cmp-newcat').focus(); return tail(msgBox, '新分类还没起名字。', true); }
        if (newCat.length > 12) { return tail(msgBox, '分类名最多 12 个字。', true); }
      }
      if (!body.trim()) { el('cmp-text').focus(); return tail(msgBox, '正文还是空的。', true); }

      var payload = {
        title: title,
        slug: makeSlug(),
        excerpt: (el('cmp-excerpt').value || '').trim(),
        body: body,
        category: catVal,          // 新建的那档在下面存文章之前换成真正的名字
        tags: (el('cmp-tags').value || '').trim(),
        visibility: vis,
        visible_uids: v.visible,
        hidden_uids: v.hidden,
        featured: !!el('cmp-featured').checked,
        published_on: date
      };

      saveBtn.disabled = true;
      tail(msgBox, '正在保存…', false);

      var savedSlug = '';
      Promise.resolve()
        .then(function () {
          if (catVal !== NEW_OPT) return catVal;
          var dup = findCat(newCat);
          if (dup) return dup.name;
          tail(msgBox, '先把分类「' + newCat + '」建上…', false);
          return createCat(newCat).then(function (row) { return row.name; });
        })
        .then(function (cat) {
          payload.category = cat;
          return run(db().from('posts').insert(payload).select('id,slug'));
        })
        .then(function (rows) {
          savedSlug = (rows && rows[0] && rows[0].slug) || payload.slug;
          if (!picked.length) return { ok: 0, failed: [] };

          // 照片的可见范围跟着文章走，名单也照搬 —— 否则文章给了某人，
          // 里面的图对他还是看不见，等于白给。
          var photoVis = vis === 'draft' ? 'private' : vis;
          var photoVisUids = v.visible;
          var photoHiddenUids = v.hidden;
          var ok = 0, failed = [];
          var chain = Promise.resolve();

          picked.forEach(function (f, i) {
            chain = chain.then(function () {
              tail(msgBox, '正在处理配图 ' + (i + 1) + ' / ' + picked.length + '…', false);
              return Promise.all([shrink(f, 1280, 0.78), shrink(f, 360, 0.7)])
                .then(function (r) {
                  return run(db().from('photos').insert({
                    caption: f.name.replace(/\.[^.]+$/, ''),
                    album: BLOG_ALBUM,
                    taken_on: date,
                    post_slug: savedSlug,
                    visibility: photoVis,
                    visible_uids: photoVisUids,
                    hidden_uids: photoHiddenUids,
                    thumb_data: r[1].data,
                    image_data: r[0].data,
                    width: r[0].width,
                    height: r[0].height
                  }));
                })
                .then(function () { ok++; }, function (err) {
                  failed.push(f.name + '（' + errText(err) + '）');
                });
            });
          });
          return chain.then(function () { return { ok: ok, failed: failed }; });
        })
        .then(function (r) {
          closeDialog();
          refreshFeed();
          var text = '已发布。';
          if (r && r.ok) text += ' 配图 ' + r.ok + ' 张。';
          if (r && r.failed && r.failed.length) {
            text += ' 有 ' + r.failed.length + ' 张没传上：' + r.failed.join('；');
          }
          toast(text, !!(r && r.failed && r.failed.length));
        })
        .catch(function (err) {
          saveBtn.disabled = false;
          var t = errText(err);
          if (/duplicate|unique|23505/i.test(t)) t = '这个链接地址撞车了，再点一次就好。';
          tail(msgBox, t, true);
        });
    });

    setTimeout(function () {
      var t = el('cmp-title');
      if (t) t.focus();
    }, 30);
  }

  // -------------------------------------------------------------------------
  // 传照片
  // -------------------------------------------------------------------------
  function composePhotos() {
    openDialog(
      '<div class="cmp-head"><h3>传照片</h3>'
      + '<button type="button" class="cmp-close" aria-label="关闭">×</button></div>'

      + '<div class="cmp-body">'
      + '<div class="form-row"><label for="cmp-files">照片 <em>必填</em></label>'
      + '<input id="cmp-files" type="file" accept="image/*" multiple>'
      + '<div class="cmp-picked" id="cmp-picked"></div>'
      + '<div class="form-note" id="cmp-picked-note">可以一次选多张，在手机上会调起相册。</div></div>'

      + '<div class="form-row"><label for="cmp-caption">说明</label>'
      + '<input id="cmp-caption" type="text" maxlength="200" placeholder="这张拍的是什么"></div>'

      + '<div class="cmp-2col">'
      + '<div class="form-row"><label for="cmp-album">相册</label>'
      + '<input id="cmp-album" type="text" maxlength="40" placeholder="留空归到「散片」"></div>'
      + '<div class="form-row"><label for="cmp-date">拍的日期</label>'
      + '<input id="cmp-date" type="date" value="' + todayStr() + '"></div>'
      + '</div>'

      + '<div class="form-row"><label for="cmp-vis">谁能看</label>'
      + '<select id="cmp-vis">' + visOptions('private') + '</select></div>'
      + '</div>'

      + '<div class="cmp-people" id="cmp-people" hidden>'
      + '<div class="cmp-people-tip">勾出来的人：选「部分人可见」就是给他们看，'
      + '选「部分人不可见」就是不给他们看。</div>'
      + '<div class="cmp-people-list" id="cmp-people-list"></div></div>'

      + '<div class="cmp-foot">'
      + '<button type="button" class="btn" id="cmp-save">上传</button>'
      + '<span class="form-msg" id="cmp-msg" role="status"></span>'
      + '</div>'
    );

    var msgBox = el('cmp-msg');
    var saveBtn = el('cmp-save');
    var picked = [];
    bindVis('cmp-vis', 'cmp-people', 'cmp-people-list');
    bindPick('cmp-people-list');

    el('cmp-files').addEventListener('change', function (e) {
      picked = Array.prototype.slice.call(e.target.files || []);
      paintPicked('cmp-picked', picked, 'cmp-picked-note');
    });

    saveBtn.addEventListener('click', function () {
      if (!picked.length) return tail(msgBox, '先选几张照片。', true);

      var caption = (el('cmp-caption').value || '').trim();
      var album = (el('cmp-album').value || '').trim();
      var date = el('cmp-date').value || todayStr();
      var v = visPayload('cmp');
      var vis = v.vis;
      if (vis === 'draft') vis = 'private';   // 照片没有草稿这一档
      if (v.need && !v.uids.length) {
        return tail(msgBox, vis === 'custom'
          ? '「部分人可见」得先勾几个人。' : '「部分人不可见」得先勾几个人。', true);
      }

      saveBtn.disabled = true;
      var ok = 0, failed = [];
      var chain = Promise.resolve();

      picked.forEach(function (f, i) {
        chain = chain.then(function () {
          tail(msgBox, '正在传 ' + (i + 1) + ' / ' + picked.length + '…', false);
          return Promise.all([shrink(f, 1280, 0.78), shrink(f, 360, 0.7)])
            .then(function (r) {
              return run(db().from('photos').insert({
                caption: caption,
                album: album,
                taken_on: date,
                post_slug: '',
                visibility: vis,
                visible_uids: v.visible,
                hidden_uids: v.hidden,
                thumb_data: r[1].data,
                image_data: r[0].data,
                width: r[0].width,
                height: r[0].height
              }));
            })
            .then(function () { ok++; }, function (err) {
              failed.push(f.name + '（' + errText(err) + '）');
            });
        });
      });

      chain.then(function () {
        closeDialog();
        refreshFeed();
        var text = '传好了 ' + ok + ' 张。';
        if (failed.length) text += ' 有 ' + failed.length + ' 张没成功：' + failed.join('；');
        toast(text, failed.length > 0);
      }).then(function () {
        saveBtn.disabled = false;
      });
    });

    setTimeout(function () {
      var f = el('cmp-files');
      if (f) f.focus();
    }, 30);
  }

  // -------------------------------------------------------------------------
  // 存完之后刷新列表 / 轻提示
  // -------------------------------------------------------------------------
  function refreshFeed() {
    if (window.PixelFeed && typeof window.PixelFeed.reload === 'function') {
      window.PixelFeed.reload();
    }
  }

  var toastTimer = null;
  function toast(text, isError) {
    var box = el('cmp-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cmp-toast';
      box.className = 'cmp-toast';
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.className = 'cmp-toast' + (isError ? ' is-error' : '') + ' show';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      box.className = 'cmp-toast';
    }, isError ? 8000 : 3500);
  }

  // -------------------------------------------------------------------------
  // 挂载：确认是站长才把按钮露出来
  // -------------------------------------------------------------------------
  function isSiteAdmin() {
    // site_admins 的读策略是「只看自己那行」，所以查得到 == 我是站长。
    // 不需要在前端比 uid，也拿不到别人的 uid。
    return run(db().from('site_admins').select('uid').limit(1))
      .then(function (rows) { return !!(rows && rows.length); },
            function () { return false; });
  }

  function mount() {
    var postBtn = el('compose-post');
    var photoBtn = el('compose-photo');
    var catManage = el('cat-manage');
    if (!postBtn && !photoBtn && !catManage) return;

    isSiteAdmin().then(function (ok) {
      if (!ok) return;
      if (postBtn) {
        postBtn.hidden = false;
        postBtn.addEventListener('click', composePost);
      }
      if (photoBtn) {
        photoBtn.hidden = false;
        photoBtn.addEventListener('click', composePhotos);
      }
      // 侧栏「分类」旁边那个「配置」：改名、删除、排序还在后台做，
      // 但入口得摆在他看得见的地方，别让他以为分类是写死的。
      if (catManage) catManage.hidden = false;
    });
  }

  // 留个口子：别的地方（比如文章页的「编辑」）想触发就地新增可以直接调，
  // 排查时也能从控制台手动开一下。
  window.PixelCompose = { post: composePost, photos: composePhotos, close: closeDialog };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
