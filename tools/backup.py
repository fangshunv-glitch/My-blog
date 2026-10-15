#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
像素日常 · 云端内容备份到本地
==============================

把博客在 WorkBuddy Cloud 上的全部内容拉一份到本机磁盘。作者：这个脚本
只读云端，不写、不改、不删。跑一百遍也不会影响线上任何一个字。

覆盖的表
--------
  posts          文章（正文、摘要、分类、标签、可见范围、置顶、日期）
  photos         相册（大图 + 缩略图，落成真正的 .jpg 文件）
  post_comments  文章评论
  guestbook      留言板
  profiles       访客显示名
  site_admins    站长名单 —— 丢了就进不去后台，必须备
  site_events    站点事件
  private_posts  上一版遗留的表

为什么能读到「仅自己可见」的内容
--------------------------------
前面说的那些表都开了行级安全（RLS），访客身份只读得到
visibility 为 public / unlisted 的行 —— 这是数据库强制的，绕不过去。
所以云端另有一个受密钥保护的只读函数 pixel_backup_dump()：它以表的
所有者身份执行，不受策略限制。密钥只存在本机 备份/.backup-key 里，
函数体中只有密钥的 md5，从数据库里翻不到明文。

产物（默认落在 D:\\AI\\个人博客\\备份）
--------------------------------------
  最新/           人类可读的当前快照：文章是 .md，照片是 .jpg
                  —— 不依赖任何脚本，直接用眼睛看、直接双击打开
  历史/日期/       纯文本逐日快照（不含图片本体），用来回溯「那天是什么样」
  照片库/         按内容去重的照片池。云端删掉的照片在这里仍然留着，
                  相当于一个只进不出的回收站
  日志/backup.log 每次备份的流水

用法
----
  python tools/backup.py              备份一次
  python tools/backup.py --check      只看云端现状与变化，不写盘
  python tools/backup.py --init-key   生成一个新密钥（会打印设置函数用的 SQL）
  python tools/backup.py --root D:/别的地方/备份
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = Path(__file__).resolve().parent          # pixel-daily/tools
PROJECT = HERE.parent                            # pixel-daily
DEFAULT_ROOT = PROJECT.parent / "备份"            # 个人博客/备份
CONFIG_JS = PROJECT / "cloud-config.js"

PHOTO_PAGE = 8          # 每次向云端要几张照片（每张 base64 300KB 上下）
TIMEOUT = 90

# 表名 → 中文名，报告里用
TABLE_CN = {
    "posts": "文章",
    "photos": "照片",
    "post_comments": "文章评论",
    "guestbook": "留言板",
    "profiles": "访客资料",
    "site_admins": "站长名单",
    "site_events": "站点事件",
    "private_posts": "遗留私密表",
}


# ---------------------------------------------------------------------------
# 配置与密钥
# ---------------------------------------------------------------------------
def load_config():
    """从 cloud-config.js 里读接口地址和公开键，避免在这里再抄一份。"""
    src = CONFIG_JS.read_text(encoding="utf-8")
    m = re.search(r"endpoint\s*:\s*['\"]([^'\"]+)['\"]", src)
    k = re.search(r"publishableKey\s*:\s*['\"]([^'\"]+)['\"]", src)
    if not m or not k:
        die("读不到 %s 里的 endpoint / publishableKey。" % CONFIG_JS)
    endpoint = m.group(1).rstrip("/")
    return endpoint, endpoint + "/.cloud/database/rest", k.group(1)


def load_secret(root: Path, optional=False):
    p = root / ".backup-key"
    if not p.exists():
        if optional:
            return None
        die("找不到备份密钥 %s。\n"
            "  新机器上先跑一次：python tools/backup.py --init-key\n"
            "  它会生成密钥，并打印一段设置云端函数的 SQL。" % p)
    return p.read_text(encoding="utf-8").strip()


def die(msg, code=2):
    print("[×] " + msg)
    sys.exit(code)


# ---------------------------------------------------------------------------
# 与云端对话
# ---------------------------------------------------------------------------
def make_rpc(pubkey, rest_url, secret):
    def rpc(part, **kw):
        body = {"k": secret, "part": part}
        body.update(kw)
        req = urllib.request.Request(
            rest_url + "/rpc/pixel_backup_dump",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-wb-webapp-access-key": pubkey,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code == 401 and "key rejected" in detail:
                die("云端拒绝了这把密钥。\n"
                    "  密钥文件被改过，或者云端那个函数的 md5 跟它对不上。\n"
                    "  重跑 python tools/backup.py --init-key 看看怎么办。")
            die("云端返回 %s：%s" % (e.code, detail))
        except Exception as e:
            die("连不上云端：%s\n  检查一下网络，或者站点是不是被下线了。" % e)
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            die("云端返回的不是 JSON：%s" % raw[:200])

    return rpc


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
BAD_CHARS = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def safe_name(s, fallback="未命名", limit=48):
    """把任意文本变成能当文件名的样子。中文照留，只清掉非法字符。"""
    s = BAD_CHARS.sub(" ", str(s or "")).strip()
    s = re.sub(r"\s+", " ", s)
    if not s:
        s = fallback
    return s[:limit].rstrip(". ")


def decode_data_url(d):
    """把 data:image/jpeg;base64,xxxx 解开成 (bytes, 扩展名)。"""
    if not d:
        return b"", "bin"
    head, _, payload = d.partition(",")
    if head.startswith("data:") and payload:
        if "png" in head:
            ext = "png"
        elif "webp" in head:
            ext = "webp"
        elif "gif" in head:
            ext = "gif"
        else:
            ext = "jpg"
    else:
        payload, ext = d, "jpg"
    payload = re.sub(r"\s+", "", payload)
    try:
        return base64.b64decode(payload, validate=False), ext
    except Exception:
        return b"", "bin"


def human(n):
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%.1f %s" % (n, unit)) if unit != "B" else ("%d B" % n)
        n /= 1024


def now_local():
    return dt.datetime.now().astimezone()


def write_text(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def write_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def clear_dir(path: Path):
    """清空目录但保留目录本身，返回删不掉的东西。

    为什么不用 shutil.rmtree：本机的删除会被代理成「移进回收站」，
    目录一大就可能失败。失败不该让整次备份崩掉 —— 记下来，继续写，
    反正是覆盖式重建，同名文件会被新内容盖住。
    """
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
        return []
    p = path.resolve()
    if p.name != "最新" or p.parent == p:
        raise RuntimeError("拒绝清理非预期目录：%s" % p)

    stuck = []
    # 深的先删，不然父目录非空删不掉
    for item in sorted(p.rglob("*"), key=lambda x: len(x.parts), reverse=True):
        try:
            if item.is_dir() and not item.is_symlink():
                item.rmdir()
            else:
                item.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            stuck.append(item)
    return stuck


# ---------------------------------------------------------------------------
# 同一时刻只允许一次备份
#
# 定时任务和「双击立即备份」撞上过：两个进程同时重建 最新/，
# 一个把另一个正在写的目录删了。锁很简单，够用。
# ---------------------------------------------------------------------------
LOCK_MAX_AGE = 30 * 60          # 秒。超过这个岁数的锁当作上次崩了留下的


def acquire_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    lock = root / ".backup.lock"
    if lock.exists():
        try:
            age = time.time() - lock.stat().st_mtime
        except OSError:
            age = LOCK_MAX_AGE + 1
        if age < LOCK_MAX_AGE:
            who = ""
            try:
                who = lock.read_text(encoding="utf-8").strip().replace("\n", " ")
            except Exception:
                pass
            die("另一次备份已经在跑了，别同时来。\n"
                "  %s\n"
                "  要么等它跑完（通常几秒），要么删掉 %s 再试。" % (who or "(没有留下信息)", lock))
    lock.write_text("pid %d @ %s\n" % (os.getpid(), now_local().isoformat(timespec="seconds")),
                    encoding="utf-8")
    return lock


def release_lock(lock: Path):
    try:
        lock.unlink()
    except OSError:
        pass        # 删不掉也没事，下次会当成过期锁抢占


# ---------------------------------------------------------------------------
# 拉取
# ---------------------------------------------------------------------------
def fetch_all(rpc, verbose=True):
    def say(*a):
        if verbose:
            print(*a)

    say("  · 云端现状 …")
    manifest = rpc("manifest") or {}

    say("  · 文章 …")
    posts = rpc("posts") or []

    say("  · 评论 / 留言 / 资料 / 站长 …")
    meta = rpc("meta") or {}

    say("  · 遗留表 …")
    private_posts = rpc("private_posts") or []

    total = int(manifest.get("photos") or 0)
    say("  · 照片 %d 张 …" % total)
    photos, off = [], 0
    while off < total:
        chunk = rpc("photos", off=off, lim=PHOTO_PAGE) or []
        if not chunk:
            break
        photos.extend(chunk)
        off += len(chunk)
        say("      %d / %d" % (len(photos), total))

    return {
        "manifest": manifest,
        "posts": posts,
        "meta": meta,
        "private_posts": private_posts,
        "photos": photos,
    }


# ---------------------------------------------------------------------------
# 落盘：人类可读的那一份
# ---------------------------------------------------------------------------
def render_views(root: Path, box):
    """重建 最新/ —— 每次全量重来，云端删掉的不会残留。"""
    latest = root / "最新"
    stuck = clear_dir(latest)

    per_album = {}
    photo_index = []

    for ph in box["photos"]:
        pid = ph.get("id")
        album = safe_name(ph.get("album") or "未分类", "未分类", 32)
        cap = ph.get("caption") or ""
        big, ext = decode_data_url(ph.get("image_data"))
        sha = hashlib.sha256(big).hexdigest() if big else ""

        if big:
            # 去重池：同一张图不管挂在哪个相册，只存一份
            pool = root / "照片库" / ("%s.%s" % (sha[:16], ext))
            if not pool.exists():
                write_bytes(pool, big)
            # 可读副本按相册铺开
            fname = "%s-%s.%s" % (pid, safe_name(cap or ("照片%s" % pid)), ext)
            write_bytes(latest / "photos" / album / fname, big)
            per_album[album] = per_album.get(album, 0) + 1

        thumb, text = decode_data_url(ph.get("thumb_data"))
        if thumb:
            write_bytes(latest / "photos" / "缩略图" / ("%s.%s" % (pid, text)), thumb)

        photo_index.append({
            "id": pid,
            "相册": ph.get("album") or "",
            "说明": cap,
            "拍摄日": ph.get("taken_on") or "",
            "可见范围": ph.get("visibility") or "",
            "尺寸": "%sx%s" % (ph.get("width") or "?", ph.get("height") or "?"),
            "大图": human(len(big)),
            "缩略图": human(len(thumb)),
            "sha256": sha[:16],
            "文件": "%s-%s.%s" % (pid, safe_name(cap or ("照片%s" % pid)), ext) if big else "",
        })

    # ---- 文章：一篇一个 .md，带 front-matter ----
    posts = box["posts"]
    for p in posts:
        slug = p.get("slug") or ("post-%s" % p.get("id"))
        day = (p.get("published_on") or "")[:10] or "0000-00-00"
        fm = [
            "---",
            "slug: %s" % slug,
            "title: %s" % (p.get("title") or ""),
            "date: %s" % day,
            "category: %s" % (p.get("category") or ""),
            "tags: %s" % (p.get("tags") or ""),
            "visibility: %s" % (p.get("visibility") or ""),
            "featured: %s" % ("true" if p.get("featured") else "false"),
            "excerpt: %s" % (p.get("excerpt") or "").replace("\n", " "),
            "created_at: %s" % (p.get("created_at") or ""),
            "updated_at: %s" % (p.get("updated_at") or ""),
            "---",
            "",
        ]
        write_text(latest / "posts" / ("%s_%s.md" % (day, safe_name(slug, "post", 60))),
                   "\n".join(fm) + (p.get("body") or ""))

    # ---- 各表的清单 ----
    lines = ["# 文章清单", "",
             "共 %d 篇 · 导出于 %s" % (len(posts), now_local().strftime("%Y-%m-%d %H:%M")),
             "", "| 日期 | 标题 | 分类 | 可见范围 | 字数 | 别名 |",
             "|---|---|---|---|---|---|"]
    for p in sorted(posts, key=lambda x: (x.get("published_on") or "", x.get("id") or 0),
                    reverse=True):
        lines.append("| %s | %s | %s | %s | %d | `%s` |" % (
            (p.get("published_on") or "")[:10],
            (p.get("title") or "").replace("|", "\\|"),
            p.get("category") or "",
            p.get("visibility") or "",
            len(p.get("body") or ""),
            p.get("slug") or "",
        ))
    if not posts:
        lines += ["", "（还没有文章）"]
    write_text(latest / "posts" / "清单.md", "\n".join(lines) + "\n")

    lines = ["# 相册清单", "",
             "共 %d 张 · 导出于 %s" % (len(photo_index), now_local().strftime("%Y-%m-%d %H:%M")),
             ""]
    if per_album:
        lines.append("按相册：" + "、".join("%s %d 张" % (k, v) for k, v in sorted(per_album.items())))
        lines.append("")
    lines += ["| id | 相册 | 说明 | 拍摄日 | 可见范围 | 尺寸 | 大图 |",
              "|---|---|---|---|---|---|---|"]
    for ph in photo_index:
        lines.append("| %s | %s | %s | %s | %s | %s | %s |" % (
            ph["id"], ph["相册"], ph["说明"].replace("|", "\\|"), ph["拍摄日"],
            ph["可见范围"], ph["尺寸"], ph["大图"]))
    if not photo_index:
        lines += ["", "（还没有照片）"]
    write_text(latest / "photos" / "清单.md", "\n".join(lines) + "\n")

    # ---- 评论 / 留言 / 资料：JSON + 可读文本 ----
    out = {
        "文章评论": box["meta"].get("post_comments") or [],
        "留言板": box["meta"].get("guestbook") or [],
        "访客资料": box["meta"].get("profiles") or [],
        "站长名单": box["meta"].get("site_admins") or [],
        "站点事件": box["meta"].get("site_events") or [],
        "遗留私密表": box["private_posts"],
    }
    write_text(latest / "其他内容.json",
               json.dumps(out, ensure_ascii=False, indent=2) + "\n")

    lines = ["# 评论与留言", "",
             "导出于 %s" % now_local().strftime("%Y-%m-%d %H:%M"), ""]
    lines.append("## 文章评论（%d 条）" % len(out["文章评论"]))
    lines += ["", "（还没有评论）", ""] if not out["文章评论"] else [""]
    for c in out["文章评论"]:
        lines += ["### %s · %s" % (c.get("name") or "匿名", (c.get("created_at") or "")[:19]),
                  "", "所属文章：`%s`" % (c.get("post_slug") or ""),
                  "状态：%s" % (c.get("status") or ""), "",
                  "> " + (c.get("content") or "").replace("\n", "\n> "), ""]
        if c.get("reply"):
            lines += ["站长回复：" + str(c["reply"]), ""]
    lines += ["## 留言板（%d 条）" % len(out["留言板"]), ""]
    lines += ["", "（还没有留言）", ""] if not out["留言板"] else [""]
    for c in out["留言板"]:
        lines += ["### %s · %s" % (c.get("name") or "匿名", (c.get("created_at") or "")[:19]), "",
                  "状态：%s" % (c.get("status") or ""), "",
                  "> " + (c.get("content") or "").replace("\n", "\n> "), ""]
        if c.get("reply"):
            lines += ["站长回复：" + str(c["reply"]), ""]
    write_text(latest / "评论与留言.md", "\n".join(lines) + "\n")

    return photo_index, stuck


def write_history(root: Path, box, day: str):
    """纯文本逐日快照。图片本体不进这里，只记指纹 —— 照片在 照片库/ 里。"""
    d = root / "历史" / day
    d.mkdir(parents=True, exist_ok=True)

    write_text(d / "文章.json",
               json.dumps(box["posts"], ensure_ascii=False, indent=2) + "\n")
    write_text(d / "其他内容.json",
               json.dumps(box["meta"], ensure_ascii=False, indent=2) + "\n")
    write_text(d / "遗留私密表.json",
               json.dumps(box["private_posts"], ensure_ascii=False, indent=2) + "\n")
    slim = []
    for ph in box["photos"]:
        item = {k: v for k, v in ph.items() if k not in ("image_data", "thumb_data")}
        big, _ = decode_data_url(ph.get("image_data"))
        item["大图字节"] = len(big)
        item["sha256"] = hashlib.sha256(big).hexdigest() if big else ""
        slim.append(item)
    write_text(d / "照片.json",
               json.dumps(slim, ensure_ascii=False, indent=2) + "\n")


# ---------------------------------------------------------------------------
# 变化对比
# ---------------------------------------------------------------------------
def diff_report(before, after):
    if not before:
        return []           # 第一次备份，没有可比的对象
    rows = []
    for t in sorted(set(list(before.keys()) + list(after.keys()))):
        b, a = before.get(t, 0), after.get(t, 0)
        if a != b:
            rows.append((t, b, a))
    return rows


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="把云端博客内容备份到本地")
    ap.add_argument("--root", default=str(DEFAULT_ROOT), help="备份根目录")
    ap.add_argument("--check", action="store_true", help="只看现状，不写盘")
    ap.add_argument("--init-key", action="store_true", help="生成新密钥并打印设置 SQL")
    ap.add_argument("--quiet", action="store_true", help="少说话（给定时任务用）")
    args = ap.parse_args()
    root = Path(args.root).resolve()

    if args.init_key:
        import secrets
        key = secrets.token_urlsafe(36)
        root.mkdir(parents=True, exist_ok=True)
        write_text(root / ".backup-key", key + "\n")
        md5 = hashlib.md5(key.encode()).hexdigest()
        if os.name != "nt":
            try:
                (root / ".backup-key").chmod(0o600)
            except OSError:
                pass
        print("密钥已写入：%s" % (root / ".backup-key"))
        print()
        print("把这个 md5 填进云端的 pixel_backup_dump 函数（替换原来那串）：")
        print("   " + md5)
        print()
        print("换密钥的 SQL：")
        print("   CREATE OR REPLACE FUNCTION pixel_backup_dump(...) 里 md5(k) <> '%s' 那一行" % md5)
        return 0

    endpoint, rest_url, pubkey = load_config()
    secret = load_secret(root)
    rpc = make_rpc(pubkey, rest_url, secret)

    t0 = now_local()
    say = (lambda *a: None) if args.quiet else print

    say("像素日常 · 云端备份")
    say("  云端：%s" % endpoint)
    say("  落到：%s" % root)
    say("")

    try:
        box = fetch_all(rpc, verbose=not args.quiet)
    except SystemExit:
        raise

    # 以实际拉到的条数为准 —— 那才是真正落进本地的东西
    counts = {
        "posts": len(box["posts"]),
        "photos": len(box["photos"]),
        "post_comments": len(box["meta"].get("post_comments") or []),
        "guestbook": len(box["meta"].get("guestbook") or []),
        "profiles": len(box["meta"].get("profiles") or []),
        "site_admins": len(box["meta"].get("site_admins") or []),
        "site_events": len(box["meta"].get("site_events") or []),
        "private_posts": len(box["private_posts"]),
    }

    # 跟云端自报的行数对一遍。对不上就是中途漏了，必须说出来，
    # 不然「备份成功」这四个字是假的。
    remote = box.get("manifest") or {}
    mismatch = [(t, remote.get(t), n) for t, n in counts.items()
                if isinstance(remote.get(t), int) and remote[t] != n]

    # 上次的清单，用来算变化
    prev_file = root / "最新" / "备份清单.json"
    before = {}
    if prev_file.exists():
        try:
            before = (json.loads(prev_file.read_text(encoding="utf-8")) or {}).get("行数", {})
        except Exception:
            before = {}

    say("")
    say("  云端一共：")
    for t in ("posts", "photos", "post_comments", "guestbook", "profiles",
              "site_admins", "site_events"):
        if counts[t] or t in ("posts", "photos"):
            say("    %-14s %d" % (TABLE_CN[t], counts[t]))

    if mismatch:
        say("")
        say("  [!] 云端说有的条数，跟实际拉到的对不上：")
        for t, want, got in mismatch:
            say("      %s：云端 %s 条，只拿到 %s 条" % (TABLE_CN.get(t, t), want, got))
        say("      这次备份不完整，别当它是好的。")

    changes = diff_report(before, {k: v for k, v in counts.items()})
    if changes:
        say("")
        say("  跟上次比：")
        for t, b, a in changes:
            arrow = "↑" if (a or 0) > (b or 0) else "↓"
            say("    %s %s %s → %s" % (arrow, TABLE_CN.get(t, t), b, a))
            if (a or 0) < (b or 0):
                say("      注意：少了 %d 条。如果不是你自己删的，去后台看一眼。" % ((b or 0) - (a or 0)))

    if args.check:
        say("")
        say("  （--check 模式，没有写盘）")
        return 3 if mismatch else 0

    say("")
    say("  写入本地 …")

    lock = acquire_lock(root)
    try:
        day = t0.strftime("%Y-%m-%d")
        photo_index, stuck = render_views(root, box)
        write_history(root, box, day)

        total_bytes = sum(f.stat().st_size for f in root.rglob("*") if f.is_file())

        manifest = {
            "导出时间": t0.isoformat(timespec="seconds"),
            "云端": endpoint,
            "行数": counts,
            "照片清单": photo_index,
            "本地占用": total_bytes,
            "本次变化": [{"表": t, "上次": b, "本次": a} for t, b, a in changes],
        }
        write_text(root / "最新" / "备份清单.json",
                   json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        write_text(root / "历史" / day / "备份清单.json",
                   json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

        # 照片池里到底攒了多少张
        pool = root / "照片库"
        pool_n = len(list(pool.glob("*"))) if pool.exists() else 0

        log = root / "日志" / "backup.log"
        line = "%s  文章%d 照片%d 评论%d 留言%d  最重大小 %s  照片池 %d 张%s\n" % (
            t0.strftime("%Y-%m-%d %H:%M:%S"), counts["posts"], counts["photos"],
            counts["post_comments"], counts["guestbook"], human(total_bytes), pool_n,
            ("  变化：" + "; ".join("%s %s→%s" % (TABLE_CN.get(t, t), b, a)
                                   for t, b, a in changes)) if changes else "")
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8", newline="\n") as f:
            f.write(line)
    finally:
        release_lock(lock)

    say("")
    say("  完成。用时 %.1f 秒" % ((now_local() - t0).total_seconds()))
    say("    最新快照  %s" % (root / "最新"))
    say("    照片池    %d 张（云端删过的也留在这里）" % pool_n)
    say("    合计占用  %s" % human(total_bytes))
    if stuck:
        say("")
        say("  [!] 有 %d 项旧文件没能清掉 —— 本机把删除转成了回收站，被挡住了：" % len(stuck))
        for s in stuck[:6]:
            say("      %s" % s.relative_to(root))
        say("      这次的内容本身是完整的，只是 最新/ 里可能混着云端已经删掉的旧文件。")
        say("      顺手清一下回收站，或者手动删掉上面这几个。")
    return 3 if mismatch else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n中断了，云端没被改动。")
        sys.exit(130)
