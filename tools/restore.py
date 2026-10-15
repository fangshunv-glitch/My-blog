#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
像素日常 · 从本地备份恢复云端内容
==================================

backup.py 解决「东西还在不在」，这个脚本解决「东西怎么塞回去」。

它**只读本地、完全不联网**：把 历史/<日期>/ 里的快照，加上 照片库/ 里的
原图，拼成一份标准 SQL。你在数据库控制台粘贴执行，或者让 WorkBuddy 代执行。
跑一百遍也不会碰线上一个字。

为什么生成 SQL，而不是直接写回云端
----------------------------------
写云端要绕过行级安全（RLS），那就得再开一个**带写权限**的密钥通道。
只读通道已经有一个了；再配一把能改数据的钥匙，风险跟收益不成比例。
生成 SQL 交给有权限的一方执行，攻击面一点不增加。

恢复出来是什么样
----------------
- **主键 id 原样保留**（OVERRIDING SYSTEM VALUE），身份不变。
  评论挂在 post_slug 上（文本键）而不是 id，所以就算 id 变了也不会串。
- **owner_id / uid 按备份里的原值写回**，不会变成「执行这条 SQL 的人」。
  否则内容归属就跑到别人名下，你自己反而改不动了。
- 大图和缩略图都从 照片库/ 取回，两张都写；只写大图的话列表页会变重。
- 目标是「塞回去」而不是「覆盖」：撞上已存在的行就跳过
  （ON CONFLICT DO NOTHING），报告里会点出来跳过了多少。
- 日期、可见范围、置顶、排序、站长邮箱，一个不少。
- 末尾会修正自增序列，免得恢复之后新写的内容撞主键。

用法
----
  python tools/restore.py                 用最近一期快照，生成 恢复.sql
  python tools/restore.py --list          看看有哪些日期的快照可用
  python tools/restore.py --date 2026-10-15
  python tools/restore.py --only posts,photos       只恢复这两类
  python tools/restore.py --slug mianguan          只恢复这一篇（连带它的评论和照片）
  python tools/restore.py --out D:/恢复.sql
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = Path(__file__).resolve().parent          # pixel-daily/tools
PROJECT = HERE.parent                            # pixel-daily
DEFAULT_ROOT = PROJECT.parent / "备份"            # 个人博客/备份

MIME = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "gif": "image/gif",
}

TABLE_CN = {
    "site_admins": "站长名单",
    "profiles": "访客资料",
    "posts": "文章",
    "photos": "照片",
    "post_comments": "文章评论",
    "guestbook": "留言板",
    "site_events": "站点事件",
    "private_posts": "遗留私密表",
}

# 这六张表的 id 是 GENERATED ALWAYS AS IDENTITY —— 想写回原 id 必须
# 加 OVERRIDING SYSTEM VALUE，否则报「cannot insert into column id」。
IDENTITY_TABLES = {"posts", "photos", "post_comments", "guestbook",
                   "site_events", "private_posts"}

# 恢复顺序：先保证「能进后台」，再轮到内容本身
ORDER = ["site_admins", "profiles", "posts", "photos",
         "post_comments", "guestbook", "site_events", "private_posts"]

ALL_KINDS = ["posts", "photos", "comments", "guestbook",
             "profiles", "admins", "events", "legacy"]

KIND_TO_TABLE = {
    "posts": "posts", "photos": "photos", "comments": "post_comments",
    "guestbook": "guestbook", "profiles": "profiles", "admins": "site_admins",
    "events": "site_events", "legacy": "private_posts",
}


def say(*a):
    print(*a)


def die(msg, code=2):
    say("")
    say("  [!] %s" % msg)
    raise SystemExit(code)


# ---------------------------------------------------------------------------
# 读快照
# ---------------------------------------------------------------------------
def read_json(path: Path, default=None):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        die("读不了 %s：%s" % (path, e))


def list_snapshots(root: Path):
    d = root / "历史"
    if not d.exists():
        return []
    return sorted([p.name for p in d.iterdir()
                   if p.is_dir() and (p / "文章.json").exists()], reverse=True)


def load_snapshot(root: Path, day: str):
    d = root / "历史" / day
    meta = read_json(d / "其他内容.json", {}) or {}
    return {
        "day": day,
        "posts": read_json(d / "文章.json", []) or [],
        "photos": read_json(d / "照片.json", []) or [],
        "post_comments": meta.get("post_comments") or [],
        "guestbook": meta.get("guestbook") or [],
        "profiles": meta.get("profiles") or [],
        "site_admins": meta.get("site_admins") or [],
        "site_events": meta.get("site_events") or [],
        "private_posts": read_json(d / "遗留私密表.json", []) or [],
    }


# ---------------------------------------------------------------------------
# 从照片库取原图
# ---------------------------------------------------------------------------
def find_blob(root: Path, sha: str, ext_hint: str, kind: str):
    """按指纹把原图从 照片库/<kind>/ 里捞回来。返回 (bytes, 扩展名)。"""
    if not sha:
        return None, ""
    d = root / "照片库" / kind
    if not d.exists():
        return None, ""
    pats = [sha[:16] + "." + ext_hint] if ext_hint else []
    pats.append(sha[:16] + ".*")
    for pat in pats:
        for f in sorted(d.glob(pat)):
            b = f.read_bytes()
            # 指纹对得上才用。宁可少一张，也不能拿错图 —— 照片张冠李戴
            # 比丢照片更难发现。老快照只记了 16 位前缀，这时没法复核。
            if len(sha) >= 64 and hashlib.sha256(b).hexdigest() != sha:
                continue
            return b, f.suffix.lstrip(".").lower()
    return None, ""


def data_url(blob: bytes, ext: str) -> str:
    mime = MIME.get((ext or "jpg").lower(), "image/jpeg")
    return "data:%s;base64,%s" % (mime, base64.b64encode(blob).decode("ascii"))


# ---------------------------------------------------------------------------
# SQL 字面量
# ---------------------------------------------------------------------------
def q(v):
    """文本 / 日期 / 时间戳 —— 一律当字符串字面量，交给 PostgreSQL 隐式转换。

    单引号翻倍是唯一的转义。base64 的字符集是 A-Za-z0-9+/=，不含单引号；
    但正文、说明、留言这类字段里什么都可能有。反斜杠不用管，
    PostgreSQL 默认 standard_conforming_strings=on。
    """
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def n(v):
    if v is None or v == "":
        return "NULL"
    try:
        return str(int(v))
    except (TypeError, ValueError):
        return "NULL"


def truth(v):
    return "TRUE" if v else "FALSE"


# ---------------------------------------------------------------------------
# 逐表渲染
# ---------------------------------------------------------------------------
def rows_posts(posts):
    cols = ["id", "owner_id", "owner_name", "slug", "title", "excerpt", "body",
            "category", "tags", "visibility", "featured", "published_on",
            "created_at", "updated_at"]
    out = []
    for p in posts:
        out.append([
            n(p.get("id")), q(p.get("owner_id")), q(p.get("owner_name")),
            q(p.get("slug")), q(p.get("title")), q(p.get("excerpt") or ""),
            q(p.get("body") or ""), q(p.get("category") or "日常"),
            q(p.get("tags") or ""), q(p.get("visibility") or "draft"),
            truth(p.get("featured")),
            q((p.get("published_on") or "")[:10] or None),
            q(p.get("created_at")), q(p.get("updated_at")),
        ])
    return cols, out


def rows_photos(root: Path, photos, missing_big, missing_thumb):
    cols = ["id", "owner_id", "owner_name", "album", "post_slug", "caption",
            "taken_on", "visibility", "sort", "thumb_data", "image_data",
            "width", "height", "created_at"]
    out = []
    for ph in photos:
        pid = ph.get("id")
        # 新快照记「大图 sha256」，早期版本只记截断的「sha256」
        sha = ph.get("大图 sha256") or ph.get("sha256") or ""
        bext = ph.get("大图扩展名") or ""
        tsha = ph.get("拇指 sha256") or ""
        text = ph.get("拇指扩展名") or ""

        big, got = find_blob(root, sha, bext, "大图")
        if big is None:
            # 图都取不到，这一行恢复出来也是张破图，不如跳过并报出来
            missing_big.append((pid, sha[:16] or "无指纹"))
            continue
        bext = bext or got or "jpg"

        thumb = None
        if tsha:
            thumb, got2 = find_blob(root, tsha, text, "缩略图")
            text = text or got2
        if thumb is None:
            # 缩略图缺失不拦着恢复 —— 拿大图顶上，前台照样能看，
            # 只是相册列表会变重。报告里单独列出来。
            thumb, text = big, bext
            missing_thumb.append(pid)

        out.append([
            n(pid), q(ph.get("owner_id")), q(ph.get("owner_name")),
            q(ph.get("album") or ""), q(ph.get("post_slug") or ""),
            q(ph.get("caption") or ""),
            q((ph.get("taken_on") or "")[:10] or None),
            q(ph.get("visibility") or "private"), n(ph.get("sort")),
            q(data_url(thumb, text)), q(data_url(big, bext)),
            n(ph.get("width")), n(ph.get("height")), q(ph.get("created_at")),
        ])
    return cols, out


def rows_comments(rows):
    cols = ["id", "post_slug", "name", "content", "status", "reply",
            "created_at", "uid"]
    out = [[n(c.get("id")), q(c.get("post_slug")), q(c.get("name")),
            q(c.get("content") or ""), q(c.get("status") or "published"),
            q(c.get("reply")), q(c.get("created_at")), q(c.get("uid"))]
           for c in rows]
    return cols, out


def rows_guestbook(rows):
    cols = ["id", "name", "content", "status", "reply", "created_at", "uid"]
    out = [[n(c.get("id")), q(c.get("name")), q(c.get("content") or ""),
            q(c.get("status") or "published"), q(c.get("reply")),
            q(c.get("created_at")), q(c.get("uid"))]
           for c in rows]
    return cols, out


def rows_events(rows):
    cols = ["id", "kind", "detail", "uid", "created_at"]
    out = [[n(c.get("id")), q(c.get("kind")), q(c.get("detail")),
            q(c.get("uid")), q(c.get("created_at"))]
           for c in rows]
    return cols, out


def rows_profiles(rows):
    cols = ["uid", "display_name", "created_at", "updated_at"]
    out = [[q(c.get("uid")), q(c.get("display_name")),
            q(c.get("created_at")), q(c.get("updated_at"))]
           for c in rows]
    return cols, out


def rows_admins(rows):
    cols = ["uid", "email", "created_at"]
    out = [[q(c.get("uid")), q(c.get("email")), q(c.get("created_at"))]
           for c in rows]
    return cols, out


def rows_legacy(rows):
    cols = ["id", "title", "body", "created_at", "updated_at"]
    out = [[n(c.get("id")), q(c.get("title")), q(c.get("body") or ""),
            q(c.get("created_at")), q(c.get("updated_at"))]
           for c in rows]
    return cols, out


def emit(out, table, cols, rows, note=""):
    """把一张表渲染成 SQL。撞上已有行就跳过，不覆盖。"""
    if not rows:
        return 0
    out.append("-- %s：%d 行%s" % (TABLE_CN.get(table, table), len(rows),
                                   ("（%s）" % note) if note else ""))
    for r in rows:
        ov = " OVERRIDING SYSTEM VALUE" if table in IDENTITY_TABLES else ""
        out.append("INSERT INTO %s (%s)%s VALUES (%s) ON CONFLICT DO NOTHING;" % (
            table, ", ".join(cols), ov, ", ".join(r)))
    if table in IDENTITY_TABLES:
        # 写回了指定的 id，自增计数器还停在原地 —— 不同步的话，
        # 恢复完在后台发一篇新文章就会撞主键。
        out.append("SELECT setval(pg_get_serial_sequence('%s', 'id'), "
                   "GREATEST((SELECT COALESCE(MAX(id), 1) FROM %s), 1));"
                   % (table, table))
    out.append("")
    return len(rows)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="从本地备份生成恢复 SQL")
    ap.add_argument("--root", default=str(DEFAULT_ROOT))
    ap.add_argument("--date", help="用哪一期快照（默认最近一期）")
    ap.add_argument("--list", action="store_true", help="列出可用的快照日期")
    ap.add_argument("--only", help="只恢复这些类，逗号分隔：%s" % ",".join(ALL_KINDS))
    ap.add_argument("--slug", help="只恢复这一篇文章（连带它的评论与照片）")
    ap.add_argument("--out", help="SQL 输出路径")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.exists():
        die("找不到备份目录：%s" % root)

    days = list_snapshots(root)
    if args.list:
        say("")
        say("可用快照：")
        if not days:
            say("  （一个都没有 —— 先跑一次 tools/backup.py）")
        for d in days:
            n_posts = len(read_json(root / "历史" / d / "文章.json", []) or [])
            n_photo = len(read_json(root / "历史" / d / "照片.json", []) or [])
            meta = read_json(root / "历史" / d / "其他内容.json", {}) or {}
            say("  %s   文章 %d · 照片 %d · 评论 %d · 留言 %d" % (
                d, n_posts, n_photo,
                len(meta.get("post_comments") or []),
                len(meta.get("guestbook") or [])))
        say("")
        return 0

    if not days:
        die("没有任何快照可恢复。先在 备份/ 里跑一次 tools/backup.py。")
    day = args.date or days[0]
    if day not in days:
        die("没有 %s 这一期快照。可用：%s" % (day, "、".join(days)))

    kinds = ALL_KINDS
    if args.only:
        kinds = [k.strip() for k in args.only.split(",") if k.strip()]
        bad = [k for k in kinds if k not in ALL_KINDS]
        if bad:
            die("不认识的类别：%s（可选：%s）" % ("、".join(bad), "、".join(ALL_KINDS)))

    say("")
    say("  像素日常 · 从备份生成恢复 SQL")
    say("  ─────────────────────────────────────────")
    say("    备份目录  %s" % root)
    say("    快照日期  %s" % day)
    say("    恢复范围  %s" % "、".join(TABLE_CN[KIND_TO_TABLE[k]] for k in kinds))

    box = load_snapshot(root, day)

    # --slug：只捞这一篇，连带它的评论和照片
    if args.slug:
        s = args.slug
        box["posts"] = [p for p in box["posts"] if p.get("slug") == s]
        box["post_comments"] = [c for c in box["post_comments"] if c.get("post_slug") == s]
        box["photos"] = [p for p in box["photos"] if (p.get("post_slug") or "") == s]
        say("    只针对    slug = %s" % s)
        if not box["posts"] and not box["post_comments"] and not box["photos"]:
            die("快照里没有任何东西属于 slug「%s」。" % s)

    missing_big, missing_thumb = [], []
    plans = {}          # 表 → (cols, rows)

    if "posts" in kinds:
        plans["posts"] = rows_posts(box["posts"])
    if "photos" in kinds:
        plans["photos"] = rows_photos(root, box["photos"], missing_big, missing_thumb)
    if "comments" in kinds:
        plans["comments"] = rows_comments(box["post_comments"])
    if "guestbook" in kinds:
        plans["guestbook"] = rows_guestbook(box["guestbook"])
    if "events" in kinds:
        plans["events"] = rows_events(box["site_events"])
    if "profiles" in kinds:
        plans["profiles"] = rows_profiles(box["profiles"])
    if "admins" in kinds:
        plans["admins"] = rows_admins(box["site_admins"])
    if "legacy" in kinds:
        plans["legacy"] = rows_legacy(box["private_posts"])

    # 组 SQL
    sql = [
        "-- 像素日常 · 内容恢复脚本",
        "-- 由 tools/restore.py 生成，快照日期 %s，生成于 %s" % (
            day, dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")),
        "--",
        "-- 这份脚本只做「插入」：目标行已存在就跳过，不会改动或删除任何现有数据。",
        "-- 请在数据库控制台执行（或让 WorkBuddy 代执行）。文件编码 UTF-8。",
        "--",
        "BEGIN;",
        "",
    ]

    if "admins" in kinds:
        sql += ["-- ── 先恢复站长名单：这一条丢了，你就进不去后台了 ──", ""]
    say("")
    plan = []
    for t in ORDER:
        key = [k for k, v in KIND_TO_TABLE.items() if v == t]
        k = key[0] if key else t
        if k not in plans:
            continue
        cols, rows = plans[k]
        cnt = emit(sql, t, cols, rows)
        plan.append((t, cnt))

    sql += ["COMMIT;", ""]

    if args.slug:
        default_name = "恢复-%s.sql" % args.slug
    else:
        default_name = "恢复.sql"
    out_path = Path(args.out) if args.out else (root / "恢复" / day / default_name)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(sql), encoding="utf-8", newline="\n")

    # 报告
    say("    将恢复：")
    for t, c in plan:
        if c:
            say("      %-10s %d 行" % (TABLE_CN[t], c))
    zero = [TABLE_CN[t] for t, c in plan if not c]
    if zero:
        say("      （%s 快照里本来就是空的）" % "、".join(zero))
    if missing_big:
        say("")
        say("    [!] 有 %d 张照片的大图在 照片库/ 里找不到，整行跳过：" % len(missing_big))
        for pid, sha in missing_big[:8]:
            say("        id=%s  指纹 %s" % (pid, sha))
        say("        先把图补进 照片库/大图/ 再重新生成，否则恢复出来是破图。")
    if missing_thumb:
        say("")
        say("    [!] 有 %d 张的缩略图缺失，已用大图顶替（前台能看，列表会变重）："
            % len(missing_thumb))
        say("        id=%s" % "、".join(str(x) for x in missing_thumb[:12]))

    say("")
    say("  完成。")
    say("    SQL 文件   %s" % out_path)
    say("    大小       %.1f KB" % (out_path.stat().st_size / 1024.0))
    say("")
    say("  下一步：把这份 SQL 执行到云端数据库。可以让 WorkBuddy 代跑，")
    say("          也可以自己在数据库控制台粘贴（注意选 UTF-8 编码）。")
    say("")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("")
        sys.exit(130)
