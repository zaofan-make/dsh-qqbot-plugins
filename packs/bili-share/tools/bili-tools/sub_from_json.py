#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sub_from_json.py —— 从「已抓到的 wbi/v2 响应 JSON」里提取字幕并下载

分工（主人 2026-10-20 定）：
  · 浏览器会话、抓包、读响应 —— 由 agent 用 bsk_* 工具自己做（正常启动方式）；
  · 本脚本只干一件事：把那条 JSON 里的 subtitle_url 取出来、下载、转 srt。

用法：
  python sub_from_json.py wbi.json                     # 自动挑中文/英文
  python sub_from_json.py wbi.json --out DIR
  python sub_from_json.py wbi.json --all               # 8 种语言全下
  python sub_from_json.py wbi.json --lang ai-zh

★ 关键：接口给两个地址
  subtitle_url    → //aisubtitle.hdslb.com/...   用这个（通）
  subtitle_url_v2 → //subtitle.bilibili.com/...  很多机器 DNS 不解析（403）
"""
import argparse
import json
import os
import sys
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"


def fetch(url):
    if url.startswith("//"):
        url = "https:" + url
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Referer", "https://www.bilibili.com/")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def save(body, base):
    def ts(t):
        h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
        return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")
    with open(base + ".json", "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=1)
    with open(base + ".srt", "w", encoding="utf-8") as f:
        for i, l in enumerate(body, 1):
            f.write(f"{i}\n{ts(l['from'])} --> {ts(l['to'])}\n{l['content']}\n\n")
    with open(base + ".txt", "w", encoding="utf-8") as f:
        f.write("\n".join(l["content"] for l in body))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json_file", help="wbi/v2 的响应体（agent 从抓包里存下来的 json）")
    ap.add_argument("--out", default=None)
    ap.add_argument("--all", action="store_true", help="所有语言都下")
    ap.add_argument("--lang", action="append", default=None, help="只要指定语言，可多次")
    a = ap.parse_args()

    raw = open(a.json_file, encoding="utf-8", errors="replace").read()
    j = json.loads(raw)
    data = j.get("data") or j
    subs = ((data.get("subtitle") or {}).get("subtitles") or [])
    if not subs:
        print("这条 JSON 里没有 subtitles（可能不是 wbi/v2 的响应）")
        return 2

    out = a.out or os.path.dirname(os.path.abspath(a.json_file))
    os.makedirs(out, exist_ok=True)

    want = a.lang or (None if a.all else ["ai-zh", "ai-en"])
    picked = [s for s in subs if not want or s.get("lan") in want]
    if not picked:
        picked = subs

    print(f"字幕共 {len(subs)} 条，处理 {len(picked)} 条：")
    for s in picked:
        lan = s.get("lan", "unk")
        url = s.get("subtitle_url") or ""
        if not url:
            print(f"  - {lan}: 没有 subtitle_url，跳过")
            continue
        try:
            body = (json.loads(fetch(url)) or {}).get("body") or []
            save(body, os.path.join(out, f"subtitle_{lan}"))
            print(f"  ✓ {lan} ({s.get('lan_doc','')}) {len(body)} 条 → subtitle_{lan}.srt")
        except Exception as e:
            print(f"  ✗ {lan} 下载失败: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
