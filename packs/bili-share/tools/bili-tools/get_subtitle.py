#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
get_subtitle.py —— 用 WBI 签名正规获取 B站字幕（UP 字幕 + AI 字幕）

为什么需要它：
  /x/player/v2 是免签接口，只带 bvid 时 subtitle_url 常为空；
  B站真正给字幕的是 /x/player/wbi/v2，必须带 WBI 签名（w_rid + wts）。
  另外字幕 CDN 直链需要 auth_key，所以必须用接口返回的**完整** URL，不能自己拼。

用法：
  python get_subtitle.py BV12CJv6bEPf
  python get_subtitle.py BV12CJv6bEPf --sessdata XXX     # 带上登录态（能拿到 UP 上传的字幕）
  python get_subtitle.py BV12CJv6bEPf --out DIR --save    # 顺手把字幕存成 json/srt/txt
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
REF = "https://www.bilibili.com/"

MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52,
]


def _get(url, sessdata=None, referer=REF):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Referer", referer)
    if sessdata:
        req.add_header("Cookie", f"SESSDATA={sessdata}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _text(url, sessdata=None):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Referer", REF)
    if sessdata:
        req.add_header("Cookie", f"SESSDATA={sessdata}")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def get_mixin_key(orig: str) -> str:
    return "".join(orig[i] for i in MIXIN_TAB)[:32]


def enc_wbi(params: dict, img_key: str, sub_key: str) -> str:
    mixin_key = get_mixin_key(img_key + sub_key)
    params = dict(params)
    params["wts"] = round(time.time())
    params = dict(sorted(params.items()))
    params = {k: "".join(ch for ch in str(v) if ch not in "!'()*") for k, v in params.items()}
    query = urllib.parse.urlencode(params)
    w_rid = hashlib.md5((query + mixin_key).encode()).hexdigest()
    return f"{query}&w_rid={w_rid}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bvid")
    ap.add_argument("--sessdata", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--save", action="store_true")
    a = ap.parse_args()

    # 1) cid
    pg = _get(f"https://api.bilibili.com/x/player/pagelist?bvid={a.bvid}", a.sessdata)
    if pg.get("code") != 0:
        print("pagelist 失败", pg); return 2
    cid = pg["data"][0]["cid"]
    title = pg["data"][0].get("part", a.bvid)

    # 2) nav 拿 wbi keys
    nav = _get("https://api.bilibili.com/x/web-interface/nav", a.sessdata)
    wbi = (nav.get("data") or {}).get("wbi_img") or {}
    img_key = (wbi.get("img_url") or "").rsplit("/", 1)[-1].split(".")[0]
    sub_key = (wbi.get("sub_url") or "").rsplit("/", 1)[-1].split(".")[0]
    if not img_key or not sub_key:
        print("拿不到 wbi keys（nav 接口异常）"); return 3

    # 3) 签名调 wbi/v2
    q = enc_wbi({"bvid": a.bvid, "cid": cid}, img_key, sub_key)
    j = _get(f"https://api.bilibili.com/x/player/wbi/v2?{q}", a.sessdata,
             referer=f"https://www.bilibili.com/video/{a.bvid}")
    subs = ((j.get("data") or {}).get("subtitle") or {}).get("subtitles") or []
    print(f"cid={cid} 标题={title} 字幕条数={len(subs)}")
    if not subs:
        print("这个视频没有返回任何字幕（可能需要登录 cookie，或者本来就无字幕）")
        return 0

    out_dir = a.out or os.getcwd()
    os.makedirs(out_dir, exist_ok=True)
    for s in subs:
        u = s.get("subtitle_url") or ""
        if u.startswith("//"):
            u = "https:" + u
        print(f"  - {s.get('lan')} / {s.get('lan_doc')} : {u[:90]}{'…' if len(u) > 90 else ''}")
        if not a.save or not u:
            continue
        try:
            body = json.loads(_text(u, a.sessdata)).get("body") or []
        except Exception as e:
            print("    下载失败:", e, "（CDN 直链要 auth_key，过期了就重新跑一次）")
            continue
        base = os.path.join(out_dir, f"subtitle_{s.get('lan','unk')}")
        with open(base + ".json", "w", encoding="utf-8") as f:
            json.dump({"lan": s.get("lan"), "body": body}, f, ensure_ascii=False, indent=1)

        def ts(t):
            h = int(t // 3600); m = int(t % 3600 // 60); sec = t % 60
            return f"{h:02d}:{m:02d}:{sec:06.3f}".replace(".", ",")

        with open(base + ".srt", "w", encoding="utf-8") as f:
            for i, l in enumerate(body, 1):
                f.write(f"{i}\n{ts(l['from'])} --> {ts(l['to'])}\n{l['content']}\n\n")
        with open(base + ".txt", "w", encoding="utf-8") as f:
            f.write("\n".join(l["content"] for l in body))
        print(f"    已保存 {base}.json / .srt / .txt（{len(body)} 条）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
