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
import { cfgForCall, toolVisible } from '../lib/dskit-config-v5.mjs';
import { ttsText } from '../lib/dskit-api.mjs';

const GUIDE = [
  '【语音合成 · 用法（DeepSeek TTS）】',
  '★ 日常就这么用：**不要调用任何工具**，直接在回复正文里写标记 —— 出站时自动合成语音发出去。',
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
    '【发语音不要调用本工具】直接在回复正文里写标记即可：[语音合成]要读出来的话[/语音合成]，'
    + '换音色写 [语音合成|tide]…[/语音合成]（stella=女声 / tide=男声）。'
    + '出站扩展会自动剥掉标记、合成语音并作为语音消息发出，不额外产生请求。'
    + '本工具**只**用于这三种情况：action=guide 查完整语法、'
    + 'action=test 合成一句试听（验证 Key/音色配置）、action=save 只落地文件不发消息。',
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
      // ★ 2026-11-14：多通道兜底 + 说清为什么没发出去。
      //   ① env.voice / env.media / env.caps.voice —— 扩展能力包（依赖 caps 里 sender 的方法，
      //      插件 1.12.32 之前这里被 `{...sender}` 展开搞丢了原型方法 ⇒ 静默 false）
      //   ② 直连 env.sender.sendMedia(env.replyTarget, …) —— 这条用的是**原对象**，最可靠
      //   按顺序试，第一个成功的就停；全失败则把每一步的原因拼出来。
      const direct = (env?.sender && typeof env.sender.sendMedia === 'function' && env?.replyTarget)
        ? ((src) => env.sender.sendMedia(env.replyTarget, 'voice', { localPath: src }))
        : undefined;
      const attempts = [
        ['env.voice', (typeof env?.voice === 'function' ? env.voice : undefined)],
        ['env.media', (typeof env?.media === 'function' ? (s) => env.media('voice', s) : undefined)],
        ['env.caps.voice', (typeof env?.caps?.voice === 'function' ? env.caps.voice : undefined)],
        ['env.sender.sendMedia', direct],
      ];
      const why = [];
      for (const [name, fn] of attempts) {
        if (typeof fn !== 'function') { why.push(`${name}=无`); continue; }
        try {
          const ok = await fn(file);
          if (ok !== false) { sent = true; why.push(`${name}=ok`); break; }
          why.push(`${name}=false`);
        } catch (e) {
          why.push(`${name}=抛错(${e instanceof Error ? e.message : String(e)})`);
        }
      }
      return {
        ok: sent,
        msg: `合成完成：${file}（${r.buffer.length} 字节）`
          + (sent ? '，已发到当前会话' : `，但没发出去 —— 通道尝试：[${why.join(' / ')}]`),
      };
    } catch (err) {
      return { ok: false, msg: String(err instanceof Error ? err.message : err) };
    }
  },
};
