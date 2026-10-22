# -*- coding: utf-8 -*-
"""
像素日常 · 静态页面生成器
==========================
读 content.py，生成：

    index.html               封面首页（站名 + 题记 + 点线目录）
    blog.html                博客（文章列表 + 侧边栏）
    projects.html            项目
    about.html               关于
    album.html               相册（全站照片索引）
    guestbook.html           留言板
    archive.html             文章归档
    post.html?slug=<slug>    文章详情（内容从云端读，见 feed.js）
    category.html?c=<slug>   分类列表（分类由站长在后台维护）
    share.html               分享给朋友
    admin.html / login.html  站长后台 / 访客账号

不生成（手工维护）：welcome.html 复古欢迎页

首页是一屏封面，不是文章列表 —— 章节结构与目录都由 content.py 的
CHAPTERS 驱动，加一章只要往那张表里加一行。文章列表在 blog.html。

用法：  python build.py
"""
import hashlib
import html
import json
import os
import re
import shutil
from datetime import date, datetime
from urllib.parse import quote

from content import (SITE, HOME, CHAPTERS, LEGACY_CATEGORY_SLUGS, LINKS, POSTS,
                     COMMENTS, GUESTBOOK, GUESTBOOK_INTRO, ABOUT,
                     PROJECTS, PROJECTS_LEDE, PROJECTS_INTRO, PROJECTS_NOTE,
                     RETIRED_SLUGS, EMOJI)

ROOT = os.path.dirname(os.path.abspath(__file__))
PER_PAGE = 5          # 首页每页文章数

# ---------------------------------------------------------------------------
# 数据整理
# ---------------------------------------------------------------------------
# 分类现在存在云端 categories 表里，站长在后台随时增删改，构建期是看不到的。
# 这里只留一份「旧分类名 → 旧 slug」的提示表，给静态兜底链接和旧地址跳转页用。
CAT_SLUG = {name: slug for slug, name in LEGACY_CATEGORY_SLUGS.items()}


def cat_href(name, depth=0):
    """分类页地址。分类页已经变成 category.html?c=<slug> 这一个动态页面。"""
    return up(depth) + "category.html?c=" + quote(CAT_SLUG.get(name, name))


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


def _inline_lines(buf):
    """一个段落里的若干行：行尾写反斜杠就硬换行，否则照旧拼成一句。

    写散文诗那种一行一个意象的东西时，靠空行分段会把间距拉得太开，
    所以留了这个口子 —— 行尾加一个反斜杠，渲染成 <br>。

    注意 content.py 里要写成两个反斜杠（源码字面转义），
    因为在 Python 字符串里单个反斜杠加换行会被当成续行吃掉。

    每段还要走一遍 _inline：**粗体**、[链接](url) 和 HTML 转义都在那里。
    这里以前只拼了 <br>，于是段落里的 **粗体** 原样带着星号显示出来
    （项目页那句「只放**真的动手做过**的东西」就是这么露出来的）。
    """
    parts, cur = [], []
    for seg in buf:
        seg = seg.rstrip()
        hard = seg.endswith("\\")
        if hard:
            seg = seg[:-1].rstrip()
        cur.append(seg)
        if hard:
            parts.append(_join(cur))
            cur = []
    if cur:
        parts.append(_join(cur))
    return "<br>".join(_inline(x) for x in parts)


def escape_lines(text):
    """纯文本多行 → 保留换行的 HTML。先逐行转义再拼 <br>，不给注入留口子。"""
    rows = text.strip("\n").split("\n")
    return "<br>".join(html.escape(x) for x in rows)


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
        out.append("<p>%s</p>" % _inline_lines(buf))
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


# 导航顺序跟着封面的目录走（壹 关于 / 贰 项目 / 叁 博客 / 肆 相册 / 伍 留言板），
# 编号和位置对不上会显得乱。第一项是封面本身，不算章。
NAV_ITEMS = [
    ("home", "封面", "index.html"),
    ("about", "关于", "about.html"),
    ("projects", "项目", "projects.html"),
    ("blog", "博客", "blog.html"),
    ("album", "相册", "album.html"),
    ("guestbook", "留言板", "guestbook.html"),
]

# 章节查表：key -> (编号, 章名, 页址, 英文名, 一句话)
CHAPTER_BY_KEY = {c[0]: c for c in CHAPTERS}

CN_DIGITS = "〇一二三四五六七八九"


def cn_year(year=None):
    """2026 -> 二〇二六。用来在封面底部盖一个像旧书版权页的年份。"""
    return "".join(CN_DIGITS[int(d)] for d in str(year or date.today().year))


def toc_nav(depth=0, cls="toc"):
    """点线目录：`章节名 …………… 编号`。

    封面和页脚共用同一份数据，所以两处的目录永远一致。
    """
    p = up(depth)
    rows = "".join(
        '<li><a href="{p}{href}">'
        '<span class="toc-name">{name}</span>'
        '<span class="toc-dots" aria-hidden="true"></span>'
        '<span class="toc-num">{num}</span>'
        '</a></li>'.format(p=p, href=href, name=html.escape(name), num=num)
        for key, num, name, href, en, desc in CHAPTERS
    )
    return '<nav class="%s"><ol>%s</ol></nav>' % (cls, rows)


def chapter_head(key, depth=0):
    """章题头：编号 + 章名 + 英文名。每个章节页顶部都有一份。

    这是从参考站借来的做法 —— 全站每一章长得像一本书的一章，
    用户在哪儿、这是第几章，一眼就看得到。
    章名用像素字图片（assets/ch_<key>.png），和站名保持同一套视觉。
    """
    k, num, name, href, en, desc = CHAPTER_BY_KEY[key]
    p = up(depth)
    return """
    <header class="chapter-head">
      <a class="ch-back" href="{p}index.html">← 回到封面</a>
      <div class="ch-mark">
        <span class="ch-num">{num}</span>
        <h1 class="ch-title">
          <img class="pixel" src="{p}assets/ch_{key}.png" alt="{name}">
        </h1>
        <span class="ch-en">{en}</span>
      </div>
      <p class="ch-desc">{desc}</p>
    </header>""".format(p=p, num=num, name=html.escape(name), key=key,
                       en=en, desc=html.escape(desc))


def chapter_crumb(key, tail, depth=0):
    """从属于某一章的子页（归档 / 分类）用的面包屑，不占章节编号。"""
    k, num, name, href, en, desc = CHAPTER_BY_KEY[key]
    p = up(depth)
    return ('<div class="crumb"><a href="%sindex.html">封面</a>'
            '<span class="sep">›</span>'
            '<a href="%s%s">%s %s</a>'
            '<span class="sep">›</span><span>%s</span></div>'
            % (p, p, href, num, html.escape(name), html.escape(tail)))


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
      找我：<a href="{p}guestbook.html">留言板</a>
    </div>
    <a class="head-login" id="head-login" href="{p}login.html">
      <i class="dot" aria-hidden="true"></i><span class="txt">登录</span>
    </a>
  </div>
  <div class="slogan">—— {slogan} ——</div>

  <div class="nav">
    {nav}
    </div>""".format(
        p=up(depth), name=html.escape(SITE["name"]),
        slogan=html.escape(SITE["slogan"]), today=date.today().strftime("%Y-%m-%d"),
        nav="".join(nav),
    )


def swap_head_login(out, href, label):
    """改掉页眉右上角那颗按钮的去向。

    账号页和站长后台本来就在处理身份，那里还摆一颗「登录」只会被误点，
    所以这两页换成「返回博客」。其他页面保持原样，交给 cloud.js 按登录态改文案。
    """
    return (out
            .replace('<a class="head-login" id="head-login" href="login.html">',
                     '<a class="head-login is-in" id="head-login" href="%s">' % href, 1)
            .replace('<span class="txt">登录</span>',
                     '<span class="txt">%s</span>' % html.escape(label), 1))


def sidebar(depth, skip_me=False):
    p = up(depth)

    # 分类：名单存在云端，站长在后台随时增删改，构建期拿不到。
    # 这里只留一个空壳，由 feed.js 读出来再填；JS 没跑起来时也不至于是一片空白。
    cats = '<li class="side-empty">分类正在读…</li>'

    # 归档（按年月分组）
    months = {}
    for post in LISTED:
        months.setdefault(post["date"][:7], []).append(post)
    arch = "".join(
        '<li><a href="%s#%s">%s 年 %d 月</a><span class="n" data-arch-count="%s">(%d)</span></li>'
        % (up(depth, "archive.html"), ym, ym[:4], int(ym[5:7]), ym, len(v))
        for ym, v in sorted(months.items(), reverse=True)
    )
    # 空站时这块是空的，不补一句会看着像坏了。
    if not arch:
        arch = '<li class="side-empty">文章按月分组之后，这里会长出归档。</li>'

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
            url = up(depth, "post.html?slug=%s" % it["post"]["slug"])
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
    if not acts:
        acts = ['<li class="side-empty">还没有评论和留言。'
                '登录之后在文章下面说话，这里会显示最近几条。</li>']

    links = "".join('<li><a href="%s">%s</a></li>' % (l["url"], html.escape(l["name"]))
                    for l in LINKS)
    # 没有真的友链就整块不渲染 —— 摆一排指向 # 的假链接比空着更难看。
    links_cell = "" if not LINKS else """
      <div class="cell">
        <div class="cell-title bar-7">
          <img class="pixel" src="{p}assets/t_link.png" alt="友情链接">
          <span class="en">LINKS</span>
        </div>
        <div class="cell-body"><ul class="link-list">{links}</ul></div>
      </div>""".format(p=p, links=links)

    me = "" if skip_me else """
      <div class="cell">
        <div class="cell-title tall bar-6">
          <img class="pixel" src="{p}assets/t_me.png" alt="关于我">
          <span class="en">ABOUT</span>
        </div>
        <div class="cell-body">
          <div class="me">
            <img class="avatar" src="{p}assets/avatar.png" alt="站长头像" data-site-avatar>
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
        <div class="cell-body"><ul class="cat-list" id="cat-list">{cats}</ul></div>
      </div>

      <div class="cell">
        <div class="cell-title bar-3">
          <img class="pixel" src="{p}assets/t_arch.png" alt="文章归档">
          <span class="en">ARCHIVE</span>
        </div>
        <div class="cell-body"><ul class="arch-list" id="arch-list">{arch}</ul></div>
      </div>

      <div class="cell">
        <div class="cell-title bar-4">
          <img class="pixel" src="{p}assets/t_act.png" alt="最近互动">
          <span class="en">RECENT</span>
        </div>
        <div class="cell-body">
          <ul class="activity" id="recent-list">{acts}</ul>
        </div>
      </div>
{links_cell}
    </div>""".format(p=p, me=me, cats=cats, arch=arch, acts="".join(acts),
                     links_cell=links_cell)


def footer(depth, marquee=True):
    """页脚。marquee=False 时不带那条跑马灯（封面用，保持一屏干净）。"""
    # 文章和照片都在云端，构建期这两个数几乎总是 0 —— 而 0 是在撒谎
    # （站上明明有 1 篇）。所以没有静态内容时留个破折号，
    # 由页脚里那个 foot-stats.js 读到云端真实条数再换掉。
    n_posts = len(LISTED) or "—"
    n_photos = len(PHOTOS) or "—"
    # 跑马灯内容就是站点口号。做成「一份内容复制两遍、动画只跑一半」的
    # 无缝循环 —— 这样整条始终是满的，不会出现开头一长段空白。
    marq = ""
    if marquee:
        unit = '<span>※ %s ※</span>' % html.escape(SITE["slogan"])
        marq = ('<div class="marquee foot-marquee"><div class="marquee-track">%s</div></div>'
                % (unit * 5 * 2))
    return """
  <div class="site-foot">
    {marq}
    <div class="foot-contact">
      <a href="{gh}" target="_blank" rel="noopener">GitHub</a>
      <span class="sep">·</span>
      <a href="{p}welcome.html">复古入口</a>
    </div>
    {toc}
    <div class="foot-line">
      © 2026 {name}<br>
      开站第 <b id="uptime">{days}</b> 天 · 文章 <b id="foot-posts">{n_posts}</b> 篇 · 照片 <b id="foot-photos">{n_photos}</b> 张<br>
      <a href="{p}archive.html">归档</a> · <a href="{p}share.html">分享给朋友</a>
      · <a href="{p}login.html">我的账号</a> · <a href="{p}admin.html">站长管理</a><br>
      <span class="foot-url">本站地址：<a href="{url}"><b>{url}</b></a></span><br>
      <span class="px-en">FASTEST VIEWED AT 800x600</span>
      <div class="foot-hearts">
        <img class="pixel" src="{p}assets/heart0.png" alt="">
        <img class="pixel" src="{p}assets/heart1.png" alt="">
        <img class="pixel" src="{p}assets/heart2.png" alt="">
      </div>
    </div>
    <!-- 上面那两个数字是构建期的快照：文章和照片都在云端，构建时永远是 0。
         按真实条数改写的是这个小脚本。挂在页脚里，因为每个页面都有页脚
         （封面页连 feed.js 都没加载，只有它能兜住）。
         它只要一个接口地址和公开键，所以在这儿顺手把 cloud-config.js 也带上——
         深度页、内容页早就引过了，同一份文件浏览器不会再下一遍。
         defer：等文档解析完再跑，免得比页脚里的元素还早。 -->
    <script defer src="{p}cloud-config.js"></script>
    <script defer src="{p}foot-stats.js"></script>
    <!-- 站点头像：avatars 里 is_site 那一行。跟上面同一个道理 —— 侧栏在每一页都有，
         封面页也在，所以只能挂在页脚。 -->
    <script defer src="{p}owner-avatar.js"></script>
    </div>""".format(name=html.escape(SITE["name"]), marq=marq,
                     days=uptime_days(), n_posts=n_posts, n_photos=n_photos,
                     url=html.escape(SITE["url"]),
                     gh=html.escape(SITE.get("github", "#")),
                     toc=toc_nav(depth, "foot-toc"), p=up(depth))


# 云端互动：SDK 走 CDN，cloud.js 是本站的读写封装
CLOUD_SDK_LOCAL = "vendor/workbuddy-cloud.global.js"
CLOUD_SDK_CDN = "https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"


def site_data(depth, all_posts=False):
    """页面内联的站点数据：文章标题映射、站点根路径、站点地址。

    all_posts=False（访客页）只给公开文章，避免把未公开文章的标题带给访客；
    管理后台用 all_posts=True，因为站长本来就能看到全部。
    """
    src = PUBLISHED if all_posts else LISTED
    posts = {p["slug"]: {"title": p["title"], "url": "post.html?slug=%s" % p["slug"]}
             for p in src}
    data = {
        "author": SITE["author"],
        "siteName": SITE["name"],
        "base": up(depth),
        "siteUrl": SITE["url"],
        "posts": posts,
    }
    # EMOJI_V 单独挂一个全局：cloud.js / feed.js / admin.js 三处拼表情 URL 时都要用。
    return ('<script>window.SITE_DATA = %s;window.EMOJI_V = "%s";</script>'
            % (json.dumps(data, ensure_ascii=False), emoji_version()))


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
    """访客侧：数据 → 配置 → SDK → 内容渲染 → 互动模块（留言/评论）。

    feed.js 必须排在 cloud.js 前面：它把云端文章灌进列表页，
    顺便把「slug → 标题」的映射交给 cloud.js，侧边栏的最近互动才认得出文章名。
    """
    return site_data(depth) + vendor_scripts(depth) + """
<script src="%sfeed.js"></script>
<script src="%scloud.js"></script>""" % (up(depth), up(depth))


def admin_tags(depth):
    """站长侧：数据 → 配置 → SDK → 管理模块。"""
    return site_data(depth, all_posts=True) + vendor_scripts(depth) + """
<script src="%sadmin.js"></script>""" % up(depth)


def login_tags(depth):
    """访客账号侧：数据 → 配置 → SDK → 登录/昵称模块。"""
    return site_data(depth) + vendor_scripts(depth) + """
<script src="%slogin.js"></script>""" % up(depth)


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

    /* 顶部像素阅读进度条。
       封面不要（它就只有一屏），页面短到不用滚也不要，
       免得冒出一条永远空着的条。 */
    if (!document.body.classList.contains('cover-body')
        && document.documentElement.scrollHeight > window.innerHeight * 1.5) {
      var bar = document.createElement('div');
      bar.className = 'px-readbar';
      bar.innerHTML = '<i></i>';
      document.body.appendChild(bar);
      var fill = bar.firstChild, raf = 0;
      var upd = function () {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        var r = max > 0 ? (window.pageYOffset || document.documentElement.scrollTop) / max : 0;
        fill.style.width = (r < 0 ? 0 : r > 1 ? 1 : r) * 100 + '%';
        raf = 0;
      };
      window.addEventListener('scroll', function () {
        if (!raf) raf = requestAnimationFrame(upd);
      }, { passive: true });
      window.addEventListener('resize', upd);
      upd();
    }

    /* ⓘ 小提示。
       写页面的过程中攒了不少「说明性文字」——那是需求，不是内容，
       不该整段铺在界面占地方。收进一个圆点里，鼠标移上去或点一下才出来。
       用点击切换而不是纯 :hover —— 手机上 hover 不可靠，
       而且这些字一多，hover 容易看一半就飘走。 */
    var openDot = null;
    function closeDot() {
      if (openDot) { openDot.classList.remove('on'); openDot = null; }
    }
    document.addEventListener('click', function (e) {
      var t = e.target;
      var dot = t && t.closest ? t.closest('.info-dot') : null;
      if (!dot) { closeDot(); return; }
      if (dot === openDot) { closeDot(); return; }
      closeDot();
      dot.classList.add('on');
      openDot = dot;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDot();
    });
  })();
</script>"""


def script_tag():
    y, m, d = SITE["since"].split("-")
    # 表情名单从这里下发给前端：cloud.js 和 feed.js 靠它把 :smile: 换成图。
    # 名单本身只在 content.py 里维护一份。
    emoji_js = json.dumps([{"k": k, "n": n} for k, n in EMOJI],
                          ensure_ascii=False, separators=(",", ":"))
    return ('<script>window.PIXEL_EMOJI = %s;</script>\n' % emoji_js
            + SCRIPT.replace("{y}", str(int(y)))
            .replace("{m}", str(int(m) - 1))
            .replace("{d}", str(int(d))))


def page(title, desc, active, depth, main, skip_me=False, top=""):
    """标准两栏页：章题头（top）→ 正文 + 侧边栏。

    top 放在 .layout 外面，这样章题头是通栏居中的，不会被挤进正文那一栏。
    """
    return "\n".join([
        head(title, desc, depth),
        '<body class="blog">', '<div class="page">',
        header(active, depth), top,
        '<div class="layout">', main, sidebar(depth, skip_me),
        "</div>", footer(depth), "</div>", script_tag(), cloud_tags(depth),
        "</body>", "</html>",
    ])


def bare_page(title, desc, active, depth, main, body_class="blog", tags="",
              top="", wrap="wide-wrap"):
    """无侧边栏的整页（项目 / 管理后台 / 分享页用）。"""
    return "\n".join([
        head(title, desc, depth),
        '<body class="%s">' % body_class, '<div class="page">',
        header(active, depth), top, '<div class="%s">' % wrap, main, "</div>",
        footer(depth), "</div>", script_tag(), tags,
        "</body>", "</html>",
    ])


def cat_of(post):
    """静态文章的分类链接。POSTS 现在是空的（文章全在云端写），
    这条线只在有人重新往 content.py 里写文章时才会走。"""
    return {"slug": CAT_SLUG.get(post["category"], post["category"]),
            "name": post["category"]}


# ---------------------------------------------------------------------------
# 页面片段：文章卡片
# ---------------------------------------------------------------------------
def post_card(post, depth, show_cat=True, show_excerpt=True):
    p = up(depth)
    url = p + "post.html?slug=%s" % post["slug"]
    tags = "".join('<span class="chip">%s</span>' % html.escape(t)
                   for t in post.get("tags", [])[:3])
    meta = ['<span class="m-date">%s</span>' % post["date"]]
    if show_cat:
        meta.append('<span class="m-cat">分类：<a href="%s">%s</a></span>'
                    % (p + "category.html?c=" + quote(cat_of(post)["slug"]), post["category"]))
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
          <a class="more" href="{url}">阅读全文 <span class="arrow">▸</span></a>
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
# 封面首页
# ---------------------------------------------------------------------------
def build_home():
    """一屏封面：站名 + 题记 + 点线目录。

    首页不承担信息流 —— 它只回答「这里有什么、点哪儿进去」。
    文章列表在 blog.html，也就是目录里的「叁 博客」。
    """
    epigraph = HOME.get("epigraph") or SITE["slogan"]
    # 联系方式只在页脚放一份。封面以前也摆一套 GitHub / 复古入口，
    # 结果首页往下滚一点就是页脚，同样的两个链接一屏里出现两次。

    main = """
    <div class="cover">
      <div class="cover-inner">
        <div class="cover-mark">
          <img class="pixel" src="assets/t_cover.png" alt="{name}">
        </div>
        <p class="cover-epigraph">{epi}</p>
        <p class="cover-from">{epi_from}</p>

        {toc}

        {lede}
      </div>

      <div class="cover-foot">
        <div class="cover-year">{year}</div>
      </div>
    </div>""".format(
        name=html.escape(SITE["name"]), epi=html.escape(epigraph),
        epi_from=html.escape(HOME.get("epigraph_from", "")),
        toc=toc_nav(0, "toc"),
        # 没有 lede 就整行不渲染，别留一个空 <p> 撑出间距
        lede=('<p class="cover-lede">%s</p>' % html.escape(HOME["lede"])
              if HOME.get("lede", "").strip() else ""),
        year=cn_year())

    out = "\n".join([
        head("%s · %s" % (SITE["name"], epigraph), SITE["slogan"], 0),
        '<body class="cover-body">', '<div class="page">',
        main, footer(0, marquee=False), "</div>", script_tag(),
        "</body>", "</html>",
    ])
    write("index.html", out)


# ---------------------------------------------------------------------------
# 博客：文章列表（原来在首页，现在归到「叁 博客」这一章）
# ---------------------------------------------------------------------------
def build_blog():
    depth = 0
    feat_html = ""
    for post in FEATURED:
        p_url = "post.html?slug=%s" % post["slug"]
        feat_html += """
      <article class="post featured">
        <div class="feat-flex">
          <div class="feat-body">
            <h3 class="post-title">
              <a href="{url}">{title}</a><span class="pill">置顶</span>
            </h3>
            <div class="post-meta">
              <span class="m-date">{date}</span>
              <span class="m-cat">分类：<a href="category.html?c={cslug}">{cat}</a></span>
              <span>评论 {ncmt}</span>
            </div>
            <p class="post-excerpt">{excerpt}</p>
            <div class="post-foot"><a class="more" href="{url}">阅读全文 ▸</a></div>
          </div>
          <div class="thumb">PIXEL<br>01</div>
        </div>
      </article>""".format(
            url=p_url, title=html.escape(post["title"]), date=post["date"],
            cslug=quote(cat_of(post)["slug"]), cat=post["category"],
            ncmt=len(COMMENTS.get(post["slug"], [])), excerpt=html.escape(post["excerpt"]))

    cards = "".join(post_card(p, depth) for p in NORMAL)

    # 静态生成时通常是空的（文章在云端），这块空态只是 JS 没跑起来时的兜底
    feed_inner = feat_html + cards
    if not feed_inner:
        feed_inner = ('<div class="empty-tip">这里还没有文章。'
                      '第一篇正在路上，过阵子再来看看。</div>')

    main = """
    <div class="main">

      <div class="section-head">
        <h2>最新文章</h2>
        <span class="en">LATEST POSTS</span>
        <span class="count" id="feed-count">共 {total} 篇</span>
        <button class="compose-btn" id="compose-post" type="button" hidden>写一篇</button>
      </div>
      <div id="feed-posts" data-view="all">{inner}</div>
    </div>
    <script defer src="compose.js"></script>""".format(total=len(LISTED) or "—", inner=feed_inner)

    out = page("%s · 博客" % SITE["name"],
               "记录日常、照片与碎碎念的个人博客。", "blog", depth, main,
               top=chapter_head("blog", depth))
    write("blog.html", out)


# ---------------------------------------------------------------------------
# 项目
# ---------------------------------------------------------------------------
def build_projects():
    """项目一章：不做卡片网格，一条一条排。

    每一条 = 一张像素插图 + 名称 + 类型标签 + 一句话说明 + 几条要点 + 链接。
    留白多、没有边框和阴影 —— 这是从参考站借来的排版，让「东西」自己说话。
    """
    depth = 0
    blocks = []
    for pr in PROJECTS:
        points = "".join('<li>%s</li>' % html.escape(x)
                         for x in pr.get("points", []))
        chips = "".join('<span class="chip">%s</span>' % html.escape(s)
                        for s in pr.get("stack", []))
        links = []
        for i, (text, url) in enumerate(pr.get("links", [])):
            ext = ' target="_blank" rel="noopener"' if url.startswith("http") else ""
            if i == 0:
                links.append('<a class="proj-go" href="%s"%s>%s →</a>'
                             % (html.escape(url), ext, html.escape(text)))
            else:
                links.append('<a class="proj-link" href="%s"%s>%s</a>'
                             % (html.escape(url), ext, html.escape(text)))
        meta = " · ".join(x for x in (pr.get("year", ""), pr.get("status", "")) if x)
        blocks.append("""
      <article class="project">
        <div class="proj-art">
          <img class="pixel" src="assets/{art}" alt="">
        </div>
        <div class="proj-body">
          <div class="proj-head">
            <h2 class="proj-name">{name}</h2>
            <span class="proj-kind">{kind}</span>
          </div>
          <p class="proj-desc">{desc}</p>
          <ul class="proj-points">{points}</ul>
          <div class="proj-foot">
            <div class="proj-side">
              <div class="proj-meta">{meta}</div>
              <div class="proj-stack">{chips}</div>
            </div>
            <div class="proj-links">{links}</div>
          </div>
        </div>
      </article>""".format(
            art=html.escape(pr.get("art", "")), name=html.escape(pr["name"]),
            kind=html.escape(pr.get("kind", "")), desc=html.escape(pr.get("desc", "")),
            points=points, meta=html.escape(meta), chips=chips,
            links="".join(links)))

    note = ('<p class="proj-note">%s</p>' % html.escape(PROJECTS_NOTE)
            if PROJECTS_NOTE.strip() else "")

    main = """
    <p class="proj-lede">{lede}</p>
    {intro}
{blocks}
    {note}""".format(lede=html.escape(PROJECTS_LEDE),
                     # 没有 intro 就整块不渲染
                     intro=('<div class="proj-intro">%s</div>' % md(PROJECTS_INTRO)
                            if PROJECTS_INTRO.strip() else ""),
                     blocks="".join(blocks), note=note)

    out = bare_page("%s · 项目" % SITE["name"], PROJECTS_LEDE, "projects", depth,
                    main, top=chapter_head("projects", depth), wrap="proj-wrap",
                    tags=cloud_tags(depth))
    write("projects.html", out)


# ---------------------------------------------------------------------------
# 文章详情
# ---------------------------------------------------------------------------
def build_post():
    """文章详情页（post.html?slug=xxx）—— 全站只有这一个文章模板。

    正文不在这里拼：文章存在云端数据库里，随时能改，所以这一页只生成骨架
    和一组带 id 的钩子，由 feed.js 按 ?slug= 把内容填进去。

    换来的是「改一篇文章不用重新构建、重新发布」；代价是正文要等 JS 到位。
    这是把文章交给后台管理的必然结果——静态站自己没法知道站长刚写了个什么。
    """
    main = """
    <div class="main">

      <div class="crumb" id="post-crumb">
        <a href="index.html">封面</a><span class="sep">›</span>
        <a href="blog.html">叁 博客</a><span class="sep">›</span>
        <span>文章</span>
      </div>

      <!-- 加载中 / 找不到 / 不公开，三种状态共用这一块 -->
      <div class="cell" id="post-state">
        <div class="cell-body">
          <div class="empty-tip" id="post-state-tip">正在读取这篇文章…</div>
        </div>
      </div>

      <div id="post-vis"></div>

      <article class="article" id="post-article" hidden>
        <h1 class="article-title" id="post-title"></h1>
        <div class="article-meta" id="post-meta"></div>
        <div class="article-body" id="post-body"></div>
        <div id="post-photos"></div>
        <div class="article-tags" id="post-tags"></div>
      </article>

      <div class="post-nav" id="post-nav" hidden></div>

      <!-- 评论：登录访客就能发（策略是 uid = auth.uid()，站长没特权）。
           slug 等文章读出来之后由 feed.js 填，填好再让 cloud.js 接管。 -->
      <div class="cell" id="comment-box" style="margin-top:14px;" hidden>
        <div class="cell-title tall bar-2">
          <img class="pixel" src="assets/t_reply.png" alt="评论">
          <span class="en" id="comment-count">COMMENTS</span>
        </div>
        <div class="cell-body" id="comment-list" data-slug=""></div>
      </div>

      <div class="cell" id="comment-form-box" hidden>
        <div class="cell-title bar-5">
          <img class="pixel" src="assets/t_pub.png" alt="发表评论">
          <span class="en">LEAVE A REPLY</span>
        </div>
        <div class="cell-body">

          <!-- 未登录：只看到这扇门。默认可见——JS 挂了也还看得见引导 -->
          <div class="auth-gate" id="comment-gate">
            <div class="gate-lines">
              <p class="auth-gate-line">
                登录后就能评论。邮箱收个验证码，不用注册。
              </p>
            </div>
            <a class="btn gate-btn" id="comment-login" href="login.html">登录</a>
          </div>

          <!-- 已登录：只填内容，昵称从账号带出来 -->
          <form id="comment-form" novalidate hidden>
            <div class="me-line">
              我以 <b id="comment-me">—</b> 的身份评论
              <a class="me-edit" href="login.html">改昵称</a>
            </div>
            <div class="form-row"><label for="cm-text">评论内容 <em>必填</em></label>
              <textarea id="cm-text" name="content" maxlength="800" placeholder="聊聊这篇文章…"></textarea></div>
            <button class="btn" type="submit">发表评论</button>
            <div class="form-msg" role="status"></div>
            <div class="form-note">评论会立刻显示在这里。</div>
          </form>
        </div>
      </div>

    </div>"""

    out = page("文章 · %s" % SITE["name"],
               "像素日常的一篇文章。", "", 0, main)
    write("post.html", out)


# ---------------------------------------------------------------------------
# 分类页
# ---------------------------------------------------------------------------
def build_categories():
    """分类页 —— 全站只有这一个，地址是 category.html?c=<slug>。

    分类名单存在云端 categories 表里，站长在后台自己增删改，构建期根本看不到，
    所以这里只生成骨架，由 feed.js 按 ?c= 读出分类、再筛出它下面的文章。
    这样加一个分类不用重新构建、也不用重新发布。

    另外给早期那批 category/daily.html 之类的地址补一个跳转页，
    免得旧链接、别人存的书签变成 404。
    """
    main = """
    <div class="main">

      <div class="crumb" id="cat-crumb">
        <a href="index.html">封面</a><span class="sep">›</span>
        <a href="blog.html">叁 博客</a><span class="sep">›</span>
        <span id="cat-crumb-now">分类</span>
      </div>

      <div class="section-head">
        <h2 id="cat-title">正在读这个分类…</h2>
        <span class="en">CATEGORY</span>
        <span class="count" id="feed-count"></span>
      </div>
      <div class="sort-note" id="cat-desc"></div>

      <div id="feed-posts" data-view="category">
        <div class="empty-tip">文章正在从云端读出来…</div>
      </div>
    </div>"""

    out = page("分类 · %s" % SITE["name"], "像素日常的文章分类。", "blog", 0, main)
    write("category.html", out)

    for slug, name in LEGACY_CATEGORY_SLUGS.items():
        to = "../category.html?c=" + quote(slug)
        stub = (
            '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
            '<title>分类：%s · %s</title>\n'
            '<link rel="canonical" href="%s">\n'
            '<meta http-equiv="refresh" content="0; url=%s">\n'
            '<meta name="robots" content="noindex">\n'
            '<style>body{font-family:"Microsoft YaHei",sans-serif;background:#F5F2E8;'
            'color:#3A3A3A;text-align:center;padding:80px 20px}a{color:#3E7B14}</style>\n'
            '</head>\n<body>\n<p>分类页换了地址，正在带你去 '
            '<a href="%s">分类：%s</a>…</p>\n'
            '<script>location.replace("%s");</script>\n'
            '</body>\n</html>\n'
            % (html.escape(name), html.escape(SITE["name"]), to, to, to,
               html.escape(name), to)
        )
        write("category/%s.html" % slug, stub)


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
            '<a class="a-title" href="post.html?slug=%s">%s</a>'
            '<span class="a-cat"><a href="category.html?c=%s">%s</a></span></li>'
            % (p["date"][5:], p["slug"], html.escape(p["title"]),
               quote(cat_of(p)["slug"]), p["category"])
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

      %s

      <div class="sort-note" style="padding-top:0;">共 <b id="feed-count">%s</b> 篇</div>
      <div id="feed-archive">%s</div>
    </div>""" % (chapter_crumb("blog", "归档", 0), len(LISTED) or "—",
                 "".join(blocks) or '<div class="empty-tip">还没有文章可以归档。</div>')

    out = page("文章归档 · %s" % SITE["name"], "像素日常的全部文章，按月份归档。",
               "blog", 0, main)
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
            '<a class="photo-card" href="post.html?slug=%s">'
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

      <div class="section-head">
        <h2>相册</h2>
        <span class="en">PHOTO INDEX</span>
        <span class="count" id="feed-photo-count">共 %s 张</span>
        <button class="compose-btn" id="compose-photo" type="button" hidden>传照片</button>
      </div>
      <div class="sort-note">点任意一张看大图</div>
      <div id="feed-album">%s</div>
    </div>
    <script defer src="compose.js"></script>""" % (len(PHOTOS) or "—",
                 "".join(blocks) or '<div class="empty-tip">相册还是空的。站长登录后在「站长管理 → 相册」里传第一张。</div>')

    out = page("相册 · %s" % SITE["name"], "像素日常的全站照片索引。", "album", 0, main,
               top=chapter_head("album", 0))
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

      <div class="cell">
        <div class="cell-title tall bar-6">
          <img class="pixel" src="assets/t_me.png" alt="关于我">
          <span class="en">ABOUT ME</span>
        </div>
        <div class="cell-body">
          <div class="about-grid">
            <img class="avatar-lg" src="assets/avatar.png" alt="站长头像" data-site-avatar>
            <div class="about-lede">{lede}</div>
          </div>
        </div>
      </div>

{blocks}

      <div class="about-foot-note">{foot}</div>

    </div>""".format(lede=escape_lines(ABOUT["lede"]), blocks="\n".join(blocks),
                     foot=html.escape(ABOUT["foot_note"]))

    out = page("关于 · %s" % SITE["name"],
               "关于站长清羽墨染：几座城，一个阳台，一些没说完的话。", "about", 0, main, skip_me=True,
               top=chapter_head("about", 0))
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

      {intro}

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

          <!-- 未登录：只看到这扇门。默认可见——JS 挂了也还看得见引导 -->
          <div class="auth-gate" id="guestbook-gate">
            <div class="gate-lines">
              <p class="auth-gate-line">
                登录后就能留言。邮箱收个验证码，不用注册。
              </p>
            </div>
            <a class="btn gate-btn" id="guestbook-login" href="login.html">登录</a>
          </div>

          <!-- 已登录：只填内容，昵称从账号带出来 -->
          <form id="guestbook-form" novalidate hidden>
            <div class="me-line">
              我以 <b id="guestbook-me">—</b> 的身份留言
              <a class="me-edit" href="login.html">改昵称</a>
            </div>
            <div class="form-row"><label for="gb-text">留言内容 <em>必填</em></label>
              <textarea id="gb-text" name="content" maxlength="800" placeholder="打个招呼、换友链，或者随便说点什么…"></textarea></div>
            <button class="btn" type="submit">发表留言</button>
            <div class="form-msg" role="status"></div>
            <div class="form-note">留言会立刻显示在这一页。</div>
          </form>
        </div>
      </div>

    </div>""".format(intro=('<div class="scope-note" style="margin-top:0;margin-bottom:12px;">'
                            '%s</div>' % md(GUESTBOOK_INTRO)
                            if GUESTBOOK_INTRO.strip() else ""),
                    n=len(items),
                    rows="".join(rows) or '<div class="empty-tip">还没有留言，来说第一句。</div>')

    out = page("留言板 · %s" % SITE["name"],
               "像素日常的留言板：打招呼、交换友链、找站长。", "guestbook", 0, main,
               top=chapter_head("guestbook", 0))
    write("guestbook.html", out)


# ---------------------------------------------------------------------------
# 可见范围：四档。文案在这里定义一次，后台下拉和前台提示都用它。
# 真正的拦截在数据库行级策略里（见 posts / photos 两张表的 read 策略）。
# ---------------------------------------------------------------------------
# 四档可见范围。文章和照片共用同一套文案，所以别写「进首页、分类」这种
# 只对文章成立的说法，改成两边都读得通的。
# 顺序照旧，但静态 HTML 里把 private 标成 selected —— 万一 JS 没跑起来，
# 默认落在最保守的一档，不会莫名其妙把东西放出去。
VIS_OPTIONS = [
    ("public", "公开 —— 所有人进来都能看到，会进列表"),
    ("unlisted", "有链接可见 —— 不进任何列表，拿到链接的人能看"),
    ("custom", "指定人可见 —— 只有你勾选的人登录后能看到"),
    ("private", "仅自己可见 —— 只有你登录后能看到"),
    ("draft", "草稿 —— 先存着，前台当它没发布"),
]
VIS_DEFAULT = "private"

# 照片的可见范围暂时不含「指定人」：照片是按相册成批翻的，
# 一张张指定人容易乱。要发只给某几个人看的东西，写文章挂图更合适。
PHOTO_VIS_OPTIONS = [o for o in VIS_OPTIONS if o[0] != "custom"]


# ---------------------------------------------------------------------------
# 站长管理后台（访客免登录；这里只给站长一个人用）
# ---------------------------------------------------------------------------
def build_admin():
    # 分类名单在云端，这里先给个占位，admin.js 开机会把它填满。
    cat_opts = '<option value="">正在读分类…</option>'
    vis_opts = "".join(
        '<option value="%s"%s>%s</option>'
        % (v, ' selected' if v == VIS_DEFAULT else "", label)
        for v, label in VIS_OPTIONS)
    photo_vis_opts = "".join(
        '<option value="%s"%s>%s</option>'
        % (v, ' selected' if v == VIS_DEFAULT else "", label)
        for v, label in PHOTO_VIS_OPTIONS)

    main = """
    <div class="crumb"><a href="index.html">封面</a><span class="sep">›</span><span>站长管理</span><button
      type="button" class="info-dot" data-info="站长的后台：回复/隐藏/删除留言与评论，写文章、传照片。浏览博客本身不需要登录——相册、归档、文章都是直接打开的。">i</button></div>

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
            <div class="auth-alt">这个账号是站长本人用的。访客想留言，走账号页的邮箱验证码就行，不用注册。</div>
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
          已登录：<b id="account-email">—</b><button
            type="button" class="info-dot" id="account-info" data-info="正在读取账号信息…">i</button>
        </div>
        <button class="btn-mini" id="logout-btn" type="button">退出登录</button>
      </div>

      <!-- 不是站长：这里什么都不给，只留一句看得懂的话 -->
      <div class="cell" id="not-admin-card" hidden>
        <div class="cell-title bar-1">
          <img class="pixel" src="assets/t_claim.png" alt="没有权限">
          <span class="en">NO ACCESS</span>
        </div>
        <div class="cell-body">
          <p class="adm-p">这个账号不是本站的站长，所以看不到后台内容。</p>
          <p class="adm-p">想看内容的话回<a href="index.html">封面</a>，
            有话想说就去<a href="guestbook.html">留言板</a>。</p>
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
              <a href="#" data-panel="posts">文章</a>
              <a href="#" data-panel="cats">分类</a>
              <a href="#" data-panel="photos">相册</a>
              <a href="#" data-panel="private">私密内容</a>
              <button type="button" class="info-dot" data-info="「隐藏」之后访客看不到，但内容还在，随时能恢复；「删除」是真的删掉，找不回来。">i</button>
            </div>
            <div class="admin-count" id="admin-count"></div>
            <div class="form-msg" id="admin-msg" role="status"></div>
          </div>
        </div>

        <div id="admin-list"></div>

        <!-- ============ 文章：增删改查 + 可见范围 ============
             数据在云端 posts 表。写操作只有站长能过（策略 pixel_is_admin()），
             访客按可见范围读：public / unlisted 才读得到，private 和 draft 连查都查不到。 -->
        <div id="posts-pane" hidden>
          <div class="cell">
            <div class="cell-title bar-4">
              <img class="pixel" src="assets/t_write.png" alt="写文章">
              <span class="en">WRITE A POST</span>
            </div>
            <div class="cell-body">
              <div class="adm-editor">
                <div class="form-row"><label for="po-title">标题 <em>必填</em></label>
                  <input id="po-title" type="text" maxlength="120" placeholder="今天想写点什么"></div>

                <div class="form-row"><label for="po-slug">链接别名 <em>必填</em></label>
                  <input id="po-slug" type="text" maxlength="79" placeholder="post-20261014-a1b2">
                  <div class="form-note">只用小写字母、数字和连字符。发布后再改，旧链接就失效了。</div>
                </div>

                <div class="form-row-2">
                  <div class="form-row"><label for="po-cat">分类</label>
                    <select id="po-cat">__CAT_OPTS__</select></div>
                  <div class="form-row"><label for="po-vis">可见范围 <em>必填</em></label>
                    <select id="po-vis">__VIS_OPTS__</select></div>
                </div>
                <div class="form-note" id="po-vis-note">
                  可见范围决定谁能看到这篇：访客的数据库查询会被直接拦住，
                  不是前端藏起来——写成「仅自己可见」的内容，别人就算会看代码也翻不出来。
                </div>

                <div class="form-row" id="po-people" hidden>
                  <label>给谁看</label>
                  <div class="adm-people" id="po-people-list"></div>
                  <div class="form-note" id="po-people-note">
                    这里只列<b>用邮箱登录过本站、并且设过昵称</b>的人。
                    想让谁进这个名单，让他先来登录一次就行。
                  </div>
                </div>

                <div class="form-row"><label for="po-tags">标签</label>
                  <input id="po-tags" type="text" maxlength="120" placeholder="用逗号分开，比如：随笔, 拍照">
                  <div class="form-note">列表里最多显示前三个。</div></div>

                <div class="form-row"><label for="po-excerpt">摘要</label>
                  <textarea id="po-excerpt" class="adm-excerpt" maxlength="200"
                            placeholder="列表页显示的一两句话。不填就自动截正文开头。"></textarea></div>

                <div class="form-row"><label for="po-body">正文 <em>必填</em></label>
                  <textarea id="po-body" class="adm-body" maxlength="60000"
                            placeholder="极简 Markdown：## 小标题、- 列表项、&gt; 引用、**粗体**、[文字](https://链接)"></textarea>
                  <div class="form-note">空行分段。改完点「发布」，前台立刻就是新的。</div></div>

                <div class="form-row-2">
                  <div class="form-row"><label for="po-date">发布日期</label>
                    <input id="po-date" type="date"></div>
                  <div class="form-row"><label class="adm-check" for="po-featured">
                    <input id="po-featured" type="checkbox"> 置顶到列表最前</label></div>
                </div>

                <div class="adm-form-actions">
                  <button class="btn" id="po-save" type="button">发布</button>
                  <button class="btn-mini" id="po-cancel" type="button" hidden>取消编辑</button>
                  <span class="form-msg" id="po-msg" role="status"></span>
                </div>
              </div>
            </div>
          </div>
          <div id="po-list"></div>
        </div>

        <!-- ============ 相册：上传照片 ============
             照片在你本机压缩成两版再存进数据库：缩略图给网格，大图点开才读。
             访客不用登录就能看（存放在公开可见的行里），但上传只有站长能做。 -->
        <div id="photos-pane" hidden>
          <div class="cell">
            <div class="cell-title bar-1">
              <img class="pixel" src="assets/t_upload.png" alt="上传照片">
              <span class="en">ADD PHOTOS</span>
            </div>
            <div class="cell-body">
              <div class="adm-editor">
                <div class="form-row"><label for="ph-file">选照片 <em>必填</em></label>
                  <input id="ph-file" type="file" accept="image/*" multiple>
                  <div class="form-note">可以一次选多张。上传前在你本机压好（大图长边 1280、缩略图 360），
                    原图不会上传，所以手机拍的大图也不会拖慢页面。</div></div>

                <div class="form-row"><label for="ph-caption">说明</label>
                  <input id="ph-caption" type="text" maxlength="200" placeholder="这张拍的是什么"></div>

                <div class="form-row-2">
                  <div class="form-row"><label for="ph-album">相册名</label>
                    <input id="ph-album" type="text" maxlength="40" placeholder="比如：秋天的公园">
                    <div class="form-note" id="ph-album-note">留空就归到「散片」。
                      挂了文章的照片一律进「博客相册」，不跟别的照片混。</div></div>
                  <div class="form-row"><label for="ph-date">拍摄日期</label>
                    <input id="ph-date" type="date"></div>
                </div>

                <div class="form-row-2">
                  <div class="form-row"><label for="ph-post">挂到哪篇文章下</label>
                    <select id="ph-post"><option value="">不挂，只放相册</option></select>
                    <div class="form-note">挂上之后，那篇文章底部会多一块「本篇照片」。</div></div>
                  <div class="form-row"><label for="ph-vis">可见范围</label>
                    <select id="ph-vis">__PHOTO_VIS_OPTS__</select>
                    <div class="form-note">默认停在「仅自己可见」——
                      想让人看到，传之前先把它改成「公开」。传完再改也来得及，
                      下面每张照片都能单独删。</div></div>
                </div>

                <div class="adm-form-actions">
                  <button class="btn" id="ph-save" type="button">上传</button>
                  <span class="form-msg" id="ph-msg" role="status"></span>
                </div>
              </div>
            </div>
          </div>
          <div id="ph-list"></div>
        </div>

        <!-- ============ 分类：站长自己维护 ============
             卡在云端 categories 表里，前台分类页 category.html?c=<slug> 现读现筛，
             所以加一个分类不用重新构建页面，也不用重新发布。 -->
        <div id="cats-pane" hidden>
          <div class="cell">
            <div class="cell-title bar-5">
              <img class="pixel" src="assets/t_cat.png" alt="分类">
              <span class="en">CATEGORIES</span>
            </div>
            <div class="cell-body">
              <p class="adm-p">分类归你自己管：加一个、改个名、不要了删掉，
                前台立刻跟着变。改名字的时候，已经挂在这个分类下的文章会一起跟着搬过去。</p>
              <div class="adm-editor">
                <div class="form-row-2">
                  <div class="form-row"><label for="ct-name">分类名 <em>必填</em></label>
                    <input id="ct-name" type="text" maxlength="12" placeholder="比如：读书"></div>
                  <div class="form-row"><label for="ct-desc">一句话说明</label>
                    <input id="ct-desc" type="text" maxlength="40" placeholder="这个分类装什么"></div>
                </div>
                <div class="adm-form-actions">
                  <button class="btn" id="ct-save" type="button">添加分类</button>
                  <button class="btn-mini" id="ct-cancel" type="button" hidden>取消改名</button>
                  <span class="form-msg" id="ct-msg" role="status"></span>
                </div>
              </div>
            </div>
          </div>
          <div id="ct-list"></div>
        </div>

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
      </div>
    </div>
"""
    main = main.replace("__CAT_OPTS__", cat_opts).replace("__VIS_OPTS__", vis_opts)
    main = main.replace("__PHOTO_VIS_OPTS__", photo_vis_opts)
    out = bare_page("站长管理 · %s" % SITE["name"],
                    "像素日常的站长后台：写文章、传照片、管留言与评论。访客浏览本站无需登录。",
                    "", 0, main, body_class="blog admin-page", tags=admin_tags(0))
    write("admin.html", swap_head_login(out, "blog.html", "返回博客"))


# ---------------------------------------------------------------------------
# 分享页（把二维码和链接放在一起，方便发给朋友）
# ---------------------------------------------------------------------------
# 访客账号页（登录 / 注册 / 取昵称）
#
# 为什么要有这一页：留言和评论改成「先登录再发言」之后，访客需要一个入口。
# 放独立页面而不是在留言框里展开，是因为登录动作要收邮箱验证码、
# 首次还要取昵称，塞进侧边栏那个窄框里会很难用。
# ---------------------------------------------------------------------------
def build_login():
    main = """
    <div class="crumb"><a href="index.html">封面</a><span class="sep">›</span><span>账号</span><button
      type="button" class="info-dot" data-info="浏览本站永远不需要登录——相册、归档、文章都直接打开。只有留言和评论要先对一下身份，这样每句话都挂在真实账号上，别人冒用不了。">i</button></div>

    <!-- ============ 未登录 ============ -->
    <div id="guest-auth" hidden>
      <div class="cell">
        <div class="cell-title tall bar-7">
          <img class="pixel" src="assets/t_account.png" alt="我的账号">
          <span class="en">SIGN IN</span>
        </div>
        <div class="cell-body">
          <div class="form-row"><label for="login-email">邮箱 <em>必填</em></label>
            <input id="login-email" type="text" maxlength="120" autocomplete="email"
                   placeholder="你的邮箱"></div>

          <!-- 主路径：邮箱 + 验证码。第一次来会顺带建号，所以没有单独的「注册」。 -->
          <form id="login-code-form" novalidate>
            <div class="form-row"><label for="login-code">验证码 <em>必填</em></label>
              <div class="code-line">
                <input id="login-code" type="text" maxlength="8" inputmode="numeric"
                       autocomplete="one-time-code" placeholder="收到的数字">
                <button type="button" class="btn-mini" id="login-send-code">获取验证码</button>
              </div>
            </div>
            <button class="btn" type="submit">登录</button>
            <div class="form-msg" id="login-code-msg" role="status"></div>
            <div class="form-note">
              第一次来的话，验证码填完就自动有了账号，不用另外注册。
              邮箱只用来对身份，不会显示在留言旁边。
            </div>
          </form>

          <!-- 备选：密码登录。站长用得上，访客可以完全不管这一块。 -->
          <form id="login-form" novalidate hidden>
            <div class="form-row"><label for="login-password">密码 <em>必填</em></label>
              <input id="login-password" type="password" maxlength="72"
                     autocomplete="current-password" placeholder="登录密码"></div>
            <button class="btn" type="submit">登录</button>
            <div class="form-msg" id="login-msg" role="status"></div>
            <div class="form-note">忘了密码也没关系，用上面的邮箱验证码一样能进。</div>
          </form>

          <div class="auth-alt">
            <span id="login-mode-lead">以前设过密码？</span>
            <a href="#" id="login-mode-toggle">用密码登录</a>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 已登录 ============ -->
    <div id="guest-account" hidden>

      <div class="adm-bar">
        <div class="adm-me">
          已登录：<b id="me-email">—</b>
          <span class="adm-uid">当前昵称 <code id="me-name">—</code></span>
        </div>
        <button class="btn-mini" id="logout-btn" type="button">退出登录</button>
      </div>

      <div class="cell">
        <div class="cell-title tall bar-2">
          <img class="pixel" src="assets/t_avatar.png" alt="我的头像">
          <span class="en">MY AVATAR</span>
        </div>
        <div class="cell-body">
          <div class="avatar-row">
            <div class="avatar-slot" id="avatar-slot"></div>
            <div class="avatar-act">
              <label class="btn" for="avatar-file">选一张图</label>
              <input id="avatar-file" type="file" accept="image/*" hidden>
              <button class="btn-mini" id="avatar-clear" type="button">去掉头像</button>
              <div class="form-msg" id="avatar-msg" role="status"></div>
            </div>
          </div>
          <div class="form-note">
            方图最好，会自动裁成正方形缩到 64 像素，原图不会被改动。
            不设头像的话，留言旁边显示一块绿色斜纹。
          </div>
        </div>
      </div>

      <div class="cell">
        <div class="cell-title tall bar-3">
          <img class="pixel" src="assets/t_me.png" alt="我的昵称">
          <span class="en">MY NAME</span>
        </div>
        <div class="cell-body">
          <p class="adm-p" id="nick-intro"></p>
          <form id="nick-form" novalidate>
            <div class="form-row"><label for="nick-input">昵称 <em>2-24 个字</em></label>
              <input id="nick-input" type="text" maxlength="24"
                     placeholder="留言和评论旁边显示的就是这个名字"></div>
            <button class="btn" type="submit" id="nick-save">就这个</button>
            <div class="form-msg" id="nick-msg" role="status"></div>
            <div class="form-note">
              昵称全站唯一，先到先得；之后随时可以在这里改。
              改了之后，<b>以前发过的留言会保持当时的名字</b>，不会跟着变。
            </div>
          </form>
        </div>
      </div>

      <div class="scope-note">
        <a href="index.html">回封面</a> 或 <a href="blog.html">去看博客</a> 就能发言了。
      </div>
    </div>
    """
    out = bare_page("账号 · %s" % SITE["name"],
                    "登录像素日常的访客账号：留言和评论需要先登录。浏览本站无需登录。",
                    "", 0, main, body_class="blog login-page", tags=login_tags(0))
    write("login.html", swap_head_login(out, "blog.html", "返回博客"))


# ---------------------------------------------------------------------------
def build_share():
    url = SITE["url"]
    main = """
    <div class="crumb"><a href="index.html">封面</a><span class="sep">›</span><span>分享给朋友</span></div>

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
              链接不会变，发出去就一直有效。
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
          <li>不用注册、不用登录，点开就看 —— 浏览本身没有任何登录墙</li>
          <li>想留言或评论时，用一个邮箱验证码登一下就行，不用另外注册</li>
          <li>手机上打开会自动排成竖屏版式，不用放大缩小</li>
          <li>想把文章存下来，浏览器里直接「收藏」就行</li>
        </ul>
      </div>
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
# 已下线旧文章的跳转页
#
# 为什么需要这个：部署是覆盖式的，本地删掉的文件不会从线上消失。
# posts/<slug>.html 那一批旧文章早就不生成了，但线上还挂着，
# 旧书签和搜索引擎照样能打开——打开看到的是几个月前的旧版页面。
#
# 所以给 content.py 的 RETIRED_SLUGS 里每个 slug 生成一个跳转页去盖住它。
# 页面刻意不用 bare_page()：它要立刻跳走，塞进整套站点头部、脚本、
# 云端 SDK 纯属浪费，而且万一本机断网、SDK 加载失败，反而更难跳。
# 所以做成自包含的最小页面，样式内联，配色跟站点保持一致。
# ---------------------------------------------------------------------------
RETIRED_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- 立刻跳到博客列表；noindex 让搜索引擎把这条旧地址清掉 -->
<meta http-equiv="refresh" content="0; url=__TO__">
<meta name="robots" content="noindex, nofollow">
<title>这篇文章搬走了 · __NAME__</title>
<style>
  body { margin: 0; padding: 56px 20px; background: #E8F5DC; color: #24420F;
         font: 15px/1.9 "Microsoft YaHei", "微软雅黑", sans-serif; text-align: center; }
  .box { max-width: 420px; margin: 0 auto; padding: 26px 22px;
         background: #F4FBEC; border: 2px solid #3B6B1E;
         box-shadow: 4px 4px 0 rgba(22, 48, 10, .3); }
  h1 { margin: 0 0 10px; font-size: 19px; letter-spacing: 1px; }
  p { margin: 0 0 8px; color: #595959; font-size: 13px; }
  a { color: #3E7B14; }
  .go { display: inline-block; margin-top: 12px; padding: 9px 22px;
        font-weight: 700; color: #16300A; background: #FFD400;
        border: 1px solid #16300A; box-shadow: 3px 3px 0 #16300A;
        text-decoration: none; }
</style>
</head>
<body>
  <div class="box">
    <h1>这篇文章搬走了</h1>
    <p>你要找的那一篇已经不在这里了，正在带你去博客列表。</p>
    <p>没有自动跳转的话，点下面这个。</p>
    <a class="go" href="__TO__">去博客列表</a>
  </div>
</body>
</html>
"""


def build_retired():
    """把线上残留的旧文章地址盖成跳转页。

    posts/index.html 也一并生成：python 的 http.server 对没有 index 的目录
    会直接把文件名列出来，那份目录列表不该被访客看到。
    """
    if not RETIRED_SLUGS:
        return
    for slug in RETIRED_SLUGS:
        write("posts/%s.html" % slug,
              RETIRED_PAGE.replace("__TO__", "../blog.html")
                           .replace("__NAME__", SITE["name"]))
    write("posts/index.html",
          RETIRED_PAGE.replace("__TO__", "../blog.html")
                      .replace("__NAME__", SITE["name"]))


# ---------------------------------------------------------------------------
# 静态资源版本号
#
# 部署是覆盖式的：文件名不变、内容变了，浏览器会继续拿缓存里的旧版。
# login.js 已经踩过一次 —— 线上明明是「邮箱 + 验证码」那一版，访客跑的
# 却还是上一版，点登录直接报一句英文的实现细节错误。
#
# 给引用加 ?v=<内容哈希前 8 位>：内容一变 URL 就变，缓存自然失效；
# 内容没变则 URL 不变，缓存照旧命中，不多一次请求。
_ASSET_V = {}

_ASSET_REF = re.compile(
    r'((?:href|src)=")((?:\.\./)*(?:style\.css|cloud-config\.js|feed\.js'
    r'|cloud\.js|admin\.js|login\.js|foot-stats\.js|owner-avatar\.js'
    r'|compose\.js|vendor/workbuddy-cloud\.global\.js))(")')


def _asset_version(rel):
    if rel not in _ASSET_V:
        try:
            with open(os.path.join(ROOT, rel), "rb") as f:
                _ASSET_V[rel] = hashlib.sha256(f.read()).hexdigest()[:8]
        except OSError:
            _ASSET_V[rel] = ""
    return _ASSET_V[rel]


_EMOJI_V = []


def emoji_version():
    """整包表情图共用一个版本号。

    表情是 JS 按 <key>.png 现拼 URL 的，不像 CSS/JS 那样能被 _ASSET_REF 抓到，
    所以换一张图的内容 URL 是不变的 —— 访客那边照旧吃旧缓存。
    这里把 assets/emoji/ 下所有图的内容合起来算一个哈希，
    由 site_data() 下发给前端，emo() 拼 URL 时带上。
    二十四张图一起算：反正加一张新图也是「这一套变了」，没必要按张分开。
    """
    if not _EMOJI_V:
        h = hashlib.sha256()
        d = os.path.join(ROOT, "assets", "emoji")
        try:
            names = sorted(n for n in os.listdir(d) if n.endswith(".png"))
        except OSError:
            names = []
        for n in names:
            h.update(n.encode("utf-8"))
            with open(os.path.join(d, n), "rb") as f:
                h.update(f.read())
        _EMOJI_V.append(h.hexdigest()[:8])
    return _EMOJI_V[0]


def stamp_assets(content):
    """把页面里对本站静态资源的引用改成带版本号的。"""
    def sub(m):
        raw = m.group(2)
        rel = raw.rsplit("../", 1)[-1]          # 剥掉 ../ 前缀，回到仓库根相对路径
        v = _asset_version(rel)
        return m.group(1) + raw + ("?v=" + v if v else "") + m.group(3)
    return _ASSET_REF.sub(sub, content)


def write(rel, content):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if rel.endswith(".html"):
        content = stamp_assets(content)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    print("  生成 %s" % rel)


def stamp_manual():
    """welcome.html 是手工维护的，不经过 write()，单独补一次资源版本号。"""
    p = os.path.join(ROOT, "welcome.html")
    if not os.path.isfile(p):
        return
    with open(p, encoding="utf-8") as f:
        src = f.read()
    out = stamp_assets(src)
    if out != src:
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(out)
        print("  更新 welcome.html 的资源版本号")


def main():
    print("构建 %s …" % SITE["name"])
    print("  公开 %d 篇 / 未公开 %d 篇 / 草稿 %d 篇 / 照片 %d 张"
          % (len(LISTED), len(UNLISTED), len(DRAFTS), len(PHOTOS)))
    for d in ("posts", "category"):
        p = os.path.join(ROOT, d)
        if os.path.isdir(p):
            shutil.rmtree(p)
    build_home()
    build_blog()
    build_projects()
    build_post()
    build_categories()
    build_archive()
    build_album()
    build_about()
    build_guestbook()
    build_share()
    build_admin()
    build_login()
    build_retired()
    stamp_manual()
    print("完成。")


if __name__ == "__main__":
    main()
