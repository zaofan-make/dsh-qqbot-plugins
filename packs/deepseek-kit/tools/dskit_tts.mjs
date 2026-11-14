/**
 * dskit_tts.mjs —— 语音合成的「提示牌 + 试听」工具（真正发语音的是出站扩展 dskit-tts.mjs）
 *
 * 为什么要有这个工具：出站扩展是"你写标记它才合成"，AI 不知道有这回事就不会用。
 * 所以这里放一块**用法说明**，再加上一条「试听」通路，方便验证配置是否可用。
 *
 * action：
 *   guide   （默认）返回标记语法说明
 *   test    合成一句并发到当前会话（验证 key/音色是否可用）
 *   save    只合成、返回本地文件路径（不发消息）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cfgForCall, toolVisible } from '../lib/dskit-config.mjs';
import { ttsText } from '../lib/dskit-api.mjs';

const GUIDE = [
  '【语音合成 · 用法（DeepSeek TTS）】',
  '在正文里写标记，出站时会自动剥掉标记并合成语音发出去：',
  '  · 基本：[语音合成]主人早上好～[/语音合成]',
  '  · 换音色：[语音合成|tide]这句用男声读[/语音合成]（stella=女 / tide=男）',
  '  · 开闭同标记也认：[语音合成]你好[语音合成]',
  '',
  '规则：',
  '  1. 标记段整段摘掉，剩下正文照常发；',
  '  2. 如果剥完一个字不剩 → 这条只发语音（纯语音回复）；',
  '  3. 一条正文里可以写多个标记，会逐条合成、逐条发；',
  '  4. **不支持**情绪/语速/音量参数（DeepSeek TTS 没有这些），别照火山那套写；',
  '  5. 单条最多 10,000 个计费字符，超了会失败。',
].join('\n');

export default {
  name: 'dskit_tts',
  description:
    '语音合成：告诉你正文里怎么写 [语音合成] 标记（出站扩展负责真正合成发送），'
    + '也能 action=test 合成一句试听、或 action=save 只存文件。',
  inputSchema: {
    action: { type: 'string', description: 'guide（默认，用法说明）| test（合成并发到当前会话）| save（只存文件）' },
    text: { type: 'string', description: 'action=test/save 时要朗读的文本' },
    voice: { type: 'string', description: '可选音色覆盖：stella（女）/ tide（男）' },
  },

  enabled: (env) => toolVisible(env, 'enableTts'),

  async run(args, env) {
    const cfg = cfgForCall(env);
    if (!cfg) return { ok: false, msg: '没有可用 Key（非 DeepSeek 官方会话时，请在设置页填自己的 Key）' };

    // ★ 2026-11-14 修：原来这里直接引用未声明的 `dataRoot`（ReferenceError: dataRoot is not defined）。
    //   插件 1.12.31 起 run() 的 env 才有 dataRoot，但仍要三级兜底（老宿主/老扩展环境可能没有）。
    const dataRoot = String(env?.dataRoot || env?.manager?.dataRoot || env?.cwd || '').trim() || '.';

    const action = String(args?.action || 'guide').trim().toLowerCase();
    if (action === 'guide') return { ok: true, msg: GUIDE };

    const text = String(args?.text || '').trim();
    if (!text) return { ok: false, msg: 'action=test/save 时需要给 text' };

    try {
      const r = await ttsText({ cfg, text, voice: String(args?.voice || '').trim() || cfg.ttsVoice, format: cfg.ttsFormat });
      const dir = join(dataRoot || '.', '.qqbot-extensions', '.state', 'dskit', 'tts');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${randomUUID()}.${cfg.ttsFormat === 'pcm' ? 'pcm' : 'wav'}`);
      writeFileSync(file, r.buffer);

      if (action === 'save') return { ok: true, msg: `已合成：${file}（${r.buffer.length} 字节）` };

      let sent = false;
      const sendVoice = env?.voice ?? env?.media;
      if (typeof sendVoice === 'function') {
        try {
          const ok = await sendVoice(file);
          sent = ok !== false;
        } catch { /* 发不出去也不影响合成 */ }
      }
      return {
        ok: true,
        msg: `合成完成：${file}（${r.buffer.length} 字节）${sent ? '，已发到当前会话' : '，但发送失败（文件还在）'}`,
      };
    } catch (err) {
      return { ok: false, msg: String(err instanceof Error ? err.message : err) };
    }
  },
};
