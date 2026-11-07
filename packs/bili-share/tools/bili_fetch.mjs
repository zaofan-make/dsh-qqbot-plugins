/**
 * bili_fetch.mjs —— B站抓取「速查卡」（用户扩展工具，AI 可调）
 *
 * ★ 2026-11-07 改版：B 站抓取现在统一在 bili_grab（纯 node + ffmpeg，不需要 python、
 *   不需要浏览器）。本工具不再教旧流程，只负责把「现在该怎么用」一句话摆出来，
 *   外加按 BV 号拼好可直接复制的那段。
 *
 * 契约：export default { name, description, inputSchema, run(args, env) } → { ok, msg }
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAB_TOOL = join(HERE, 'bili_grab.mjs');
const CMD_FILE = join(HERE, '..', 'commands', '扒b站.mjs');

function parseBvid(s) {
  const m = String(s || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

export default {
  name: 'bili_fetch',
  description:
    'B站抓取速查卡：告诉你现在该用 bili_grab（纯 node+ffmpeg，不用 python/浏览器）还是 /扒b站 命令。填 bvid 会把命令拼好。',
  inputSchema: {
    bvid: { type: 'string', description: 'BV 号 / 视频完整 URL / b23.tv 短链（填了就把命令拼好）' },
    action: {
      type: 'string',
      enum: ['usage', 'where'],
      description: 'usage(默认)=给用法；where=只看文件在哪',
    },
  },

  run: async (args) => {
    const action = String(args?.action || 'usage');
    const bv = parseBvid(args?.bvid) || '<BV号>';

    if (action === 'where') {
      return {
        ok: true,
        msg: [
          '工具：' + GRAB_TOOL,
          '命令：' + CMD_FILE,
          '数据：' + join(HERE, '..', 'data'),
          'ffmpeg：D:/newwenjianjia/videocut/ffmpeg/bin/ffmpeg.exe（换机器改 bili_grab.mjs 顶部常量）',
        ].join('\n'),
      };
    }

    return {
      ok: true,
      msg: [
        '## 一句话',
        'B站抓取统一走 **bili_grab**（纯 node + ffmpeg，不用 python、不用浏览器）',
        '',
        '## AI 侧',
        '```',
        `bili_grab bvid=${bv}                 # 后台跑，跑完注入提醒`,
        `bili_grab bvid=${bv} sync=true       # 当场等结果`,
        `bili_grab bvid=${bv} frames=false    # 只要字幕`,
        `bili_grab bvid=${bv} perSheet=16     # 一张长图 16 帧`,
        '```',
        '',
        '## 群友侧',
        '```',
        `/扒b站 ${bv}`,
        `/扒b站 ${bv} 字幕 | 16 | 匀速 | 等待`,
        '/扒b站   （先引用一条带 B 站链接的消息，不用打参数）',
        '```',
        '',
        '## 会产出什么',
        '字幕 md/txt/srt/json、简介 info.md、长图 frames/sheet_NN.jpg',
        '都落在扩展包 data/_out/<BV号>/ 下',
        '',
        '（旧的 python 脚本已移除，主流程不需要它们；SESSDATA 在设置页填，和分享卡片共用）',
      ].join('\n'),
    };
  },
};
