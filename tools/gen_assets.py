# -*- coding: utf-8 -*-
"""生成 Y2K 绿色版像素素材：中文像素标题 PNG + 像素画 + 站点二维码。

原理：把中文丢给系统字体渲染成 16px 位图，二值化成 0/1 点阵，
再用 NEAREST 放大 N 倍 —— 得到边缘硬朗、不带抗锯齿的像素字。
这样就不需要预先准备任何美术素材，加一个新栏目标题只要往 TITLES 里加一行。

用法：
    pip install pillow qrcode
    python tools/gen_assets.py

字体：默认用 Windows 的宋体（simsun.ttc）。换机器的话用环境变量指定：
    PIXEL_FONT=/System/Library/Fonts/Songti.ttc python tools/gen_assets.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

FONT = os.environ.get("PIXEL_FONT") or r"C:\Windows\Fonts\simsun.ttc"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(OUT, exist_ok=True)


def text_to_matrix(text, grid=16, threshold=128):
    font = ImageFont.truetype(FONT, grid, index=0)
    bbox = font.getbbox(text)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    img = Image.new("L", (w + 2, h + 2), 0)
    ImageDraw.Draw(img).text((1 - bbox[0], 1 - bbox[1]), text, font=font, fill=255)
    return [[1 if img.getpixel((x, y)) >= threshold else 0
             for x in range(img.width)] for y in range(img.height)]


def matrix_to_png(mat, scale, color, out_path, stroke=None):
    """stroke: 可选描边色 (hex)，在字形外圈加 1px 描边（放大前）。"""
    h, w = len(mat), len(mat[0])
    img = Image.new("RGBA", (w + 2, h + 2), (0, 0, 0, 0))
    px = img.load()

    def rgb(c):
        return (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255)

    if stroke:
        for y in range(h):
            for x in range(w):
                if mat[y][x]:
                    continue
                near = any(0 <= y + dy < h and 0 <= x + dx < w and mat[y + dy][x + dx]
                           for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)))
                if near:
                    px[x + 1, y + 1] = rgb(stroke)
    for y in range(h):
        for x in range(w):
            if mat[y][x]:
                px[x + 1, y + 1] = rgb(color)
    img.resize(((w + 2) * scale, (h + 2) * scale), Image.NEAREST).save(out_path)
    return out_path


TITLES = [
    # (文本, 网格, 倍数, 颜色, 描边, 文件名)
    ("欢迎光临", 16, 6, "#F2FFE4", "#1B3308", "t_welcome.png"),
    ("像素日常", 16, 3, "#E4F8CE", "#17300A", "t_sitename.png"),
    # 封面用的站名：倍数更大、颜色是深的（封面底色是浅绿，深字才看得清）
    ("像素日常", 16, 6, "#2F5D1A", None, "t_cover.png"),
    ("相册", 16, 3, "#FFFFFF", None, "t_album.png"),
    ("留言板", 16, 3, "#FFFFFF", None, "t_guest.png"),
    # —— 博客版 ——
    ("关于我", 16, 3, "#FFFFFF", None, "t_me.png"),
    ("文章分类", 16, 2, "#FFFFFF", None, "t_cat.png"),
    ("文章归档", 16, 2, "#FFFFFF", None, "t_arch.png"),
    ("最近互动", 16, 2, "#FFFFFF", None, "t_act.png"),
    ("友情链接", 16, 2, "#FFFFFF", None, "t_link.png"),
    ("评论", 16, 3, "#FFFFFF", None, "t_reply.png"),
    ("发表评论", 16, 2, "#FFFFFF", None, "t_pub.png"),
    ("发表留言", 16, 2, "#FFFFFF", None, "t_msg.png"),
    ("照片墙", 16, 2, "#FFFFFF", None, "t_wall.png"),
    # —— 章节页（封面目录里的每一章）——
    # 白字那套是给彩色标题栏用的；深绿这套（ch_*.png）给浅色背景的章节题头用。
    ("项目", 16, 3, "#FFFFFF", None, "t_project.png"),
    ("博客", 16, 3, "#FFFFFF", None, "t_blog.png"),
    ("关于", 16, 4, "#2F5D1A", None, "ch_about.png"),
    ("项目", 16, 4, "#2F5D1A", None, "ch_projects.png"),
    ("博客", 16, 4, "#2F5D1A", None, "ch_blog.png"),
    ("相册", 16, 4, "#2F5D1A", None, "ch_album.png"),
    ("留言板", 16, 4, "#2F5D1A", None, "ch_guestbook.png"),
    # —— 站长后台 / 分享页 ——
    ("站长登录", 16, 2, "#FFFFFF", None, "t_login.png"),
    ("认领站长", 16, 2, "#FFFFFF", None, "t_claim.png"),
    ("内容管理", 16, 2, "#FFFFFF", None, "t_manage.png"),
    # 「发表评论」那张（t_pub.png）别拿去当写文章的题头 —— 图上写的就是「发表评论」。
    ("写文章", 16, 2, "#FFFFFF", None, "t_write.png"),
    ("上传照片", 16, 2, "#FFFFFF", None, "t_upload.png"),
    # 账号页是站长和访客共用的，题头别写「站长登录」—— 访客看了会以为走错地方。
    ("我的账号", 16, 2, "#FFFFFF", None, "t_account.png"),
    ("私密内容", 16, 2, "#FFFFFF", None, "t_priv.png"),
    ("扫码打开", 16, 2, "#FFFFFF", None, "t_scan.png"),
    ("可以这么说", 16, 2, "#FFFFFF", None, "t_say.png"),
    ("朋友能做什么", 16, 2, "#FFFFFF", None, "t_do.png"),
]

for text, grid, scale, color, stroke, fname in TITLES:
    p = matrix_to_png(text_to_matrix(text, grid), scale, color,
                      os.path.join(OUT, fname), stroke=stroke)
    print("title:", text, "->", os.path.basename(p), Image.open(p).size)


# ---------------- 像素画：英雄图（深色底 + 像素爱心 + 星光）----------------
def draw_pixel_hero(path):
    U = 6                      # 每个像素单元的边长
    W, H = 92, 52              # 画布（单元数）
    img = Image.new("RGBA", (W * U, H * U), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, W * U - 1, H * U - 1], fill="#12260A")

    def plot(x, y, color, n=1):
        d.rectangle([x * U, y * U, (x + n) * U - 1, (y + n) * U - 1], fill=color)

    GREEN = "#8EC759"
    GREEN_D = "#4C8C1F"
    GREEN_L = "#B6E27F"
    YELLOW = "#FFD400"

    heart = [
        ".XXX...XXX.",
        "XXXXX.XXXXX",
        "XXXXXXXXXXX",
        "XXXXXXXXXXX",
        "XXXXXXXXXXX",
        ".XXXXXXXXX.",
        "..XXXXXXX..",
        "...XXXXX...",
        "....XXX....",
        ".....X.....",
    ]
    ox, oy = 40, 17
    for j, row in enumerate(heart):
        for i, c in enumerate(row):
            if c == "X":
                plot(ox + i, oy + j, GREEN)
    # 左上高光
    for i, j in ((3, 1), (4, 1), (3, 2), (4, 2)):
        plot(ox + i, oy + j, GREEN_L)
    # 右下暗部
    for i, j in ((7, 7), (8, 7), (7, 8), (8, 8), (9, 5), (9, 6)):
        plot(ox + i, oy + j, GREEN_D)
    # 底部尖角
    plot(ox + 5, oy + 10, GREEN_D)

    def star(cx, cy, color):
        plot(cx, cy, color)
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            plot(cx + dx, cy + dy, color)
        for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            plot(cx + dx, cy + dy, color)

    for cx, cy in ((16, 10), (26, 30), (68, 34)):
        star(cx, cy, YELLOW)
    for cx, cy in ((78, 8), (8, 40), (46, 44)):
        star(cx, cy, GREEN_L)

    img.save(path)
    print("hero ->", os.path.basename(path), img.size)


draw_pixel_hero(os.path.join(OUT, "hero.png"))


# ---------------- 像素爱心（页脚小装饰）----------------
def draw_heart(path, color="#8EC759", shade="#4C8C1F", scale=5):
    heart = [
        ".XX.XX.",
        "XXXXXXX",
        "XXXXXXX",
        ".XXXXX.",
        "..XXX..",
        "...X...",
    ]
    h, w = len(heart), len(heart[0])
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()

    def rgb(c):
        return (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255)

    for y in range(h):
        for x in range(w):
            if heart[y][x] == "X":
                # 左下暗部
                px[x, y] = rgb(shade) if (x + y) >= 9 else rgb(color)
    img.resize((w * scale, h * scale), Image.NEAREST).save(path)
    return path


for i, c in enumerate(["#8EC759", "#B6E27F", "#FFD400"]):
    p = draw_heart(os.path.join(OUT, f"heart{i}.png"), color=c, shade="#3E7B14")
    print("heart ->", os.path.basename(p))

# ---------------- 像素小树（装饰）----------------
def draw_sprout(path, scale=6):
    W, H = 9, 9
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    D = ImageDraw.Draw(img)
    A = "#8EC759"
    B = "#4C8C1F"
    C = "#FFD400"
    pts = {
        (4, 0): C, (4, 1): A, (3, 2): A, (4, 2): A, (5, 2): B,
        (2, 3): A, (3, 3): A, (4, 3): A, (5, 3): B, (6, 3): B,
        (1, 4): B, (2, 4): A, (3, 4): A, (4, 4): A, (5, 4): B, (6, 4): B, (7, 4): B,
        (1, 5): B, (2, 5): B, (3, 5): A, (4, 5): A, (5, 5): B, (6, 5): B, (7, 5): B,
        (2, 6): B, (3, 6): B, (4, 6): B, (5, 6): B, (6, 6): B,
        (4, 7): "#7A4A18", (4, 8): "#7A4A18",
    }
    for (x, y), c in pts.items():
        D.rectangle([x, y, x, y], fill=c)
    img.resize((W * scale, H * scale), Image.NEAREST).save(path)
    return path


draw_sprout(os.path.join(OUT, "sprout.png"))


# ---------------- 像素头像（关于我） ----------------
def draw_avatar(path, scale=6):
    H = "#2F5D1A"   # 头发 · 深绿
    S = "#FFE0C0"   # 肤色
    E = "#24420F"   # 眼睛
    M = "#FF6B35"   # 嘴 · 暖橙
    C = "#8EC759"   # 衣领 · 亮绿
    BG = "#DFF5C8"  # 背景 · 浅绿
    rows = [
        "....HHHHHH....",
        "..HHHHHHHHHH..",
        ".HHHHHHHHHHHH.",
        ".HHSSSSSSSSHH.",
        ".HSSSSSSSSSSH.",
        ".HSSEESSEESSH.",
        ".HSSEESSEESSH.",
        ".HSSSSSSSSSSH.",
        ".HSSSMMMMSSSH.",
        "..SSSMMMMSSS..",
        "..SSSSSSSSSS..",
        "...SSSSSSSS...",
        ".CCCCCCCCCCCC.",
        "CCCCCCCCCCCCCC",
    ]
    h, w = len(rows), len(rows[0])
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()

    def rgb(c):
        return (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255)

    pal = {"H": H, "S": S, "E": E, "M": M, "C": C}
    for y in range(h):
        for x in range(w):
            ch = rows[y][x]
            px[x, y] = rgb(pal[ch]) if ch in pal else rgb(BG)
    img.resize((w * scale, h * scale), Image.NEAREST).save(path)
    return path


draw_avatar(os.path.join(OUT, "avatar.png"))


# ---------------- 项目插图 ----------------
# 用字符网格画像素画：一个字符一个像素，NEAREST 放大，边缘天然是硬的。
# '.' 表示透明，其余字符查 palette。加一个新项目的插图只要再写一份网格。
def draw_grid(path, rows, palette, scale=8):
    width = max(len(r) for r in rows)
    rows = [r.ljust(width, ".") for r in rows]
    h = len(rows)
    img = Image.new("RGBA", (width, h), (0, 0, 0, 0))
    px = img.load()

    def rgb(c):
        return (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255)

    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in palette:
                px[x, y] = rgb(palette[ch])
    img.resize((width * scale, h * scale), Image.NEAREST).save(path)
    print("art ->", os.path.basename(path), img.size)
    return path


# 房子：给「Love & Forever 看房管理」用。
# 深绿屋顶 + 米白墙 + 绿门，左上角一点橙色小心。
HOUSE_PAL = {
    "R": "#2F5D1A", "r": "#4C8C1F",          # 屋顶 深 / 亮
    "W": "#F2FFE4", "w": "#D6EBB8",          # 墙面 亮 / 暗
    "G": "#B6E27F", "g": "#7CBF3F",          # 窗玻璃 / 窗框
    "D": "#2F5D1A", "d": "#1B3308",          # 门 / 门把手
    "F": "#3E7B14",                          # 地基
    "X": "#FF6B35",                          # 小心（点缀色）
}
HOUSE = [
    "..XX.XX.................",
    ".XXXXXXX..RRRR..........",
    "..XXXXX..RRRRRR.........",
    "...XXX..RRrrrrRR........",
    ".......RRrrrrrrRR.......",
    "......RRrrrrrrrrRR......",
    ".....RRrrrrrrrrrrRR.....",
    "....RRrrrrrrrrrrrrRR....",
    "...RRRRRRRRRRRRRRRRRR...",
    "...WWWWWWWWWWWWWWWWWW...",
    "...WwwwwWWWWWWWWwwwwW...",
    "...WwGGwWWWWWWWWwGGwW...",
    "...WwGGwWWWWWWWWwGGwW...",
    "...WwggwWWWWWWWWwggwW...",
    "...WwwwwWWWWWWWWwwwwW...",
    "...WwwwwWWDDDDWWwwwwW...",
    "...WwwwwWWDDdDWWwwwwW...",
    "...WwwwwWWDDDDWWwwwwW...",
    "...WwwwwWWDDDDWWwwwwW...",
    "...WWWWWWWWWWWWWWWWWW...",
    "...FFFFFFFFFFFFFFFFFF...",
    "........................",
]

# 显示器：给「像素日常」这个博客项目用。
MONITOR_PAL = {
    "F": "#2F5D1A",           # 机壳
    "S": "#12260A",           # 屏幕底色
    "T": "#8EC759",           # 文字
    "A": "#FFD400",           # 标题条
    "f": "#4C8C1F", "B": "#3E7B14",   # 支架 / 底座
}
MONITOR = [
    "........................",
    "........................",
    "....FFFFFFFFFFFFFFFF....",
    "....FSSSSSSSSSSSSSSF....",
    "....FSAAAAAAAAAAAASF....",
    "....FSSSSSSSSSSSSSSF....",
    "....FSTTTTTTTTTTTTSF....",
    "....FSTTTTTSSSSSSSSF....",
    "....FSTTTTTTTTTTTTSF....",
    "....FSTTTTSSSSSSSSSF....",
    "....FSTTTTTTTTTTTTSF....",
    "....FSTTTTTSSSSSSSSF....",
    "....FSSSSSSSSSSSSSSF....",
    "....FFFFFFFFFFFFFFFF....",
    ".........FFFFFF.........",
    ".........FFFFFF.........",
    "........FFFFFFFF........",
    "......FFFFFFFFFFFF......",
    "....FFFFFFFFFFFFFFFF....",
    "........................",
    "........................",
    "........................",
]

draw_grid(os.path.join(OUT, "proj_house.png"), HOUSE, HOUSE_PAL)
draw_grid(os.path.join(OUT, "proj_blog.png"), MONITOR, MONITOR_PAL)


# ---------------- 站点二维码（分享页用） ----------------
def draw_qr(path, url, box=6, border=3):
    """生成二维码 PNG。前景用最深的绿，保证手机能扫出来。"""
    import qrcode
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=box,
        border=border,
    )
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#24420F", back_color="#FFFFFF").convert("RGB")
    img.save(path)
    print("qr ->", os.path.basename(path), img.size, "|", url)
    return path


draw_qr(os.path.join(OUT, "qr_site.png"), "https://pixel-daily-blog.app.workbuddy.host/")
print("done")
