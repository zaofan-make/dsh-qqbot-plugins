/**
 * dskit-tts.mjs —— 【出站扩展】正文里的 [语音合成]…[/语音合成] 标记 → DeepSeek 语音消息
 *
 * 放置：`{dataRoot}/.qqbot-extensions/outbound/dskit-tts.mjs`（pack 装好后自动铺过去）
 *
 * 标记语法（只有两种，DeepSeek TTS 不支持情绪/语速，别照搬火山的写法）：
 *   [语音合成]你好呀[/语音合成]                 ← 用设置里的默认音色
 *   [语音合成|tide]这句用男声读[/语音合成]      ← 单次覆盖音色（stella=女 / tide=男）
 *   开闭同标记也认：`[语音合成]…[语音合成]`
 *
 * 行为：
 *   1. phase='send' 时扫正文，把标记整段摘出来；
 *   2. 剩下的正文用 ctx.rewrite() 写回去；
 *   3. 一个字都不剩 → ctx.annihilate()，只发语音；
 *   4. 音频合成后写本地文件，用 ctx.sendMedia({path, kind:'voice'}) 补发。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, resolveApiKey, managerForDataRoot, agentOfTarget } from '../lib/dskit-config.mjs';
import { ttsText } from '../lib/dskit-api.mjs';

export const name = 'dskit-tts';

/**
 * 设置页（插件面板会自动按这份 schema 渲染表单）。
 * 配置落在 `{dataRoot}/.qqbot-extensions/.state/ext-config/<扩展id>.json`，工具与出站共用。
 */
export const qqbotSettingsPage = {
  title: 'DeepSeek 全家桶 · 联网/OCR/ASR/TTS',
  desc:
    '填一个 DeepSeek API Key 就能用五个能力：dskit_search（服务端联网搜索，支持深度思考搜索与按图搜索）、'
    + 'dskit_readurl（读链接）、dskit_ocr（文档/图片转文字）、dskit_asr（语音转文字）、'
    + '以及 [语音合成] 标记 → 真的语音消息。'
    + '没填 Key 时这些工具对 AI 完全不可见。价格见 DeepSeek 官网「模型 & 价格」。',
  schema: [
    { key: 'apiKey', type: 'string', label: 'DeepSeek API Key', default: '', placeholder: 'sk-…（platform.deepseek.com → API keys）' },
    { key: 'baseUrl', type: 'string', label: 'API Base URL', default: 'https://api.deepseek.com', hint: '一般不用改；走代理/中转时填自己的地址' },
    { key: 'model', type: 'string', label: '联网工具用的模型', default: 'deepseek-flash', hint: '官方文档明确：联网/阅读链接只支持 deepseek-flash' },
    { key: 'enableSearch', type: 'bool', label: '启用 dskit_search（联网搜索）', default: true },
    { key: 'enableReadUrl', type: 'bool', label: '启用 dskit_readurl（阅读链接）', default: true },
    { key: 'enableOcr', type: 'bool', label: '启用 dskit_ocr（OCR）', default: true },
    { key: 'enableAsr', type: 'bool', label: '启用 dskit_asr（语音识别）', default: true },
    { key: 'enableTts', type: 'bool', label: '启用 dskit_tts（语音合成工具）', default: true },
    { key: 'ttsEnabled', type: 'bool', label: '出站语音合成（[语音合成] 标记）', default: true, hint: '关掉后正文里的标记会被原样保留，不合成' },
    { key: 'ttsVoice', type: 'select', label: 'TTS 默认音色', default: 'stella', options: ['stella', 'tide'], hint: 'stella=海星（女）/ tide=暗潮（男）' },
    { key: 'ttsFormat', type: 'select', label: 'TTS 输出格式', default: 'wav', options: ['wav', 'pcm'], hint: 'pcm 是裸流（24kHz/16bit/单声道），QQ 语音要 wav；建议保持 wav' },
    { key: 'searchThinkingDefault', type: 'bool', label: '搜索默认开「深度思考搜索」', default: false, hint: '开=多步搜索/打开网页/页内查找，更准更慢更贵；单个调用可以用 thinking 参数覆盖' },
  ],
};

/** `[语音合成]…[/语音合成]` / `[语音合成|tide]…[语音合成]` */
const MARK_RE = /\[语音合成(?:\|([\w-]+))?\]([\s\S]*?)\[\/?语音合成\]/g;

export default async function onOutbound(ctx, next) {
  try {
    // 只在正文发送前处理；turnEnd 阶段只做收尾
    if (ctx?.phase && ctx.phase !== 'send') return next();

    const cfg0 = loadConfig(ctx?.dataRoot);
    if (cfg0.ttsEnabled === false) return next();

    const original = String(ctx?.text ?? '');
    if (!original.includes('[语音合成')) return next();

    // ★ 2026-11-14（主人实测 opencode 会话也合成了）：**按目标会话**判能不能用宿主 Key。
    //   非 DeepSeek 官方会话 + 面板没填自己的 Key ⇒ 直接放行（标记原样保留，不合成、不剥）。
    //   出站 ctx 没有 agent，只有 { target, dataRoot }：靠 globalThis.__qqbotManagers 反查。
    const _mgr = managerForDataRoot(ctx?.dataRoot);
    const _agent = agentOfTarget(_mgr, ctx?.target);
    const _key = resolveApiKey(cfg0, _mgr, _agent);
    if (!_key) {
      try { ctx.note?.('[dskit-tts] 跳过：非 DeepSeek 官方会话且未配置自己的 Key'); } catch { /* ignore */ }
      return next();
    }
    const cfg = { ...cfg0, apiKey: _key };

    // 1) 收集标记里的文本，其余正文保留
    const jobs = [];
    MARK_RE.lastIndex = 0;
    let m;
    while ((m = MARK_RE.exec(original)) !== null) {
      const voice = String(m[1] || '').trim();
      const said = String(m[2] || '').trim();
      if (said) jobs.push({ text: said, voice: voice || '' });
    }
    if (!jobs.length) return next(); // 标记是空的，别动正文

    const cleaned = original.replace(MARK_RE, '').replace(/[ \t]+\n/g, '\n').trim();

    // 2) 没有剩余正文 = 纯语音
    if (!cleaned) {
      try { ctx.annihilate('dskit-tts: voice-only'); } catch { /* 已被消灭 */ }
    } else {
      try { ctx.rewrite(cleaned); } catch { /* 改写失败就按原文发 */ }
      await next();
    }

    // 3) 合成 + 发送（丢后台，别卡住正文）
    const sendAll = async () => {
      for (const job of jobs) {
        try {
          const r = await ttsText({ cfg, text: job.text, voice: job.voice || cfg.ttsVoice, format: cfg.ttsFormat });
          const dir = join(String(ctx?.dataRoot || '.'), '.qqbot-extensions', '.state', 'dskit', 'tts');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${randomUUID()}.${cfg.ttsFormat === 'pcm' ? 'pcm' : 'wav'}`);
          writeFileSync(file, r.buffer);
          const ok = await ctx.sendMedia({ path: file, kind: 'voice' });
          if (ok === false) ctx.note?.(`[dskit-tts] 语音发送失败: ${file}`);
        } catch (err) {
          ctx.note?.(`[dskit-tts] 合成失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    if (typeof ctx.background === 'function') ctx.background(sendAll);
    else await sendAll();

    if (!cleaned) return; // 已 annihilate，不要调 next()
    return;
  } catch {
    // 出站扩展**绝不能**吞掉正文：任何异常都放行
    return next();
  }
}
