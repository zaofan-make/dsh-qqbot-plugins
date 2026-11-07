#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_bili.py —— B站视频 + 字幕 抓取（配合 browser-skill / bsk CLI 使用）

为什么配合 bsk：
  B站的字幕与高清流都需要登录态。bsk 让 agent 借用主人**已登录**的浏览器，
  所以推荐流程是：bsk 打开视频页 → 用页面上下文里的 cookie 调接口 →
  再把 URL 交给本脚本下载。没有 bsk 时，用 --sessdata 手动传 cookie 也能跑。

用法：
  python fetch_bili.py BV1XWp76FEZR                 # 下 360p + 抽帧 + 尝试字幕
  python fetch_bili.py BV1XWp76FEZR --qn 64          # 下 720p（需要 cookie）
  python fetch_bili.py BV1XWp76FEZR --sessdata XXX   # 带登录 cookie（可取 AI 字幕/高清）
  python fetch_bili.py --out DIR                     # 指定输出目录
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
REF = "https://www.bilibili.com/"


def http_json(url, sessdata=None, referer=REF):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Referer", referer)
    if sessdata:
        req.add_header("Cookie", f"SESSDATA={sessdata}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def http_file(url, path, referer=REF):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Referer", referer)
    with urllib.request.urlopen(req, timeout=180) as r, open(path, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bvid", nargs="?", help="BV 号，如 BV1XWp76FEZR")
    ap.add_argument("--out", default=None, help="输出目录")
    ap.add_argument("--qn", default="32", help="清晰度：32=360p 64=720p 80=1080p")
    ap.add_argument("--sessdata", default=None, help="B站 SESSDATA cookie（可选）")
    ap.add_argument("--frames", default="10", help="每 N 秒抽一帧")
    args = ap.parse_args()

    if not args.bvid:
        print("缺少 BV 号。用法：python fetch_bili.py BV1XXXXXXXXXX")
        return 1

    bvid = args.bvid.strip()
    out = args.out or os.path.join(os.getcwd(), "_bili", bvid)
    os.makedirs(out, exist_ok=True)

    # 1) 拿 cid / 标题 / 时长
    pg = http_json(f"https://api.bilibili.com/x/player/pagelist?bvid={bvid}")
    if pg.get("code") != 0 or not pg.get("data"):
        print("pagelist 失败：", pg.get("code"), pg.get("message"))
        return 2
    page = pg["data"][0]
    cid, title, dur = page["cid"], page.get("part", bvid), page.get("duration", 0)
    print(f"[1/5] cid={cid} 时长={dur}s 标题={title}")

    # 2) 拿播放流
    pu = http_json(
        f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn={args.qn}&fnval=16&fourk=0",
        sessdata=args.sessdata,
    )
    if pu.get("code") != 0:
        print("playurl 失败：", pu.get("code"), pu.get("message"))
        return 3
    dash = pu["data"].get("dash") or {}
    if not dash.get("video"):
        print("没有 dash 流（可能是付费/大会员内容）")
        return 3
    vurl = dash["video"][0]["baseUrl"]
    aurl = dash["audio"][0]["baseUrl"] if dash.get("audio") else None
    print(f"[2/5] 流已取到 quality={pu['data'].get('quality')}")

    # 3) 下载
    vpath = os.path.join(out, "video.m4s")
    print(f"[3/5] 下视频 → {vpath}")
    print("      ", http_file(vurl, vpath, referer=REF) // 1024, "KB")
    apath = None
    if aurl:
        apath = os.path.join(out, "audio.m4s")
        print("       下音频 →", http_file(aurl, apath, referer=REF) // 1024, "KB")

    # 4) 尝试字幕
    sub_ok = False
    pv = http_json(f"https://api.bilibili.com/x/player/v2?aid=&cid={cid}&bvid={bvid}", sessdata=args.sessdata)
    subs = (pv.get("data") or {}).get("subtitle", {}).get("subtitles", []) or []
    if subs:
        s = subs[0]
        surl = s.get("subtitle_url") or ""
        if surl.startswith("//"):
            surl = "https:" + surl
        try:
            sdata = http_json(surl)
            body = sdata.get("body") or []
            srt = os.path.join(out, "subtitle.srt")
            with open(srt, "w", encoding="utf-8") as f:
                for i, line in enumerate(body, 1):
                    def ts(t):
                        h = int(t // 3600); m = int(t % 3600 // 60); sec = t % 60
                        return f"{h:02d}:{m:02d}:{sec:06.3f}".replace(".", ",")
                    f.write(f"{i}\n{ts(line['from'])} --> {ts(line['to'])}\n{line['content']}\n\n")
            print(f"[4/5] 字幕已保存 {srt}（{len(body)} 条，{s.get('lan_doc','')}）")
            sub_ok = True
        except Exception as e:
            print("[4/5] 字幕下载失败：", e)
    else:
        print("[4/5] 接口没给字幕（未登录或该视频无字幕）→ 可带 --sessdata 再试，或用 whisper 从音频转写")

    # 5) 合并 + 抽帧
    if apath:
        try:
            has_ff = subprocess.run(["ffmpeg", "-version"], capture_output=True).returncode == 0
        except (FileNotFoundError, OSError):
            has_ff = False
        if has_ff:
            mp4 = os.path.join(out, "video.mp4")
            r = subprocess.run(
                ["ffmpeg", "-y", "-i", vpath, "-i", apath, "-c", "copy", mp4],
                capture_output=True, text=True,
            )
            print("[5/5] 合并：", "ok" if r.returncode == 0 else r.stderr[-200:])
            step = max(1, int(args.frames))
            frames_dir = os.path.join(out, "frames")
            os.makedirs(frames_dir, exist_ok=True)
            subprocess.run(
                ["ffmpeg", "-y", "-i", mp4, "-vf", f"fps=1/{step}", os.path.join(frames_dir, "f%03d.jpg")],
                capture_output=True,
            )
            n = len(os.listdir(frames_dir))
            print(f"       抽帧 {n} 张（每 {step}s 一张）→ {frames_dir}")
        else:
            print("[5/5] 没找到 ffmpeg，跳过合并与抽帧（m4s 可直接用播放器打开，或装 ffmpeg 后重跑）")
    else:
        print("[5/5] 没找到 ffmpeg，跳过合并与抽帧")

    print(json.dumps({
        "bvid": bvid, "cid": cid, "title": title, "duration": dur,
        "out": out, "subtitle": sub_ok,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
