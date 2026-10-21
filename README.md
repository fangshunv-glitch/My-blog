# 像素日常 · Pixel Daily

> 把日子过成一格一格的像素。

一个 2000 年代 Y2K 复古风格的个人博客 —— 跑马灯、访客计数器、断层色带、像素中文字标题，但底下是一套干净的静态站点生成器和真实的云端留言系统。

线上地址：**https://pixel-daily-blog.app.workbuddy.host**

---

## 目录

- [项目简介](#项目简介)
- [章节与目录](#章节与目录)
- [功能一览](#功能一览)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [写一篇文章](#写一篇文章)
- [写一个项目](#写一个项目)
- [云端互动](#账号与云端互动)
- [站长后台](#站长后台)
- [可见性模型](#可见性模型)
- [部署](#部署)
- [设计说明](#设计说明)
- [许可](#许可)

---

## 项目简介

这是一个**纯静态**的个人博客。没有框架、没有构建工具链、没有 `node_modules`，整站由两个 Python 文件驱动：

- `content.py` —— 全站唯一需要手改的文件，文章、分类、站点信息、静态兜底数据都写在这里；
- `build.py` —— 读 `content.py`，生成所有 HTML 页面。

生成结果是普通 HTML/CSS/JS，任何静态托管都能直接跑。留言板和文章评论走云端数据库：浏览不用登录，发言时用一个邮箱验证码登一下，每句话都挂在自己的账号上。站长另有独立后台管理内容。

设计上刻意做了两件事：

1. **复古皮 + 现代骨**。视觉全部由 Pillow 现场生成的像素素材和手写 CSS 拼出来，不依赖任何美术资源；结构上则是语义化 HTML 加响应式布局。
2. **无 JS 也能看**。页面里的内容是构建时生成的静态兜底，JS 拿到云端数据后整块替换；断网、脚本加载失败时页面照常可读。

首页是一屏**封面**，不做信息流：站名 + 一句题记 + 点线目录，只回答「这儿有什么、点哪儿进去」。全站按「章」组织，每一章有汉字编号（壹 关于 / 贰 项目 / 叁 博客 / 肆 相册 / 伍 留言板），每个章节页顶部都有章题头。文章列表在 `blog.html`，也就是「叁 博客」那一章。

---

## 章节与目录

全站结构由 `content.py` 里的一张表驱动：

```python
CHAPTERS = [
    ("about",     "壹", "关于",   "about.html",     "ABOUT",     "我是谁，以及这个博客怎么来的"),
    ("projects",  "贰", "项目",   "projects.html",  "PROJECTS",  "真正动手做过的东西"),
    ("blog",      "叁", "博客",   "blog.html",      "BLOG",      "日常、照片、数码，和建站本身"),
    ("album",     "肆", "相册",   "album.html",     "ALBUM",     "全站照片索引"),
    ("guestbook", "伍", "留言板", "guestbook.html", "GUESTBOOK", "打招呼、换友链、找站长"),
]
```

这一张表同时生成三处东西，所以永远不会有对不上的地方：

| 位置 | 长什么样 |
| --- | --- |
| 封面上的目录 | `关于 …………… 壹`，点线连到编号 |
| 各章节页顶部 | `← 回到封面` + `壹` + 像素字章名 + 英文名 + 一句话 |
| 页脚 | 同一份目录，小一号 |

**加一章**：往 `CHAPTERS` 里加一行，再在 `build.py` 里加一个对应的 `build_xxx()`，并在 `main()` 里调用。章名图片按 `assets/ch_<key>.png` 的规则取，往 `tools/gen_assets.py` 的 `TITLES` 里加一行生成即可。

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 封面首页 | 一屏封面：像素字站名 + 题记 + 点线目录，不做信息流 |
| 章节题头 | 每个章节页顶部的「编号 + 像素章名 + 英文名 + 一句话」 |
| 项目 | 一条一条排的作品清单：像素插图 + 类型标签 + 一句话说明 + 要点 + 链接 |
| 博客 | 文章列表 + 分页（每页 5 篇），置顶文章单独呈现，即原来的首页 |
| 文章详情 | Markdown 渲染，支持「最后更新于」提示、标签、文内照片 |
| 分类 | 每篇只归一个；分类名单由站长在后台「分类」里自己增删改，存在云端，改完即时生效 |
| 归档 | 按年月分组的时间线 |
| 相册 | 全站照片索引，按相册分栏看；发帖时顺带传的照片统一进「博客相册」 |
| 关于 | 站长名片页 |
| 留言板 | 云端存储，**登录后**留言，展示昵称来自账号 |
| 文章评论 | 每篇文章独立的云端评论区，同样需要登录 |
| 访客账号 | 邮箱 + 验证码登录/注册，首次登录时取一个全站唯一的昵称 |
| 最近互动 | 侧边栏实时拉取最新留言与评论 |
| 分享页 | 手机扫码打开 + 一键复制链接，教朋友怎么用 |
| 复古欢迎页 | `welcome.html`，纯 2000 年代风格的入口彩蛋 |
| 站长后台 | 邮箱验证码登录，管理留言 / 评论 / 私密内容 |
| 可见性分级 | `public` / `unlisted` / 云端私密，三档内容控制 |
| 移动端自适应 | 手机上自动切换单栏布局，输入框按 16px 起排避免 iOS 缩放 |
| 站点计数 | 页脚显示「开站第 N 天」 |

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 页面 | 手写 HTML5 + CSS3 + 原生 JavaScript（无框架、无打包） |
| 生成器 | Python 3（标准库 `html` / `json` / `re` / `datetime`） |
| 素材 | Pillow（中文点阵像素字）+ qrcode（站点二维码） |
| 后端 | WorkBuddy Cloud —— PostgreSQL + 行级安全策略（RLS）+ 邮箱认证 |
| 字体 | Google Fonts `Press Start 2P`（英文像素字）+ 系统字体（正文） |

---

## 目录结构

```
.
├── README.md
├── content.py              # ★ 全站唯一需要手改的内容源
├── build.py                # 静态页面生成器
├── index.html              # ↓ 以下均为 build.py 生成，勿手改
├── blog.html               #   博客（文章列表）
├── projects.html           #   项目
├── about.html
├── album.html
├── archive.html
├── guestbook.html
├── share.html
├── admin.html              # 站长后台页面
├── login.html              # 访客账号页（登录 / 注册 / 取昵称）
├── posts/                  # 文章详情页
├── category.html           # 分类列表页（?c=<slug>，分类由后台维护）
├── category/               # 旧分类地址的跳转页（daily/photo/… 指向 category.html）
├── welcome.html            # 复古欢迎页（唯一手工维护的页面）
├── cloud.js                # 访客侧：留言与评论的读写
├── login.js                # 访客侧：认证与昵称
├── admin.js                # 站长侧：内容管理
├── cloud-config.js         # 云端连接配置（公开键）
├── style.css               # 全站样式
├── assets/                 # 像素素材 PNG（含 ch_*.png 章节名、proj_*.png 项目插图）
├── vendor/
│   └── workbuddy-cloud.global.js   # 自托管的云服务 SDK
└── tools/
    └── gen_assets.py       # 像素素材生成脚本
```

> 除 `welcome.html` 与 `style.css` / `*.js` / `tools/` 之外，根目录的 `.html` 与 `posts/`、`category/` 都是**生成产物**，改了会在下次构建时被覆盖。要改内容请改 `content.py`。

---

## 快速开始

### 只看效果

不需要任何环境。克隆后直接用浏览器打开 `index.html` 即可 —— 静态兜底内容足够浏览全站。

```bash
git clone https://github.com/fangshunv-glitch/My-blog.git
cd My-blog
```

想看得更真一点，起个本地服务（云端模块需要 http/https 协议，`file://` 下会被浏览器拦截）：

```bash
python -m http.server 8000
# 然后访问 http://localhost:8000
```

### 改内容后重新生成

```bash
python build.py
```

### 重新生成像素素材（可选）

素材已经提交在 `assets/`，只有想改配色或加新栏目标题时才需要跑：

```bash
pip install pillow qrcode
python tools/gen_assets.py
```

脚本默认用 Windows 的宋体（`C:\Windows\Fonts\simsun.ttc`）渲染点阵。其他系统用环境变量指定字体：

```bash
PIXEL_FONT=/System/Library/Fonts/Songti.ttc python tools/gen_assets.py
```

---

## 写一篇文章

打开 `content.py`，往 `POSTS` 列表里加一个字典：

```python
{
    "slug": "qiu-tian-naicha",          # 文章地址，发布后别再改
    "title": "秋天的第一杯热奶茶",
    "date": "2026-09-28",               # 首次发布，决定排序与归档
    "updated": "2026-09-29 10:20",      # 可选，与 date 不同会显示「最后更新于」
    "category": "日常",                  # 主分类，填后台「分类」里建过的名字
    "tags": ["奶茶", "随笔"],            # 主题标签，可以多个
    "featured": False,                  # True 则首页置顶
    "visibility": "public",             # 见下方「可见性模型」
    "photos": [],                       # 文内照片
    "excerpt": "摘要，显示在列表页。",
    "body": """
正文写 Markdown 就行。支持粗体、*斜体*、[链接](https://example.com)、
`行内代码`、图片和 > 引用。
""",
}
```

存盘后跑 `python build.py`，页面就更新了。

**其他字段速查**

| 字段 | 作用 |
| --- | --- |
| `draft` | `True` 则不生成页面、不进任何列表 |
| `featured` | `True` 则首页置顶，但不打乱原有时间顺序 |
| `updated` | 有值且与 `date` 不同时，页面显示「最后更新于」 |
| `visibility` | 见 [可见性模型](#可见性模型) |
| `photos` | `{"id": "PIC 01", "cap": "说明", "date": "2026-09-21"}`，单张也可设 `visibility` |

**新开一个分类**：不用改代码，也不用重新构建 —— 登录后台，在「分类」页签里加一行就行。
分类存在云端 `categories` 表，前台分类页是 `category.html?c=<slug>` 现读现筛，
所以加完立刻生效。改名时，原来挂在这个分类下的文章会自动跟着搬过去；
下面还有文章的分类不允许删，先把它们改成别的分类。

---

## 写一个项目

项目写在 `content.py` 的 `PROJECTS` 列表里：

```python
{
    "name": "Love & Forever",
    "kind": "网页工具",                  # 类型标签，一两个词
    "year": "2026",
    "status": "在用",
    "desc": "一句话说清楚它是干什么的 —— 最重要的一行，别超过两句",
    "points": [                          # 3~4 条要点，每条一句话
        "筛选条件自己配：预算、通勤、户型、面积都能设",
        "数据只存在这台电脑的浏览器里，不上传任何服务器",
    ],
    "stack": ["HTML", "原生 JS", "localStorage"],
    "links": [                           # 第一个会渲染成主按钮
        ("查看项目", "https://github.com/..."),
    ],
    "art": "proj_house.png",             # 插图，放 assets/ 里
},
```

**插图**：在 `tools/gen_assets.py` 里用字符网格画 —— 一个字符一个像素，`NEAREST` 放大，边缘天然是硬的：

```python
HOUSE_PAL = {"R": "#2F5D1A", "W": "#F2FFE4", "X": "#FF6B35"}
HOUSE = [
    "..XX.XX...RRRR..........",
    ".XXXXXXX..RRRRRR........",
    # ... 一行一个像素行，'.' 表示透明
]
draw_grid(os.path.join(OUT, "proj_house.png"), HOUSE, HOUSE_PAL)
```

页首那句大字由 `PROJECTS_LEDE` 控制，下面的说明是 `PROJECTS_INTRO`（可写 Markdown），末尾一句是 `PROJECTS_NOTE`（留空则不显示）。

---

## 账号与云端互动

留言板和文章评论存在云端 PostgreSQL 里，由**数据库的 RLS 策略**裁决权限，前端不做任何权限判断 —— 就算有人绕过界面直接调接口，该拒的一样会被拒。

**浏览永远不需要登录**，只有发言需要。访客用邮箱验证码就能登进来，不用单独走一遍注册流程。

### 身份怎么落到留言上

发言时客户端**只发内容**，`uid` 和昵称都不传 —— 它们由数据库填：

```sql
uid  TEXT DEFAULT auth.uid()                  -- 数据库自己认人
name TEXT DEFAULT public.pixel_display_name() -- 从 profiles 取当前昵称
```

行级策略再核对一遍：

```sql
CREATE POLICY guestbook_insert ON guestbook FOR INSERT TO authenticated
  WITH CHECK (uid = auth.uid()
    AND name = public.pixel_display_name()
    AND status = 'published'
    AND char_length(btrim(content)) BETWEEN 1 AND 800)
```

这样写的好处是**伪造不出来**：客户端硬塞一个别人的 uid，会被 `uid = auth.uid()` 拒掉；硬塞「站长」当昵称，会被 `name = pixel_display_name()` 拒掉。前端因此不需要、也不应该去「算出」自己的 uid —— 那正是上一版出问题的地方。

### 涉及的表

| 表 | 用途 | 谁可读 |
| --- | --- | --- |
| `profiles` | uid ↔ 昵称，昵称全站唯一 | 只有本人 |
| `guestbook` | 留言板 | 所有人（`status = 'published'`） |
| `post_comments` | 文章评论 | 所有人（`status = 'published'`） |
| `site_admins` | 站长白名单 | 只有本人那一行 |
| `private_posts` | 只有站长能看的私密内容 | 只有站长 |
| `site_events` | 认领 / 登录的诊断日志 | 客户端完全不可见 |

### 几个关键取舍

- **昵称快照在留言行上**（`name` 列），不靠联表取。好处是读列表不用 join；代价是改了昵称之后，以前发过的留言保持当时的名字 —— 这是刻意的，翻旧帖时不会出现「名字对不上人」。
- **`profiles` 只放行本人那一行**。既然昵称快照已经在留言行上，公开读整张表就没有必要了，还会把全站用户名单暴露出去。
- **站长身份走数据库函数** `pixel_claim_admin()`（`SECURITY DEFINER`），内部用 `auth.uid()` 判定，不信任前端传来的任何 uid。
- **`TRUNCATE` 不受 RLS 约束**，所以建表后额外 `REVOKE` 掉了。
- **列级授权在这个环境里不可靠** —— 实测 `select('*')` 会把所有列一起返回。所以敏感字段一律独立表 + 访客零权限，不要指望 `GRANT SELECT (col)` 挡得住。

### 连接配置

连接参数写在 `cloud-config.js`：

```js
window.PIXEL_CLOUD_CONFIG = {
  endpoint: 'https://pixel-daily-blog.app.workbuddy.host',
  publishableKey: 'wbpk_...'   // 公开键，可以放在前端
};
```

`publishableKey` 是公开键，放在前端是设计如此 —— 权限由 RLS 兜底，不是靠藏 key。

### 为什么 SDK 是本地自托管的

`vendor/workbuddy-cloud.global.js` 是自行托管的 SDK 副本。早先引用 CDN 时，国内网络下 jsdelivr 拉不起来，页面会**空白 11 秒**才降级。本地化之后首屏降到 500ms 左右，也不再有不稳定因素。

---

## 站长后台

地址：`admin.html`（页面底部有入口）

- **登录**：邮箱 + 验证码，仅支持邮箱（Web 应用不支持手机号 / 微信登录，这是平台边界）。忘记密码同样走验证码重设。
- **认领站长**：首次部署时，第一个用站长邮箱登录的人执行一次认领，之后白名单里就有了这个名字。
- **内容管理**：回复 / 隐藏 / 删除留言与评论。
- **私密内容**：在线撰写只有站长本人能读的内容，存在 `private_posts` 表 —— 数据库层面就只放行站长一个人，访客连数据都取不到。

> 浏览本站**永远不需要登录**。后台只是站长的入口，对浏览没有任何影响。

---

## 可见性模型

三档，按内容存在哪里区分：

| 值 | 存在哪 | 谁能看 | 进不进列表 / 计数 |
| --- | --- | --- | --- |
| `public` | `content.py` | 所有人 | 进 |
| `unlisted` | `content.py` | 拿到链接的人 | **不进**（首页、分类、归档、相册、计数都排除） |
| 私密 | 云端 `private_posts` | 只有站长 | 走后台，不参与静态构建 |

`unlisted` 用来做「只想发给某个人」的内容 —— 页面照样生成，链接能打开，但不对外暴露。照片也可以单张设 `unlisted`：不出现在相册索引里，但仍然出现在它所属的文章里。

**为什么不支持在 `content.py` 里写「只有站长能看」的文章？** 因为静态页面一旦发布就没法收回 —— 文件已经在服务器上了。真正的私密内容必须在数据库层面控制，所以放到后台在线写。

---

## 部署

生成结果是纯静态文件，丢到任何静态托管上都能跑：

- **GitHub Pages** —— Settings → Pages → Source 选 `main` 分支根目录即可
- **Cloudflare Pages / Netlify / Vercel** —— 构建命令留空，输出目录填 `/`
- **自己的服务器** —— 把整个目录扔进 Nginx 的 `root` 就行

唯一需要改的是 `content.py` 里的 `SITE["url"]` 和 `cloud-config.js` 里的 `endpoint`，换成你自己的域名。

---

## 设计说明

**配色** —— 以「深林绿 + 荧光绿」为主，暖橙做点缀：

| 用途 | 色值 |
| --- | --- |
| 主色 · 深林绿 | `#2F5D1A` |
| 亮色 · 荧光绿 | `#8EC759` |
| 高光 | `#B6E27F` |
| 点缀 · 暖橙 | `#FF6B35` |
| 深底 | `#12260A` |

**像素中文字怎么来的** —— 系统没有现成的中文像素字体，所以反过来做：把文字交给宋体渲染成 16px 位图，按阈值二值化成 0/1 点阵，再用 `NEAREST` 放大 6 倍。得到的边缘硬朗、不带抗锯齿。好处是加一个新栏目标题只要往 `tools/gen_assets.py` 的 `TITLES` 里加一行，不需要任何美术资源。站名（`t_cover.png`）、章节名（`ch_*.png`）、栏目标题（`t_*.png`）都是这么来的。

**项目插图同理**，但换了个更直接的做法：直接写字符网格（一个字符一个像素），`draw_grid()` 负责上色和放大。房子和显示器各 24×22 格，加一个新插图就是再写一份网格。

**结构参考** —— 封面首页、章节编号、点线目录、项目列表的排布方式参考了 [lennney.com](https://lennney.com/zh)（一本「书」式的个人站：首页只做目录，每一章有汉字编号，各章顶部有题头）。借的是**结构**，不是皮 —— 米色纸张 + 衬线字那套没有搬，视觉仍然走本站的绿色像素风。

**关于响应式** —— 手机上切换为单栏，导航折叠；密码/邮箱输入框字号强制 `16px` 以上，避免 iOS Safari 聚焦时把页面自动放大。另外修复过一个坑：`.btn { display: inline-block }` 会覆盖 `[hidden]` 的默认样式，导致两个登录按钮同时出现，所以补了 `[hidden] { display: none !important }`。

---

## 许可

个人项目，代码可自由参考。文中的文章、照片与「清羽墨染」这一身份均为示例内容。
