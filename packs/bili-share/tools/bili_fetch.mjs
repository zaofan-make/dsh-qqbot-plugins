/**
 * bili_fetch.mjs —— B站视频/字幕抓取【入口】工具（用户扩展工具，AI 可调）
 *
 * ★ 2026-10-25 重写（主人要求"让我秒懂、不浪费 token"）：
 *   旧版只说"推荐配合 bsk"，没给可照抄的命令，结果 agent 会：
 *     ① 直接跑 fetch_bili.py（未登录）→ 拿不到 AI 字幕（subtitle:false）
 *     ② 退化成"下视频 + 抽帧 + 读画面"→ 慢、贵、还不准
 *   现在本工具直接吐【可复制粘贴的命令模板】，bvid 参数能自动抠号并拼好。
 *
 * ★ 一句话记住：
 *   **字幕 → bsk evaluate 在页面里 fetch（自带登录态）；视频文件 → fetch_bili.py。**
 *   SESSDATA 是 HttpOnly，`document.cookie` 读不到 —— 必须让浏览器自己 fetch。
 *
 * 契约：export default { name, description, inputSchema, run(args, env) } → { ok, msg }
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = join(HERE, 'bili-tools');
const SCRIPT = join(TOOL_DIR, 'fetch_bili.py');
const FFMPEG = 'D:/newwenjianjia/videocut/ffmpeg/bin/ffmpeg.exe';

function listScripts() {
  if (!existsSync(TOOL_DIR)) return [];
  try {
    return readdirSync(TOOL_DIR)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const p = join(TOOL_DIR, f);
        let size = 0;
        try { size = statSync(p).size; } catch { /* ignore */ }
        return { name: f, size };
      });
  } catch {
    return [];
  }
}

/** 从输入里抠 BV 号（BV 号 / 完整 URL / b23.tv 短链文字都行） */
function parseBvid(s) {
  const m = String(s || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

export default {
  name: 'bili_fetch',
  description: "B站抓取入口。字幕走 bsk evaluate 页面内 fetch（SESSDATA 是 HttpOnly），视频文件才用 fetch_bili.py。传 bvid 直接给命令模板。",
  inputSchema: {
    bvid: { type: 'string', description: 'BV 号 / 视频完整 URL / b23.tv 短链。填了就直接拼好命令，不用自己替换 BV 占位符' },
    action: {
      type: 'string',
      enum: ['usage', 'where'],
      description: 'usage(默认)=给完整用法与命令模板；where=只回答脚本放在哪',
    },
  },

  run: async (args) => {
    const action = String(args?.action || 'usage');
    const bv = parseBvid(args?.bvid);
    const hasBv = !!bv;
    const BV = hasBv ? bv : '<BV号>';
    const scripts = listScripts();

    // ── where：只回答位置 ──────────────────────────────────────────
    if (action === 'where') {
      return {
        ok: true,
        msg: [
          '脚本目录：' + TOOL_DIR,
          '主脚本：' + SCRIPT,
          '文件：' + scripts.map((s) => s.name).join('、'),
          'ffmpeg：' + FFMPEG,
        ].join('\n'),
      };
    }

    const L = [];
    const push = (...xs) => L.push(...xs);

    if (hasBv) {
      push('**已识别 BV 号：`' + bv + '`** —— 下面的命令里 BV 已填好，你只需要替换 `<CID>` 和 `<sid>`。', '');
    }

    push('## 结论先行');
    push('');
    push('| 要什么 | 用什么 | 为什么 |');
    push('|---|---|---|');
    push('| **字幕（优先）** | **bsk evaluate + 页面内 fetch** | 浏览器自带登录态，能拿 AI 字幕 |');
    push('| 视频文件 | fetch_bili.py | 只有这个需要下载 |');
    push('');
    push('⚠️ **`document.cookie` 拿不到 SESSDATA**（HttpOnly）。所以"读 cookie → 传给 python"这条路是死的。');
    push('必须让**浏览器自己 fetch** —— 它会自动附上 HttpOnly cookie。', '');
    push('---', '');

    push('## A. 拿字幕（推荐 · 4 步）', '');
    push('### A1 开浏览器到视频页');
    push('```bash');
    push('export PATH="$PATH:/c/Users/作早饭/.local/bin"');
    push('bsk session start --url "https://www.bilibili.com/video/' + BV + '/"');
    push('```');
    push('返回的 session id 记作 `<sid>`（4 位字母）。', '');

    push('### A2 取 cid + 字幕列表（一条命令搞定）');
    push('```bash');
    push('bsk evaluate "fetch(\'https://api.bilibili.com/x/player/wbi/v2?bvid=' + BV + '&cid=\'+(window.__INITIAL_STATE__&&window.__INITIAL_STATE__.cid)+\'\',{credentials:\'include\'}).then(r=>r.json()).then(d=>JSON.stringify({cid:window.__INITIAL_STATE__&&window.__INITIAL_STATE__.cid,sub:d.data&&d.data.subtitle}))" --session <sid>');
    push('```');
    push('返回里找 `sub.subtitles[0].subtitle_url`（`lan:"ai-zh"` 就是 AI 中文字幕）。');
    push('**`credentials:\'include\'` 是命门**，漏了就只有空数组。', '');

    push('### A3 拉字幕正文');
    push('```bash');
    push('bsk evaluate "fetch(\'https://<把 A2 的 subtitle_url 前面补 https:>\').then(r=>r.json()).then(d=>d.body.map(x=>\'[\'+Math.floor(x.from)+\'s] \'+x.content).join(\'\\n\'))" --session <sid>');
    push('```');
    push('直接得到「`[秒] 文字`」逐行稿 —— 这就是整理成摘要 / skill 的原料。', '');

    push('### A4 收尾');
    push('```bash');
    push('bsk session stop --session <sid>');
    push('```', '');
    push('---', '');

    push('## B. 下视频文件（字幕拿不到时的兜底）', '');
    push('```bash');
    push('# 1) 下载 m4s（纯标准库，不需要 pip）');
    push('python "' + SCRIPT + '" ' + BV + ' --qn 32');
    push('');
    push('# 2) 合并');
    push('FF=' + FFMPEG);
    push('$FF -y -i video.m4s -i audio.m4s -c copy video.mp4');
    push('');
    push('# 3) 拼网格看全片（不需要 ImageMagick）');
    push('$FF -y -i video.mp4 -vf "fps=1/5.8,scale=210:-1,tile=5x4" -frames:v 1 grid.jpg');
    push('```');
    push('');
    push('输出在 `<cwd>/_bili/<BV号>/`。');
    push('**ffmpeg 固定路径：`' + FFMPEG + '`**');
    push('（它在 Windows PATH 里，但 MSYS bash 的 `which ffmpeg` 找不到 —— 直接用绝对路径最稳）', '');
    push('---', '');

    push('## 三个已知坑', '');
    push('| 坑 | 现象 | 规避 |');
    push('|---|---|---|');
    push('| `document.cookie` 是空 | 拿不到 SESSDATA | HttpOnly 限制，改用 A2 的页面内 fetch |');
    push('| 漏 `credentials:\'include\'` | 字幕列表 `subtitles: []` | 必须带，浏览器才附 cookie |');
    push('| 直接跑 python 脚本没字幕 | 输出 `"subtitle": false` | 脚本未登录；字幕走 A，B 只负责下文件 |', '');

    push('---', '');
    push('## 环境');
    push('- 脚本目录：`' + TOOL_DIR + '`');
    push('- 主脚本：`' + SCRIPT + '`');
    push('- 文件：' + (scripts.length ? scripts.map((s) => '`' + s.name + '`').join('、') : '（空）'));
    push('- bsk CLI：`/c/Users/作早饭/.local/bin/bsk`（bash 里要先 `export PATH`）');

    return { ok: true, msg: L.join('\n') };
  },
};
