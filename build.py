# -*- coding: utf-8 -*-
"""
像素日常 · 静态页面生成器
==========================
读 content.py，生成：

    index.html               博客首页（主入口）
    archive.html             文章归档
    album.html               相册（全站照片索引）
    posts/<slug>.html        文章详情
    category/<slug>.html     分类列表

不生成（手工维护）：welcome.html 复古欢迎页 / about.html 关于 / guestbook.html 留言板

用法：  python build.py
"""
import html
import json
import os
import re
import shutil
from datetime import date, datetime

from content import (SITE, CATEGORIES, LINKS, POSTS, COMMENTS, GUESTBOOK,
                     GUESTBOOK_INTRO, ABOUT)

ROOT = os.path.dirname(os.path.abspath(__file__))
PER_PAGE = 5          # 首页每页文章数

# ---------------------------------------------------------------------------
# 数据整理
# ---------------------------------------------------------------------------
CAT_BY_NAME = {c["name"]: c for c in CATEGORIES}
CAT_BY_SLUG = {c["slug"]: c for c in CATEGORIES}


def dkey(p):
    """排序键：发布时间，同一天按 slug 稳定排序。"""
    return (p["date"], p["slug"])


PUBLISHED = sorted([p for p in POSTS if not p.get("draft")], key=dkey, reverse=True)
DRAFTS = [p for p in POSTS if p.get("draft")]


def is_listed(p):
    """只有公开的才进列表 / 索引 / 统计。

    visibility:
      public   —— 默认，一切照常
      unlisted —— 页面照样生成（拿到链接就能看），但不进首页、分类、归档、
                  相册索引、近期互动和任何计数
    """
    return p.get("visibility", "public") == "public"


LISTED = [p for p in PUBLISHED if is_listed(p)]
UNLISTED = [p for p in PUBLISHED if not is_listed(p)]
FEATURED = [p for p in LISTED if p.get("featured")]
NORMAL = [p for p in LISTED if not p.get("featured")]

PHOTOS = []            # 全站照片索引（按文章发布时间倒序，只收公开的）
for _p in LISTED:
    for _ph in _p.get("photos", []):
        if _ph.get("visibility", "public") != "public":
            continue
        PHOTOS.append({**_ph, "post_title": _p["title"], "post_slug": _p["slug"]})


def cat_count(name):
    return len([p for p in LISTED if p["category"] == name])


def trunc(s, n):
    """按字符数截断，超出补省略号。"""
    s = s.strip()
    return s if len(s) <= n else s[:n] + "…"


def is_updated(post):
    """最后更新时间与发布时间不同时才算「已更新」（同一天但改了也算）。"""
    return bool(post.get("updated")) and post["updated"] != post["date"]


# ---------------------------------------------------------------------------
# 极简 Markdown → HTML（够用就好）
# ---------------------------------------------------------------------------
def _inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', s)
    return s


def _join(buf):
    """中文按行折行的段落，拼接时不要插空格；英文单词之间补回来。"""
    out = ""
    for i, seg in enumerate(buf):
        if i and out and out[-1].isascii() and out[-1].isalnum() \
                and seg[:1].isascii() and seg[:1].isalnum():
            out += " "
        out += seg
    return out


def md(text):
    lines = text.strip("\n").split("\n")
    out, i = [], 0
    while i < len(lines):
        ln = lines[i].rstrip()
        if not ln.strip():
            i += 1
            continue
        if ln.startswith("## "):
            out.append("<h3>%s</h3>" % _inline(ln[3:].strip()))
            i += 1
            continue
        if ln.startswith("> "):
            buf = []
            while i < len(lines) and lines[i].startswith("> "):
                buf.append(lines[i][2:].strip())
                i += 1
            out.append("<blockquote>%s</blockquote>" % _inline(_join(buf)))
            continue
        if ln.startswith("- "):
            buf = []
            while i < len(lines) and lines[i].startswith("- "):
                buf.append("<li>%s</li>" % _inline(lines[i][2:].strip()))
                i += 1
            out.append("<ul>%s</ul>" % "".join(buf))
            continue
        buf = []
        while i < len(lines) and lines[i].strip() \
                and not lines[i].startswith(("## ", "> ", "- ")):
            buf.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % _inline(_join(buf)))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 公共片段
# ---------------------------------------------------------------------------
def up(depth, path=""):
    return ("../" * depth) + path


def uptime_days():
    y, m, d = (int(x) for x in SITE["since"].split("-"))
    return max(1, (date.today() - date(y, m, d)).days + 1)


def head(title, desc, depth):
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no">
<meta name="theme-color" content="#2F5D1A">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="icon" type="image/png" href="{p}assets/heart0.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{p}style.css">
</head>""".format(title=html.escape(title), desc=html.escape(desc), p=up(depth))


NAV_ITEMS = [
    ("home", "首页", "index.html"),
    ("album", "相册", "album.html"),
    ("guestbook", "留言板", "guestbook.html"),
    ("about", "关于", "about.html"),
    ("archive", "归档", "archive.html"),
]


def header(active, depth):
    nav = []
    for i, (key, label, href) in enumerate(NAV_ITEMS):
        cls = ' class="active"' if key == active else ""
        if i:
            nav.append('<span class="sep">|</span>')
        nav.append('<a%s href="%s">%s</a>' % (cls, up(depth, href), label))
    return """
  <div class="site-head">
    <div class="logo">
      <img class="pixel sprout" src="{p}assets/sprout.png" alt="">
      <img class="pixel name" src="{p}assets/t_sitename.png" alt="{name}">
    </div>
    <div class="right">
      今天是 <span id="today" class="date-line">{today}</span><br>
      站长信箱：{email}
    </div>
  </div>
  <div class="slogan">—— {slogan} ——</div>

  <div class="nav">
    {nav}
  </div>""".format(
        p=up(depth), name=html.escape(SITE["name"]), email=html.escape(SITE["email"]),
        slogan=html.escape(SITE["slogan"]), today=date.today().strftime("%Y-%m-%d"),
        nav="".join(nav),
    )


def sidebar(depth, skip_me=False):
    p = up(depth)

    # 分类
    cats = "".join(
        '<li><a href="%s">%s</a><span class="n">(%d)</span></li>'
        % (up(depth, "category/%s.html" % c["slug"]), c["name"], cat_count(c["name"]))
        for c in CATEGORIES
    )

    # 归档（按年月分组）
    months = {}
    for post in LISTED:
        months.setdefault(post["date"][:7], []).append(post)
    arch = "".join(
        '<li><a href="%s#%s">%s 年 %d 月</a><span class="n">(%d)</span></li>'
        % (up(depth, "archive.html"), ym, ym[:4], int(ym[5:7]), len(v))
        for ym, v in sorted(months.items(), reverse=True)
    )

    # 最近互动：文章评论 + 留言板合并，标明来源
    feed = []
    for slug, items in COMMENTS.items():
        post = next((x for x in LISTED if x["slug"] == slug), None)
        if not post:
            continue
        for c in items:
            feed.append({"name": c["name"], "time": c["time"], "kind": "comment",
                         "text": c["text"], "post": post})
    for g in GUESTBOOK:
        feed.append({"name": g["name"], "time": g["time"], "kind": "guest",
                     "text": g["text"], "post": None})
    feed.sort(key=lambda x: x["time"], reverse=True)

    acts = []
    for it in feed[:5]:
        if it["kind"] == "comment":
            url = up(depth, "posts/%s.html" % it["post"]["slug"])
            badge = '<a class="src src-post" href="%s">博文</a>' % url
            body = '评论了《<a href="%s">%s</a>》' % (url, html.escape(trunc(it["post"]["title"], 14)))
        else:
            badge = '<a class="src src-guest" href="%s">留言板</a>' % up(depth, "guestbook.html")
            body = html.escape(trunc(it["text"], 30))
        acts.append(
            '<li><div class="act-head"><span class="act-name">%s</span>%s'
            '<span class="act-time">%s</span></div>'
            '<div class="act-body">%s</div></li>'
            % (html.escape(it["name"]), badge, html.escape(it["time"][5:10]), body)
        )

    links = "".join('<li><a href="%s">%s</a></li>' % (l["url"], html.escape(l["name"]))
                    for l in LINKS)

    me = "" if skip_me else """
      <div class="cell">
        <div class="cell-title tall bar-6">
          <img class="pixel" src="{p}assets/t_me.png" alt="关于我">
          <span class="en">ABOUT</span>
        </div>
        <div class="cell-body">
          <div class="me">
            <img class="avatar" src="{p}assets/avatar.png" alt="站长头像">
            <div>
              <div class="me-name">{author}</div>
              <div class="me-bio">{bio}</div>
            </div>
          </div>
          <div class="me-more"><a href="{p}about.html">了解更多 ▸</a></div>
        </div>
      </div>""".format(p=p, author=html.escape(SITE["author"]), bio=html.escape(SITE["bio"]))

    return """
    <div class="sidebar">
{me}
      <div class="cell">
        <div class="cell-title bar-2">
          <img class="pixel" src="{p}assets/t_cat.png" alt="文章分类">
          <span class="en">CATEGORY</span>
        </div>
        <div class="cell-body"><ul class="cat-list">{cats}</ul></div>
      </div>

      <div class="cell">
        <div class="cell-title bar-3">
          <img class="pixel" src="{p}assets/t_arch.png" alt="文章归档">
          <span class="en">ARCHIVE</span>
        </div>
        <div class="cell-body"><ul class="arch-list">{arch}</ul></div>
      </div>

      <div class="cell">
        <div class="cell-title bar-4">
          <img class="pixel" src="{p}assets/t_act.png" alt="最近互动">
          <span class="en">RECENT</span>
        </div>
        <div class="cell-body">
          <ul class="activity" id="recent-list">{acts}</ul>
          <div class="cell-note">文章评论与留言板分开统计，互不重复</div>
        </div>
      </div>

      <div class="cell">
        <div class="cell-title bar-7">
          <img class="pixel" src="{p}assets/t_link.png" alt="友情链接">
          <span class="en">LINKS</span>
        </div>
        <div class="cell-body"><ul class="link-list">{links}</ul></div>
      </div>
    </div>""".format(p=p, me=me, cats=cats, arch=arch, acts="".join(acts), links=links)


def footer(depth):
    n_posts = len(LISTED)
    n_photos = len(PHOTOS)
    return """
  <div class="site-foot">
    © 2026 {name} · 由 {author} 一个人维护<br>
    开站第 <b id="uptime">{days}</b> 天 · 文章 <b>{n_posts}</b> 篇 · 照片 <b>{n_photos}</b> 张
    · 联系站长：{email}<br>
    <a href="{p}welcome.html">★ 复古主页</a> · <a href="{p}about.html">关于</a>
    · <a href="{p}archive.html">归档</a> · <a href="{p}share.html">分享给朋友</a>
    · <a href="{p}admin.html">站长管理</a><br>
    <span class="foot-url">本站地址：<b>{url}</b>（无需登录，直接打开就能看）</span><br>
    <span class="px-en">FASTEST VIEWED AT 800x600</span>
    <div class="foot-hearts">
      <img class="pixel" src="{p}assets/heart0.png" alt="">
      <img class="pixel" src="{p}assets/heart1.png" alt="">
      <img class="pixel" src="{p}assets/heart2.png" alt="">
    </div>
    </div>""".format(name=html.escape(SITE["name"]), author=html.escape(SITE["author"]),
                   days=uptime_days(), n_posts=n_posts, n_photos=n_photos,
                   email=html.escape(SITE["email"]), url=html.escape(SITE["url"]),
                   p=up(depth))


# 云端互动：SDK 走 CDN，cloud.js 是本站的读写封装
CLOUD_SDK_LOCAL = "vendor/workbuddy-cloud.global.js"
CLOUD_SDK_CDN = "https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"


def site_data(depth, all_posts=False):
    """页面内联的站点数据：文章标题映射、站点根路径、站点地址。

    all_posts=False（访客页）只给公开文章，避免把未公开文章的标题带给访客；
    管理后台用 all_posts=True，因为站长本来就能看到全部。
    """
    src = PUBLISHED if all_posts else LISTED
    posts = {p["slug"]: {"title": p["title"], "url": "posts/%s.html" % p["slug"]}
             for p in src}
    data = {
        "author": SITE["author"],
        "base": up(depth),
        "siteUrl": SITE["url"],
        "posts": posts,
    }
    return '<script>window.SITE_DATA = %s;</script>' % json.dumps(data, ensure_ascii=False)


def vendor_scripts(depth):
    """公共依赖，顺序不能动：连接配置 → 云端 SDK。

    SDK 走本地自托管（vendor/ 里那份，62KB），不再直接引 CDN —— 原因有两个：
      1. CDN 在国内不稳定，实测一次要 11 秒；而这行是阻塞式脚本，
         浏览器会一直停在 loading 上，后台页面会空白十来秒才出现登录框；
      2. 一旦 CDN 拉不到，阻塞永远不结束，页面就是一片空白。
    本地文件跟站点一起发布，没有跨境请求。万一某次部署漏掉了这个文件，
    下面那段会同步补一个 CDN 兜底，退回原来的行为而不是彻底不工作。
    """
    return """
<script src="%scloud-config.js"></script>
<script src="%s%s"></script>
<script>if (!window.WorkBuddyCloud) { document.write('<script src="%s"><\\/script>'); }</script>""" % (
        up(depth), up(depth), CLOUD_SDK_LOCAL, CLOUD_SDK_CDN)


def cloud_tags(depth):
    """访客侧：数据 → 配置 → SDK → 互动模块（留言/评论）。"""
    return site_data(depth) + vendor_scripts(depth) + """
<script src="%scloud.js"></script>""" % up(depth)


def admin_tags(depth):
    """站长侧：数据 → 配置 → SDK → 管理模块。"""
    return site_data(depth, all_posts=True) + vendor_scripts(depth) + """
<script src="%sadmin.js"></script>""" % up(depth)


SCRIPT = """
<script>
  (function () {
    var W = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
    var n = new Date();
    var t = document.getElementById('today');
    if (t) t.textContent = n.getFullYear() + '年' + (n.getMonth() + 1) + '月' + n.getDate() + '日 ' + W[n.getDay()];
    var START = new Date({y}, {m}, {d});
    var z = new Date(); z.setHours(0, 0, 0, 0);
    var days = Math.floor((z - START) / 86400000) + 1;
    var u = document.getElementById('uptime');
    if (u) u.textContent = days < 1 ? 1 : days;
  })();
</script>"""


def script_tag():
    y, m, d = SITE["since"].split("-")
    return (SCRIPT.replace("{y}", str(int(y)))
            .replace("{m}", str(int(m) - 1))
            .replace("{d}", str(int(d))))


def page(title, desc, active, depth, main, skip_me=False):
    return "\n".join([
        head(title, desc, depth),
        '<body class="blog">', '<div class="page">',
        header(active, depth), '<div class="layout">', main, sidebar(depth, skip_me),
        "</div>", footer(depth), "</div>", script_tag(), cloud_tags(depth),
        "</body>", "</html>",
    ])


def bare_page(title, desc, active, depth, main, body_class="blog", tags=""):
    """无侧边栏的整页（管理后台 / 分享页用）。"""
    return "\n".join([
        head(title, desc, depth),
        '<body class="%s">' % body_class, '<div class="page">',
        header(active, depth), '<div class="wide-wrap">', main, "</div>",
        footer(depth), "</div>", script_tag(), tags,
        "</body>", "</html>",
    ])


def cat_of(post):
    return CAT_BY_NAME[post["category"]]


# ---------------------------------------------------------------------------
# 页面片段：文章卡片
# ---------------------------------------------------------------------------
def post_card(post, depth, show_cat=True, show_excerpt=True):
    p = up(depth)
    url = p + "posts/%s.html" % post["slug"]
    tags = "".join('<span class="chip">%s</span>' % html.escape(t)
                   for t in post.get("tags", [])[:3])
    meta = ['<span class="m-date">%s</span>' % post["date"]]
    if show_cat:
        meta.append('<span class="m-cat">分类：<a href="%s">%s</a></span>'
                    % (p + "category/%s.html" % cat_of(post)["slug"], post["category"]))
    meta.append('<span>评论 %d</span>' % len(COMMENTS.get(post["slug"], [])))
    if is_updated(post):
        meta.append('<span class="m-upd">已更新</span>')
    body = ('<p class="post-excerpt">%s</p>' % html.escape(post["excerpt"])) if show_excerpt else ""
    return """
      <article class="post">
        <h3 class="post-title"><a href="{url}">{title}</a></h3>
        <div class="post-meta">{meta}</div>
        {body}
        <div class="post-foot">
          <a class="more" href="{url}">阅读全文 ▸</a>
          <span class="post-tags">{tags}</span>
        </div>
      </article>""".format(url=url, title=html.escape(post["title"]),
                         meta="".join(meta), body=body, tags=tags)


def pager(total, depth):
    pages = max(1, (total + PER_PAGE - 1) // PER_PAGE)
    bits = []
    bits.append('<span class="disabled txt">◀ 上一页</span>')
    for i in range(1, pages + 1):
        cls = ' class="current"' if i == 1 else ""
        bits.append("<span%s>%d</span>" % (cls, i))
    bits.append('<span class="disabled txt">下一页 ▶</span>')
    return """
      <div class="pager">
        {bits}
        <div class="pager-note">共 {total} 篇文章 · 第 1 页 / 共 {pages} 页</div>
      </div>""".format(bits="".join(bits), total=total, pages=pages)


# ---------------------------------------------------------------------------
# 首页
# ---------------------------------------------------------------------------
def build_home():
    depth = 0
    feat_html = ""
    for post in FEATURED:
        p_url = "posts/%s.html" % post["slug"]
        feat_html += """
      <article class="post featured">
        <div class="feat-flex">
          <div class="feat-body">
            <h3 class="post-title">
              <a href="{url}">{title}</a><span class="pill">置顶</span>
            </h3>
            <div class="post-meta">
              <span class="m-date">{date}</span>
              <span class="m-cat">分类：<a href="category/{cslug}.html">{cat}</a></span>
              <span>评论 {ncmt}</span>
            </div>
            <p class="post-excerpt">{excerpt}</p>
            <div class="post-foot"><a class="more" href="{url}">阅读全文 ▸</a></div>
          </div>
          <div class="thumb">PIXEL<br>01</div>
        </div>
      </article>""".format(
            url=p_url, title=html.escape(post["title"]), date=post["date"],
            cslug=cat_of(post)["slug"], cat=post["category"],
            ncmt=len(COMMENTS.get(post["slug"], [])), excerpt=html.escape(post["excerpt"]))

    cards = "".join(post_card(p, depth) for p in NORMAL)

    main = """
    <div class="main">

      <div class="notice-bar">
        <span class="badge">NOTICE</span>
        <span>文章地址已固定为稳定别名，标题以后再改旧链接也不会失效</span>
      </div>

      <div class="section-head">
        <h2>最新文章</h2>
        <span class="en">LATEST POSTS</span>
        <span class="count">共 {total} 篇</span>
      </div>
      <div class="sort-note">置顶文章固定在最前，其余按发布时间倒序</div>
{feat}{cards}
{pager}
    </div>""".format(total=len(LISTED), feat=feat_html, cards=cards,
                      pager=pager(len(LISTED), depth))

    out = page("%s · %s" % (SITE["name"], SITE["slogan"]),
               "记录日常、照片与碎碎念的个人博客。", "home", depth, main)
    write("index.html", out)


# ---------------------------------------------------------------------------
# 文章详情
# ---------------------------------------------------------------------------
def build_posts():
    order = sorted(PUBLISHED, key=dkey)          # 按发布时间升序，用于上下篇
    for post in PUBLISHED:
        idx = order.index(post)
        prev_post = order[idx - 1] if idx > 0 else None
        next_post = order[idx + 1] if idx < len(order) - 1 else None

        tags = "".join('<span class="chip">%s</span>' % html.escape(t)
                       for t in post.get("tags", []))

        meta = ['<span class="m-date">发布于 %s</span>' % post["date"],
                '<span class="m-cat">分类：<a href="../category/%s.html">%s</a></span>'
                % (cat_of(post)["slug"], post["category"]),
                '<span>作者：%s</span>' % html.escape(SITE["author"]),
                '<span>评论 %d</span>' % len(COMMENTS.get(post["slug"], []))]
        if is_updated(post):
            meta.append('<span class="m-upd">最后更新于 %s</span>' % post["updated"])

        # 文中照片
        photos = ""
        if post.get("photos"):
            cells = "".join(
                '<div class="album-item"><div class="album-ph">%s</div>'
                '<div class="album-cap">%s<span class="d">%s</span></div></div>'
                % (html.escape(ph["id"]), html.escape(ph["cap"]), ph.get("date", ""))
                for ph in post["photos"])
            photos = """
        <div class="article-photos">
          <div class="sub-head">本篇照片</div>
          <div class="album-grid">%s</div>
        </div>""" % cells

        # 上下篇
        nav = []
        if prev_post:
            nav.append('<a href="%s.html"><span class="dir">上一篇</span>◀ %s</a>'
                       % (prev_post["slug"], html.escape(prev_post["title"])))
        else:
            nav.append('<span class="pn-empty"><span class="dir">上一篇</span>没有了，这是最早的一篇</span>')
        if next_post:
            nav.append('<a class="pn-next" href="%s.html"><span class="dir">下一篇</span>%s ▶</a>'
                       % (next_post["slug"], html.escape(next_post["title"])))
        else:
            nav.append('<span class="pn-empty pn-next"><span class="dir">下一篇</span>还没有更新的</span>')

        # 评论
        cmts = COMMENTS.get(post["slug"], [])
        if cmts:
            items = []
            for c in cmts:
                items.append(
                    '<div class="comment"><div class="comment-head">'
                    '<div class="comment-avatar"></div>'
                    '<span class="comment-name">%s</span>'
                    '<span class="comment-time">%s</span></div>'
                    '<div class="comment-text">%s</div>%s</div>'
                    % (html.escape(c["name"]), html.escape(c["time"]), html.escape(c["text"]),
                       ('<div class="comment-reply"><span class="comment-name">%s</span> 回复：%s</div>'
                        % (html.escape(SITE["author"]), html.escape(c["reply"]))) if c.get("reply") else ""))
            cmt_body = "".join(items)
        else:
            cmt_body = '<div class="empty-tip">还没有评论，来说第一句。</div>'

        # 未公开文章：页面照常生成，但明确告诉看到的人这是怎么回事
        vis = ""
        if post.get("visibility", "public") != "public":
            vis = """
      <div class="vis-note">
        <span class="badge">UNLISTED</span>
        <span>这一篇<b>没有公开</b>：它不在首页、分类、归档和相册里出现，
        只有拿着链接的人能看到。想让它公开，把 <code>content.py</code> 里这篇的
        <code>visibility</code> 改成 <code>public</code> 再重新构建。</span>
      </div>"""

        main = """
    <div class="main">

      <div class="crumb">
        <a href="../index.html">首页</a><span class="sep">›</span>
        <a href="../category/{cslug}.html">{cat}</a><span class="sep">›</span>
        <span>{title}</span>
      </div>
{vis}

      <article class="article">
        <h1 class="article-title">{title}</h1>
        <div class="article-meta">{meta}</div>
        <div class="article-body">{body}</div>
{photos}
        <div class="article-tags"><span class="label">标签：</span>{tags}</div>
      </article>

      <div class="post-nav">{nav}</div>

      <div class="cell" style="margin-top:14px;">
        <div class="cell-title tall bar-2">
          <img class="pixel" src="../assets/t_reply.png" alt="评论">
          <span class="en" id="comment-count">{ncmt} COMMENTS</span>
        </div>
        <div class="cell-body" id="comment-list" data-slug="{pslug}">{cmt_body}</div>
      </div>

      <div class="cell">
        <div class="cell-title bar-5">
          <img class="pixel" src="../assets/t_pub.png" alt="发表评论">
          <span class="en">LEAVE A REPLY</span>
        </div>
        <div class="cell-body">
          <form id="comment-form" novalidate>
            <div class="form-row"><label for="cm-name">昵称 <em>必填</em></label>
              <input id="cm-name" name="name" type="text" maxlength="24" placeholder="怎么称呼你？"></div>
            <div class="form-row"><label for="cm-mail">邮箱 <em>选填</em></label>
              <input id="cm-mail" name="email" type="text" maxlength="120" placeholder="仅用于接收回复通知，不会公开"></div>
            <div class="form-row"><label for="cm-text">评论内容 <em>必填</em></label>
              <textarea id="cm-text" name="content" maxlength="800" placeholder="聊聊这篇文章…"></textarea></div>
            <button class="btn" type="submit">发表评论</button>
            <div class="form-msg" role="status"></div>
            <div class="form-note">评论会立刻显示在这里。邮箱只用于接收站长回复，不会公开。</div>
          </form>
        </div>
      </div>

      <div class="scope-note">
        这里是<b>文章评论</b>，只讨论这一篇。想打招呼、换友链或找站长，请去
        <a href="../guestbook.html">留言板</a>。
      </div>

    </div>""".format(cslug=cat_of(post)["slug"], cat=post["category"],
                     title=html.escape(post["title"]), meta="".join(meta),
                     body=md(post["body"]), photos=photos, tags=tags,
                     nav="".join(nav), ncmt=len(cmts), cmt_body=cmt_body,
                     pslug=post["slug"], vis=vis)

        out = page("%s · %s" % (post["title"], SITE["name"]), post["excerpt"], "", 1, main)
        write("posts/%s.html" % post["slug"], out)

    for post in DRAFTS:
        print("  跳过草稿：%s（%s）" % (post["title"], post["date"]))


# ---------------------------------------------------------------------------
# 分类页
# ---------------------------------------------------------------------------
def build_categories():
    for cat in CATEGORIES:
        items = [p for p in LISTED if p["category"] == cat["name"]]
        cards = "".join(post_card(p, 1, show_cat=False) for p in items)
        if not cards:
            cards = '<div class="empty-tip">这个分类下还没有文章。</div>'
        main = """
    <div class="main">

      <div class="crumb">
        <a href="../index.html">首页</a><span class="sep">›</span>
        <span>分类：{name}</span>
      </div>

      <div class="section-head">
        <h2>分类：{name}</h2>
        <span class="en">CATEGORY</span>
        <span class="count">共 {n} 篇</span>
      </div>
      <div class="sort-note">{desc} · 按发布时间倒序</div>
{cards}
    </div>""".format(name=cat["name"], n=len(items), desc=html.escape(cat["desc"]), cards=cards)
        out = page("分类：%s · %s" % (cat["name"], SITE["name"]),
                   cat["desc"], "", 1, main)
        write("category/%s.html" % cat["slug"], out)


# ---------------------------------------------------------------------------
# 归档页
# ---------------------------------------------------------------------------
def build_archive():
    groups = {}
    for p in LISTED:
        groups.setdefault(p["date"][:7], []).append(p)

    blocks = []
    for ym, items in sorted(groups.items(), reverse=True):
        rows = "".join(
            '<li><span class="a-date">%s</span>'
            '<a class="a-title" href="posts/%s.html">%s</a>'
            '<span class="a-cat"><a href="category/%s.html">%s</a></span></li>'
            % (p["date"][5:], p["slug"], html.escape(p["title"]),
               cat_of(p)["slug"], p["category"])
            for p in sorted(items, key=dkey, reverse=True))
        blocks.append("""
      <div class="cell" id="%s">
        <div class="cell-title bar-3">
          <img class="pixel" src="assets/t_arch.png" alt="文章归档">
          <span class="en">%s · %d POSTS</span>
        </div>
        <div class="cell-body"><ul class="archive-list">%s</ul></div>
      </div>""" % (ym, ym.replace("-", " / "), len(items), rows))

    main = """
    <div class="main">

      <div class="crumb"><a href="index.html">首页</a><span class="sep">›</span><span>归档</span></div>

      <div class="sort-note" style="padding-top:0;">按发布时间倒序，同月内同样倒序 · 共 %d 篇</div>
%s
    </div>""" % (len(LISTED), "".join(blocks))

    out = page("文章归档 · %s" % SITE["name"], "像素日常的全部文章，按月份归档。",
               "archive", 0, main)
    write("archive.html", out)


# ---------------------------------------------------------------------------
# 相册（全站照片索引，可跳回来源文章）
# ---------------------------------------------------------------------------
def build_album():
    groups = {}
    for ph in PHOTOS:
        groups.setdefault(ph.get("date", "")[:7], []).append(ph)

    blocks = []
    for ym, items in sorted(groups.items(), reverse=True):
        items = sorted(items, key=lambda x: x.get("date", ""), reverse=True)
        cells = "".join(
            '<a class="photo-card" href="posts/%s.html">'
            '<div class="album-ph">%s</div>'
            '<div class="album-cap">%s<span class="d">%s</span>'
            '<span class="d from">来自《%s》</span></div></a>'
            % (ph["post_slug"], html.escape(ph["id"]), html.escape(ph["cap"]),
               ph.get("date", ""), html.escape(ph["post_title"]))
            for ph in items)
        blocks.append("""
      <div class="cell">
        <div class="cell-title bar-1">
          <img class="pixel" src="assets/t_wall.png" alt="照片墙">
          <span class="en">%s · %d PHOTOS</span>
        </div>
        <div class="cell-body"><div class="album-grid">%s</div></div>
      </div>""" % (ym.replace("-", " / "), len(items), cells))

    main = """
    <div class="main">

      <div class="crumb"><a href="index.html">首页</a><span class="sep">›</span><span>相册</span></div>

      <div class="section-head">
        <h2>相册</h2>
        <span class="en">PHOTO INDEX</span>
        <span class="count">共 %d 张</span>
      </div>
      <div class="sort-note">这里是全站照片索引，点任意一张可回到它出自的那篇文章</div>
%s
    </div>""" % (len(PHOTOS), "".join(blocks))

    out = page("相册 · %s" % SITE["name"], "像素日常的全站照片索引。", "album", 0, main)
    write("album.html", out)


# ---------------------------------------------------------------------------
# 关于页（独立页面，不再挤在侧边栏）
# ---------------------------------------------------------------------------
def build_about():
    blocks = []
    for sec in ABOUT["sections"]:
        if sec.get("list"):
            rows = "".join('<li><span class="k">%s</span><span class="v">%s</span></li>'
                           % (html.escape(k), html.escape(v)) for k, v in sec["list"])
            body = '<ul class="about-list">%s</ul>' % rows
        else:
            body = '<div class="about-body">%s</div>' % md(sec["md"])
        blocks.append('<h2 class="about-h">%s</h2>\n%s'
                      % (html.escape(sec["h"]), body))

    main = """
    <div class="main">

      <div class="crumb"><a href="index.html">首页</a><span class="sep">›</span><span>关于</span></div>

      <div class="cell">
        <div class="cell-title tall bar-6">
          <img class="pixel" src="assets/t_me.png" alt="关于我">
          <span class="en">ABOUT ME</span>
        </div>
        <div class="cell-body">
          <div class="about-grid">
            <img class="avatar-lg" src="assets/avatar.png" alt="站长头像">
            <div class="about-lede">{lede}</div>
          </div>
        </div>
      </div>

{blocks}

      <div class="about-foot-note">{foot}</div>

    </div>""".format(lede=html.escape(ABOUT["lede"]), blocks="\n".join(blocks),
                     foot=html.escape(ABOUT["foot_note"]))

    out = page("关于 · %s" % SITE["name"],
               "关于站长清羽墨染，以及这个博客的来历。", "about", 0, main, skip_me=True)
    write("about.html", out)


# ---------------------------------------------------------------------------
# 留言板（与文章评论职责分离）
# ---------------------------------------------------------------------------
def build_guestbook():
    items = sorted(GUESTBOOK, key=lambda x: x["time"], reverse=True)
    rows = []
    for g in items:
        reply = ('<div class="comment-reply"><span class="comment-name">%s</span> 回复：%s</div>'
                 % (html.escape(SITE["author"]), html.escape(g["reply"]))) if g.get("reply") else ""
        rows.append(
            '<div class="comment"><div class="comment-head">'
            '<div class="comment-avatar"></div>'
            '<span class="comment-name">%s</span>'
            '<span class="comment-time">%s</span></div>'
            '<div class="comment-text">%s</div>%s</div>'
            % (html.escape(g["name"]), html.escape(g["time"]),
               html.escape(g["text"]), reply))

    main = """
    <div class="main">

      <div class="crumb"><a href="index.html">首页</a><span class="sep">›</span><span>留言板</span></div>

      <div class="scope-note" style="margin-top:0;margin-bottom:12px;">
        {intro}
      </div>

      <div class="cell">
        <div class="cell-title tall bar-4">
          <img class="pixel" src="assets/t_guest.png" alt="留言板">
          <span class="en" id="guestbook-count">{n} MESSAGES</span>
        </div>
        <div class="cell-body" id="guestbook-list">{rows}</div>
      </div>

      <div class="cell">
        <div class="cell-title bar-5">
          <img class="pixel" src="assets/t_msg.png" alt="发表留言">
          <span class="en">LEAVE A MESSAGE</span>
        </div>
        <div class="cell-body">
          <form id="guestbook-form" novalidate>
            <div class="form-row"><label for="gb-name">昵称 <em>必填</em></label>
              <input id="gb-name" name="name" type="text" maxlength="24" placeholder="怎么称呼你？"></div>
            <div class="form-row"><label for="gb-mail">邮箱 <em>选填</em></label>
              <input id="gb-mail" name="email" type="text" maxlength="120" placeholder="仅用于接收站长回复，不会公开"></div>
            <div class="form-row"><label for="gb-text">留言内容 <em>必填</em></label>
              <textarea id="gb-text" name="content" maxlength="800" placeholder="打个招呼、换友链，或者随便说点什么…"></textarea></div>
            <button class="btn" type="submit">发表留言</button>
            <div class="form-msg" role="status"></div>
            <div class="form-note">
              留言会立刻显示在这一页。邮箱只用于接收站长回复，不会公开。
            </div>
          </form>
        </div>
      </div>

    </div>""".format(intro=md(GUESTBOOK_INTRO), n=len(items), rows="".join(rows))

    out = page("留言板 · %s" % SITE["name"],
               "像素日常的留言板：打招呼、交换友链、找站长。", "guestbook", 0, main)
    write("guestbook.html", out)


# ---------------------------------------------------------------------------
# 站长管理后台（访客免登录；这里只给站长一个人用）
# ---------------------------------------------------------------------------
def build_admin():
    main = """
    <div class="crumb"><a href="index.html">首页</a><span class="sep">›</span><span>站长管理</span></div>

    <div class="scope-note" style="margin-top:0;">
      <b>访客看博客不需要登录。</b>留言板、文章评论、相册、归档都是直接打开的——
      这一页只是站长的后台，用来回复/隐藏/删除留言与评论。登录方式为邮箱。
    </div>

    <!-- ============ 未登录 ============ -->
    <div id="auth-view" hidden>
      <div class="cell">
        <div class="cell-title tall bar-7">
          <img class="pixel" src="assets/t_login.png" alt="站长登录">
          <span class="en">SIGN IN</span>
        </div>
        <div class="cell-body">
          <div class="auth-tabs">
            <a href="#" data-tab="login" class="active">登录</a>
            <a href="#" data-tab="signup">注册</a>
            <a href="#" data-tab="reset">忘记密码</a>
          </div>

          <!-- 登录 -->
          <div id="pane-login">
            <div class="form-row"><label for="login-email">邮箱 <em>必填</em></label>
              <input id="login-email" type="text" maxlength="120" autocomplete="username"
                     placeholder="用来登录的邮箱"></div>

            <form id="login-form" novalidate>
              <div class="form-row" id="login-pass-row"><label for="login-password">密码 <em>必填</em></label>
                <input id="login-password" type="password" maxlength="72"
                       autocomplete="current-password" placeholder="登录密码"></div>
              <button class="btn" type="submit">登录</button>
              <div class="form-msg" id="login-msg" role="status"></div>
            </form>

            <form id="login-code-form" novalidate hidden>
              <div class="form-row"><label for="login-code">邮箱验证码 <em>必填</em></label>
                <div class="code-line">
                  <input id="login-code" type="text" maxlength="8" inputmode="numeric"
                         autocomplete="one-time-code" placeholder="收到的数字">
                  <button type="button" class="btn-mini" id="login-send-code">获取验证码</button>
                </div>
              </div>
              <button class="btn" type="submit">登录</button>
              <div class="form-msg" id="login-code-msg" role="status"></div>
            </form>

            <div class="auth-alt">
              首选用「邮箱 + 密码」登录，收不到验证码时也走这条。
              <a href="#" id="login-mode-toggle">改用邮箱验证码登录</a>
            </div>
          </div>

          <!-- 注册 -->
          <div id="pane-signup" hidden>
            <form id="signup-form" novalidate>
              <div class="form-row"><label for="signup-email">邮箱 <em>必填</em></label>
                <input id="signup-email" type="text" maxlength="120" autocomplete="email"
                       placeholder="以后用这个邮箱登录"></div>
              <div class="form-row"><label for="signup-code">邮箱验证码 <em>必填</em></label>
                <div class="code-line">
                  <input id="signup-code" type="text" maxlength="8" inputmode="numeric"
                         autocomplete="one-time-code" placeholder="收到的数字">
                  <button type="button" class="btn-mini" id="signup-send-code">获取验证码</button>
                </div>
              </div>
              <div class="form-row"><label for="signup-password">设置密码 <em>至少 6 位</em></label>
                <input id="signup-password" type="password" maxlength="72"
                       autocomplete="new-password" placeholder="自己想一个"></div>
              <button class="btn" type="submit">注册并登录</button>
              <div class="form-msg" id="signup-msg" role="status"></div>
            </form>
            <div class="auth-alt">账号只用来管后台。访客不需要注册，也不受影响。</div>
          </div>

          <!-- 忘记密码 -->
          <div id="pane-reset" hidden>
            <form id="reset-form" novalidate>
              <div class="form-row"><label for="reset-email">邮箱 <em>必填</em></label>
                <input id="reset-email" type="text" maxlength="120" autocomplete="email"
                       placeholder="注册时用的邮箱"></div>
              <div class="form-row"><label for="reset-code">邮箱验证码 <em>必填</em></label>
                <div class="code-line">
                  <input id="reset-code" type="text" maxlength="8" inputmode="numeric"
                         autocomplete="one-time-code" placeholder="收到的数字">
                  <button type="button" class="btn-mini" id="reset-send-code">获取验证码</button>
                </div>
              </div>
              <div class="form-row"><label for="reset-password">新密码 <em>至少 6 位</em></label>
                <input id="reset-password" type="password" maxlength="72"
                       autocomplete="new-password" placeholder="重新设一个"></div>
              <button class="btn" type="submit">重设密码</button>
              <div class="form-msg" id="reset-msg" role="status"></div>
            </form>
            <div class="auth-alt">顺序是：填邮箱 → 点「获取验证码」→ 收到码再填进来 → 设新密码。</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 已登录 ============ -->
    <div id="panel-view" hidden>

      <div class="adm-bar">
        <div class="adm-me">
          已登录：<b id="account-email">—</b>
          <span class="adm-uid">UID <code id="account-uid">—</code></span>
        </div>
        <button class="btn-mini" id="logout-btn" type="button">退出登录</button>
      </div>

      <!-- 还没认领成站长 -->
      <div class="cell" id="claim-card" hidden>
        <div class="cell-title bar-1">
          <img class="pixel" src="assets/t_claim.png" alt="认领站长">
          <span class="en">CLAIM OWNER</span>
        </div>
        <div class="cell-body">
          <p class="adm-p">这个账号还不是本站的站长，所以看不到后台内容。</p>
          <p class="adm-p">如果这个博客就是你自己的，点下面这个按钮把当前账号认领为站长——
            只有<b>第一个</b>认领的账号会成为站长，之后别人再点也不会生效。</p>
          <button class="btn" id="claim-btn" type="button">认领成为站长</button>
          <div class="form-msg" id="claim-msg" role="status"></div>
          <div class="form-note">
            认领是数据库自己判定的，不需要你手动填任何东西。
            假如提示「云端没认出你的登录状态」，退出后用「邮箱 + 密码」重新登录一次再来。
          </div>
        </div>
      </div>

      <!-- 管理面板 -->
      <div id="admin-panel" hidden>
        <div class="cell">
          <div class="cell-title tall bar-2">
            <img class="pixel" src="assets/t_manage.png" alt="内容管理">
            <span class="en">MANAGE</span>
          </div>
          <div class="cell-body">
            <div class="admin-tabs">
              <a href="#" data-panel="guestbook" class="active">留言板</a>
              <a href="#" data-panel="comments">文章评论</a>
              <a href="#" data-panel="private">私密内容</a>
            </div>
            <div class="admin-count" id="admin-count"></div>
            <div class="form-msg" id="admin-msg" role="status"></div>
          </div>
        </div>

        <div id="admin-list"></div>

        <!-- 私密内容：存在云端数据库，数据库层面只放行站长一个人，
             访客即使猜到这个页面、甚至直接调接口也拿不到 -->
        <div id="private-pane" hidden>
          <div class="cell">
            <div class="cell-title bar-6">
              <img class="pixel" src="assets/t_priv.png" alt="私密内容">
              <span class="en">PRIVATE ONLY</span>
            </div>
            <div class="cell-body">
              <p class="adm-p">
                这里写的东西<b>只有你自己能看到</b>。它不生成网页、不进任何列表，
                存在云端数据库里，访客就算直接调接口也读不到。
              </p>
              <div class="adm-editor">
                <div class="form-row"><label for="pv-title">标题 <em>必填</em></label>
                  <input id="pv-title" type="text" maxlength="80" placeholder="给自己看的标题"></div>
                <div class="form-row"><label for="pv-body">正文 <em>必填</em></label>
                  <textarea id="pv-body" maxlength="8000"
                            placeholder="随便写，只有你能看到…"></textarea></div>
                <div class="adm-form-actions">
                  <button class="btn" id="pv-save" type="button">保存</button>
                  <button class="btn-mini" id="pv-cancel" type="button" hidden>取消编辑</button>
                  <span class="form-msg" id="pv-msg" role="status"></span>
                </div>
              </div>
            </div>
          </div>
          <div id="pv-list"></div>
        </div>

        <div class="scope-note">
          「隐藏」之后访客看不到，但内容还在，随时能恢复；「删除」是真的删掉，找不回来。
        </div>
      </div>
    </div>
"""
    out = bare_page("站长管理 · %s" % SITE["name"],
                    "像素日常的站长后台：管理留言与评论。访客浏览本站无需登录。",
                    "", 0, main, body_class="blog admin-page", tags=admin_tags(0))
    write("admin.html", out)


# ---------------------------------------------------------------------------
# 分享页（把二维码和链接放在一起，方便发给朋友）
# ---------------------------------------------------------------------------
def build_share():
    url = SITE["url"]
    main = """
    <div class="crumb"><a href="index.html">首页</a><span class="sep">›</span><span>分享给朋友</span></div>

    <div class="section-head">
      <h2>把本站分享给朋友</h2>
      <span class="en">SHARE</span>
    </div>
    <div class="sort-note">把链接发过去、或者让朋友扫下面这个码，都能直接打开</div>

    <div class="cell" style="margin-top:12px;">
      <div class="cell-title tall bar-1">
        <img class="pixel" src="assets/t_scan.png" alt="扫码打开">
        <span class="en">SCAN ME</span>
      </div>
      <div class="cell-body">
        <div class="share-body">
          <div class="share-qr">
            <img class="pixel qr-img" src="assets/qr_site.png" alt="本站二维码">
          </div>
          <div class="share-info">
            <div class="share-label">本站地址</div>
            <div class="share-url" id="share-url">{url}</div>
            <button class="btn" id="copy-url" type="button">复制链接</button>
            <div class="form-msg" id="share-msg" role="status"></div>
            <div class="form-note">
              链接已经用稳定域名，可以放心发在群里、写在名片上。
              手机扫上面这个码，效果和点链接一样。
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="cell">
      <div class="cell-title bar-3">
        <img class="pixel" src="assets/t_say.png" alt="可以这么说">
        <span class="en">HOW TO SAY</span>
      </div>
      <div class="cell-body">
        <ul class="share-tips">
          <li><b>发给朋友：</b>「我最近开了个博客，记点日常和照片，直接点开就能看 —— {url}」</li>
          <li><b>发在群里：</b>平时发一条新文章时，把文章页的地址一起贴上，比只发首页更容易被点开。</li>
          <li><b>给长辈/不上网的朋友：</b>直接让他们扫二维码，不用输网址。</li>
        </ul>
      </div>
    </div>

    <div class="cell">
      <div class="cell-title bar-4">
        <img class="pixel" src="assets/t_do.png" alt="朋友能做什么">
        <span class="en">WHAT THEY CAN DO</span>
      </div>
      <div class="cell-body">
        <ul class="share-tips">
          <li>不用注册、不用登录，点开就看 —— 没有任何登录墙</li>
          <li>可以给文章留言评论，可以到<b>留言板</b>打招呼</li>
          <li>手机上打开会自动排成竖屏版式，不用放大缩小</li>
          <li>想把文章存下来，浏览器里直接「收藏」就行</li>
        </ul>
      </div>
    </div>

    <div class="scope-note">
      这一页只是给分享用的说明页，朋友从首页进不来也没关系——
      它出现的位置在页脚，不影响正常浏览。
    </div>

<script>
  (function () {
    var url = document.getElementById('share-url');
    var btn = document.getElementById('copy-url');
    var box = document.getElementById('share-msg');
    var text = '{url}';
    var full = 'https://' + text;
    if (!url || !btn) return;

    function ok(m) { box.textContent = m; box.className = 'form-msg is-ok'; }

    btn.addEventListener('click', function () {
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = full;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var done = false;
        try { done = document.execCommand('copy'); } catch (e) { done = false; }
        document.body.removeChild(ta);
        ok(done ? '已复制，去粘贴给朋友吧。' : '复制没成功，长按上面那行地址手动选吧。');
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(full).then(function () {
          ok('已复制，去粘贴给朋友吧。');
        }, fallback);
      } else {
        fallback();
      }
    });
  })();
</script>""".replace("{url}", url)

    out = bare_page("分享给朋友 · %s" % SITE["name"],
                    "把像素日常分享给朋友：扫码或复制链接，直接打开就能看。",
                    "", 0, main, body_class="blog share-page", tags=cloud_tags(0))
    write("share.html", out)


# ---------------------------------------------------------------------------
def write(rel, content):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    print("  生成 %s" % rel)


def main():
    print("构建 %s …" % SITE["name"])
    print("  公开 %d 篇 / 未公开 %d 篇 / 草稿 %d 篇 / 照片 %d 张"
          % (len(LISTED), len(UNLISTED), len(DRAFTS), len(PHOTOS)))
    for d in ("posts", "category"):
        p = os.path.join(ROOT, d)
        if os.path.isdir(p):
            shutil.rmtree(p)
    build_home()
    build_posts()
    build_categories()
    build_archive()
    build_album()
    build_about()
    build_guestbook()
    build_share()
    build_admin()
    print("完成。")


if __name__ == "__main__":
    main()
