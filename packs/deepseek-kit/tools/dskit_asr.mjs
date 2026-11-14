/**
 * dskit_asr.mjs —— DeepSeek 官方语音识别（本地音频文件 → 文字）
 *
 * 为什么还要它：QQ 自带的语音转写一般够用，但遇到
 *   · 转写结果不满意 / 方言 / 口音重
 *   · 手里的音频是**本地文件**（录音、视频抽出的音轨）
 * 就需要自己调一次 ASR。官方限制：16bit PCM WAV 或 Ogg Opus，≤8MiB，≤120 秒。
 */
import { cfgForCall, toolVisible } from '../lib/dskit-config-v5.mjs';
import { asrFile } from '../lib/dskit-api.mjs';

export default {
  name: 'dskit_asr',
  description:
    '用 DeepSeek 官方 ASR 把本地音频转成文字。'
    + '只支持 16bit PCM WAV 或 Ogg Opus、≤8MiB、≤120 秒；超了请先转码/切段。'
    + 'QQ 语音消息自带的转写已够用时不必调它。',
  inputSchema: {
    path: { type: 'string', description: '本机音频文件绝对路径（.wav / .ogg）' },
  },

  enabled: (env) => toolVisible(env, 'enableAsr'),

  async run(args, env) {
    const cfg = cfgForCall(env);
    if (!cfg) return { ok: false, msg: '没有可用 Key（非 DeepSeek 官方会话时，请在设置页填自己的 Key）' };

    const path = String(args?.path || '').trim();
    if (!path) return { ok: false, msg: 'path 不能为空' };

    try {
      const r = await asrFile({ cfg, filePath: path });
      const sec = (r.durationMs / 1000).toFixed(1);
      return {
        ok: true,
        msg: r.text ? `${r.text}\n\n[时长 ${sec}s，request_id=${r.requestId ?? '-'}]` : '（识别结果为空——音频里可能没有语音）',
      };
    } catch (err) {
      return { ok: false, msg: String(err instanceof Error ? err.message : err) };
    }
  },
};
