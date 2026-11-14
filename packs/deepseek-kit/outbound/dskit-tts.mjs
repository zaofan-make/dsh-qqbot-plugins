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
import { loadConfig, resolveApiKey, managerForDataRoot, agentOfTarget } from '../lib/dskit-config-v5.mjs';
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

    /** 合成一条并发送；返回 true=语音真的发出去了 */
    const speakOne = async (job) => {
      try {
        const r = await ttsText({ cfg, text: job.text, voice: job.voice || cfg.ttsVoice, format: cfg.ttsFormat });
        const dir = join(String(ctx?.dataRoot || '.'), '.qqbot-extensions', '.state', 'dskit', 'tts');
        mkdirSync(dir, { recursive: true });
        // ★ 2026-11-14（CodeRabbit 审查）：QQ 语音只认带头的音频容器。
        //   设置里允许 pcm（裸采样），直接发会被当成未知二进制 ⇒ 发送失败、用户收不到任何东西。
        //   这里统一包一层 WAV 头（24kHz / 16bit / 单声道，与设置页提示一致），文件名也落 .wav。
        const isPcm = String(cfg.ttsFormat).toLowerCase() === 'pcm';
        const buf = isPcm ? wrapWavPcm16(r.buffer) : r.buffer;
        const ext = isPcm ? 'wav' : (cfg.ttsFormat === 'pcm' ? 'pcm' : 'wav');
        const file = join(dir, `${randomUUID()}.${ext}`);
        writeFileSync(file, buf);
        const ok = await ctx.sendMedia({ path: file, kind: 'voice' });
        if (ok === false) ctx.note?.(`[dskit-tts] 语音发送失败: ${file}`);
        return ok !== false;
      } catch (err) {
        ctx.note?.(`[dskit-tts] 合成失败: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };

    // 2) 纯语音：**先发成功、再消灭正文**
    //    ★ 2026-11-14（CodeRabbit 审查）：原来先 ctx.annihilate 再丢后台合成 ——
    //    合成抛错或发送返回 false 时，这条回复**彻底消失**（用户既没文字也没语音）。
    //    现在改成：合成+发送成功才消灭；失败就把标记里的文字当普通文本补发出去，保证不丢信息。
    if (!cleaned) {
      // ★ 2026-11-14（CodeRabbit 复审）：**按段记账**，别用 anyOk 一把梭。
      //   两段标记时：第 1 段成功、第 2 段合成/发送失败 → anyOk 仍为 true → 整条 annihilate
      //   ⇒ 第 2 段的内容**永远收不到**（既没语音也没文字）。现在：成功的发语音，
      //   失败的把文字单独补发一条，一段都不丢。
      const failed = [];
      let anyOk = false;
      for (const job of jobs) {
        if (await speakOne(job)) anyOk = true;
        else failed.push(job.text);
      }
      if (anyOk) {
        try { ctx.annihilate('dskit-tts: voice-only'); } catch { /* 已被消灭 */ }
        if (failed.length) {
          const tail = failed.join('\n');
          try {
            // 出站 ctx 的 send(text) 是「先被动后主动」的独立通道，annihilate 之后仍可补发
            await ctx.send?.(tail);
          } catch { ctx.note?.('[dskit-tts] 失败片段补发文本也失败了'); }
        }
        return;
      }
      // 一条都没发出去 → 退化成文本，别让主人的话蒸发
      const fallback = jobs.map((j) => j.text).join('\n');
      try {
        ctx.rewrite(fallback);
      } catch { /* 改写失败就只能发原文（含标记） */ }
      await next();
      return;
    }

    // 3) 有正文：正文照常走，语音丢后台（不卡住消息）
    try { ctx.rewrite(cleaned); } catch { /* 改写失败就按原文发 */ }
    await next();

    const sendAll = async () => {
      for (const job of jobs) await speakOne(job);
    };
    if (typeof ctx.background === 'function') ctx.background(sendAll);
    else await sendAll();
    return;
  } catch {
    // 出站扩展**绝不能**吞掉正文：任何异常都放行
    return next();
  }
}

/**
 * 把裸 PCM(16bit 小端单声道 24kHz) 包成一个标准 WAV 容器。
 * @param {Buffer|Uint8Array} pcm 裸采样
 * @returns {Buffer}
 */
function wrapWavPcm16(pcm) {
  const data = Buffer.from(pcm);
  const h = Buffer.alloc(44);
  const byteRate = 24000 * 2; // 24000Hz * 2byte * 1ch
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);          // fmt chunk size
  h.writeUInt16LE(1, 20);           // PCM
  h.writeUInt16LE(1, 22);           // mono
  h.writeUInt32LE(24000, 24);       // sample rate
  h.writeUInt32LE(byteRate, 28);    // byte rate
  h.writeUInt16LE(2, 32);           // block align
  h.writeUInt16LE(16, 34);          // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
