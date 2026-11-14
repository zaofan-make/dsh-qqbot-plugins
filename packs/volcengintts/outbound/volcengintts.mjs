/**
 * volcengintts.mjs — 【出站扩展】正文里的 [语音合成]…[/语音合成] 标记 → 真实语音消息
 *
 * 放到 `{dataRoot}/.qqbot-extensions/outbound/volcengintts.mjs` 即生效（改完 /tools-reload）。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────────────
 *   1. 在 phase='send'（正文发送前）扫描 ctx.text，把 `[语音合成]…[/语音合成]` 段抽出来；
 *   2. 标记从正文里剥掉，剩下的正文用 ctx.rewrite() 写回去；
 *   3. 若剥完一个字都不剩 → ctx.annihilate() 消灭这条正文，**只发语音**；
 *   4. 语音合成丢后台（ctx.background），走「先被动后主动」通道 ctx.sendMedia({path}) 补发。
 *
 * ── 标记语法 ──────────────────────────────────────────────────────────────
 *   [语音合成]你好呀[/语音合成]                    ← 开闭都可以，`[语音合成]…[语音合成]` 也认
 *   [语音合成|开心]今天好累[/语音合成]              ← 情绪（emotion + 语速微调）
 *   [语音合成 情绪=撒娇 强度=5 语速=0.9 音量=1.1]嗯～[/语音合成]
 *   多个标记可以同一条正文里出现，逐条合成、逐条发。
 *
 * ── 鉴权（对齐 火山 V3 文档，2026-10-19 改）────────────────────────────────
 *   新版控制台：X-Api-Key + X-Api-Resource-Id
 *   旧版控制台：X-Api-App-Id + X-Api-Access-Key + X-Api-Resource-Id
 *   → 配置里有 appId+accessToken 就优先走旧版；否则用 apiKey。
 *   Resource-Id 自动判定：音色以 ICL_ 开头 = 声音复刻 2.0 → seed-icl-2.0，否则 seed-tts-2.0。
 *
 * ── 音频参数（文档 req_params.audio_params）────────────────────────────────
 *   format / sample_rate / speech_rate(-50~100) / loudness_rate(-50~100) /
 *   emotion（happy|sad|angry|surprised|coldness|excited|neutral…）/ emotion_scale(1~5)
 *   req_params.model：seed-tts-2.0-standard（快）| seed-tts-2.0-expressive（表现力强）
 */
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSettings, ensureOutDir, pickSpeaker, PACK_DIR, resolveResourceId, altResourceId } from '../lib/settings.mjs';
import { buildHeaders } from '../lib/settings.mjs';
import { VOICES_PICKER } from '../lib/voices.mjs';

export const name = 'tts-voice';

const DEFAULT_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

/**
 * 出站 ctx 里**没有** config（只有 dataRoot），所以配置得自己读。
 * dataRoot 在 onOutbound 里落到这个模块变量，loadCfg 用它拼 ext-config 路径。
 */
let _dataRoot = '';

/**
 * 面板设置（出现在「QQ 机器人扩展 → 设置」里）。
 * 值会存到 {dataRoot}/.qqbot-extensions/.state/ext-config/volcengintts.json，
 * lib/settings.mjs 正是从这个路径读，所以填一次＝三处生效。
 */
export const qqbotSettingsPage = {
  title: 'TTS 语音合成 · 火山方舟',
  desc: '填好鉴权与音色就能用：正文里写 [语音合成]文本[/语音合成] 会自动变成语音消息发出去。注册与开通步骤见本包 README。',
  schema: [
    {
      key: 'authMode', type: 'select', label: '鉴权方式', default: 'apiKey',
      options: ['apiKey', 'legacy'],
      hint: '火山方舟「音色详情」页底部的服务接口认证信息给的是 APP ID + Access Token → 选 legacy。apiKey 是另一条路（方舟 → API Key 管理，只要一串 key）。',
    },
    { key: 'apiKey', type: 'string', label: 'API Key', default: '', placeholder: '粘贴控制台里生成的 API Key' },
    { key: 'appId', type: 'string', label: 'APP ID', default: '', hint: '方舟控制台「音色详情」页底部，一串纯数字' },
    { key: 'accessToken', type: 'string', label: 'Access Token', default: '', hint: '同一页底部，点眼睛显示后复制（注意别和 Secret Key 搞混，要的是 Access Token）' },
    {
      key: 'defaultSpeaker', type: 'select', searchable: true, label: '默认音色（可搜索）', default: 'Vivi 2.0｜zh_female_vv_uranus_bigtts',
      // 完整中文音色表来自 lib/voices.mjs（从官方音色表 CSV 自动生成，通用场景全量 + 角色扮演精选）
      // label 形如「Vivi 2.0｜zh_female_vv_uranus_bigtts」，lib/settings.mjs 的 resolveVoice 会自动剥出 id
      options: VOICES_PICKER.map((v) => v.label),
      hint: `共 ${VOICES_PICKER.length} 个中文音色（通用场景全量 + 角色扮演精选），格式是「中文名｜音色ID」。列表里没有的：用下面「自定义音色 ID」直接填 voice_type，或去控制台「音色详情」翻完整 294 个。`,
    },
    { key: 'customSpeaker', type: 'string', label: '自定义音色 ID（优先于上面的下拉）', default: '', placeholder: '如 zh_female_xxx_bigtts' },
    {
      key: 'resourceId', type: 'select', label: 'Resource-Id', default: 'auto',
      options: ['auto', 'seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-1.0', 'seed-icl-2.0'],
      hint: 'auto 会按音色自动判断（_mars_/_moon_ 结尾→1.0，S_→复刻1.0，其余→2.0）。报 resource mismatched 时才需要手动指定。',
    },
    {
      key: 'model', type: 'select', label: '模型', default: 'seed-tts-2.0-expressive',
      options: ['seed-tts-2.0-expressive', 'seed-tts-2.0-standard'],
      hint: 'expressive = 表现力强（支持情绪/语气指令）；standard = 更快更稳。',
    },
    { key: 'format', type: 'select', label: '音频格式', default: 'mp3', options: ['mp3', 'wav', 'pcm', 'ogg_opus'] },
    { key: 'sampleRate', type: 'select', label: '采样率', default: '24000', options: ['24000', '16000', '48000'] },
    { key: 'emotionEnabled', type: 'bool', label: '启用情绪/语调', default: true, hint: '关掉就只读字面文本（音色不支持情感时更稳）' },
    { key: 'voiceOnlyEnabled', type: 'bool', label: '纯语音模式', default: true, hint: '正文里除了语音标记什么都不剩时，只发语音不发文字' },
    { key: 'outDir', type: 'string', label: '音频输出目录', default: '', hint: '留空 = 包内 out/ 目录' },
  ],
};

/** 读合并后的配置（面板 > 旧 tts-config.json > 包内默认） */
function loadCfg() {
  try {
    return loadSettings({ dataRoot: _dataRoot }).cfg;
  } catch {
    return { ...loadSettings({}).cfg };
  }
}

/**
 * 情绪表：中文词 → 火山 emotion 值 + 语速/音量微调（不动音色）
 * 火山支持的情感因音色而异，不支持的音色会忽略/报错，失败自动降级为"不带 emotion 重试"。
 */
const EMOTIONS = {
  开心: { emotion: 'happy', rate: 8 }, 高兴: { emotion: 'happy', rate: 8 },
  欢快: { emotion: 'happy', rate: 10 }, 愉快: { emotion: 'happy', rate: 6 },
  兴奋: { emotion: 'excited', rate: 16, loud: 6 }, 激动: { emotion: 'excited', rate: 14, loud: 6 },
  伤心: { emotion: 'sad', rate: -10 }, 难过: { emotion: 'sad', rate: -10 },
  失落: { emotion: 'sad', rate: -8 }, 委屈: { emotion: 'sad', rate: -10 },
  生气: { emotion: 'angry', rate: 8, loud: 12 }, 愤怒: { emotion: 'angry', rate: 10, loud: 15 },
  傲娇: { rate: 6 }, 撒娇: { rate: -6, loud: -4 }, 温柔: { rate: -8 }, 软萌: { rate: -8 },
  害羞: { rate: -5 }, 平静: { emotion: 'neutral', rate: 0 }, 严肃: { emotion: 'neutral', rate: -3 },
  冷淡: { emotion: 'coldness', rate: -6, loud: -6 },
  慵懒: { rate: -15 }, 困: { rate: -18 }, 疲惫: { rate: -14 },
  惊讶: { emotion: 'surprised', rate: 8 }, 疑惑: { rate: 2 },
  happy: { emotion: 'happy', rate: 8 }, sad: { emotion: 'sad', rate: -10 },
  angry: { emotion: 'angry', rate: 8, loud: 12 }, excited: { emotion: 'excited', rate: 16, loud: 6 },
  surprised: { emotion: 'surprised', rate: 8 }, coldness: { emotion: 'coldness', rate: -6 },
  neutral: { emotion: 'neutral' }, tender: { rate: -8 }, shy: { rate: -5 },
  tired: { rate: -15 }, calm: { rate: 0 },
};

/** 倍率/百分比 → 火山百分比整数（1.1 倍 → 10） */
function toPct(v) {
  const n = Number(String(v).replace(/[×x倍%]/gi, '').trim());
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) <= 3 && !Number.isInteger(n)) return Math.round((n - 1) * 100);
  return Math.round(n);
}

/** 解析标记里的选项：`|开心`、` 情绪=撒娇 强度=5 语速=0.9 音量=1.1 voice=xxx` */
function parseOpts(raw, logger) {
  const out = { rate: 0, loud: 0, voice: null, emotion: null, emotionScale: null, emotionRaw: null };
  const str = String(raw || '').trim().replace(/^[|｜]/, '').trim();
  if (!str) return out;
  // ★管道符也要当分隔符：`voice=ja|开心` 这种混写曾被当成一个值，speaker 变成 "ja|开心"
  //   → 服务端报 55000000 resource ID is mismatched with speaker
  for (const t of str.split(/[\s,，、|｜]+/).filter(Boolean)) {
    const m = /^([\u4e00-\u9fa5a-zA-Z_]+)\s*[=:：]\s*(.+)$/.exec(t);
    if (!m) {
      const e = EMOTIONS[t];
      if (e) {
        out.emotionRaw = t;
        if (e.emotion) out.emotion = e.emotion;
        out.rate += e.rate || 0;
        out.loud += e.loud || 0;
      } else logger?.warn?.(`[tts-voice] 未知情绪词「${t}」，已忽略`);
      continue;
    }
    const key = m[1].toLowerCase();
    const val = m[2];
    if (/情绪|emotion|语气/.test(key)) {
      const e = EMOTIONS[val];
      out.emotionRaw = val;
      if (e) {
        if (e.emotion) out.emotion = e.emotion;
        out.rate += e.rate || 0;
        out.loud += e.loud || 0;
      } else {
        out.emotion = String(val).toLowerCase();
      }
    } else if (/强度|scale/.test(key)) {
      const n = Number(val);
      if (Number.isFinite(n)) out.emotionScale = Math.max(1, Math.min(5, Math.round(n)));
    } else if (/语速|rate|speed/.test(key)) {
      out.rate += toPct(val);
    } else if (/音量|loud|volume/.test(key)) {
      out.loud += toPct(val);
    } else if (/音色|voice|speaker/.test(key)) {
      out.voice = val;
    }
  }
  out.rate = Math.max(-50, Math.min(100, out.rate));
  out.loud = Math.max(-50, Math.min(100, out.loud));
  return out;
}

/** 从正文里抽出所有语音任务，返回剥完标记的正文 + 任务列表 */
const RE_BLOCK = /\[语音合成([^\]]*)\]([\s\S]*?)(?:\[\/语音合成\]|\[语音合成\])/g;
function extract(text) {
  const jobs = [];
  let out = String(text || '');
  const take = (_m, opts, body) => {
    const clean = String(body || '').trim();
    if (clean) jobs.push({ text: clean, opts: String(opts || '') });
    return '';
  };
  // ★ 2026-10-23 修：必须**先严格匹配**（要有 [/语音合成] 闭合），
  //   且开标签**不能被反引号包裹**（那是在正文里"提到"标记，不是真标记）。
  //   否则正文里提到的裸「[语音合成]」会被当成开标签，和真标记错配，
  //   拼出一个只有几个字的假 job（实际症状：合成出 1 秒的"标记"两个音，正文也被吞掉）。
  out = out.replace(/(?<!`)\[语音合成([^\]]*)\]([\s\S]*?)\[\/语音合成\]/g, take);
  // 兜底：仍然支持简写形式 [语音合成]…[语音合成]（剩下的才处理）
  out = out.replace(/(?<!`)\[语音合成([^\]]*)\]([\s\S]*?)(?:\[语音合成\])/g, take);
  return { rest: out, jobs };
}

/** voice 支持别名：voice=ja → 配置里的 voicePresets.ja（日语 Shirou） */
function resolveVoice(cfg, voice) {
  const v = String(voice || '').trim();
  if (!v) return null;
  const presets = cfg.voicePresets || {};
  if (presets[v]) return presets[v];
  const lower = v.toLowerCase();
  if (presets[lower]) return presets[lower];
  return v;
}

// buildHeaders / resolveResourceId 统一由 lib/settings.mjs 提供（2026-11-11：避免两份逻辑漂移）

/** 火山接口对 audio_params 里的数值字段做严格类型检查：传字符串直接 55000000
 *  （json: cannot unmarshal string into Go struct field AudioParams... of type int/float）。
 *  而面板的 select 拿到的永远是**字符串**（'24000'），所以这里必须统一转数字。 */
function numOf(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function buildPayload(cfg, text, { speaker, rate, loud, emotion, emotionScale, emotionRaw }) {
  const audio_params = {
    format: cfg.format || 'mp3',
    sample_rate: numOf(cfg.sampleRate, 24000),   // ★ 必须是 number（面板给的是 '24000'）
    speech_rate: numOf(rate, 0),
    loudness_rate: numOf(loud, 0),
  };
  if (emotion) {
    audio_params.emotion = emotion;
    const es = numOf(emotionScale, 0);
    if (es) audio_params.emotion_scale = es;    // ★ 同样必须是 number
  }
  // CoT 语音标签解析（2026-10-23）：<cot text=急促难耐>...</cot> 可调语速/情感
  // 仅 seed-tts-2.0-expressive（表现力增强版）生效，standard 会被过滤
  // 自然语言情绪指令（TTS 2.0 的 context_texts，替代 ICL 2.0 的 CoT）
  const addOn = { use_tag_parser: true };
  if (emotionRaw) addOn.context_texts = [`你可以用${emotionRaw}的语气来说这段话吗？`];
  const req_params = { text, speaker, audio_params, additions: JSON.stringify(addOn) };
  req_params.model = cfg.model || 'seed-tts-2.0-expressive';
  return { user: { uid: cfg.uid || 'tts-whale' }, req_params };
}

/** 解析响应体 → Buffer（兼容单 JSON / 多行 JSON 分片） */
function parseAudio(raw) {
  let audio = null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.data === 'string' && j.data) {
      if (j.code && j.code !== 0 && j.code !== 20000000) throw new Error(`code=${j.code} ${j.message || ''}`);
      audio = Buffer.from(j.data, 'base64');
    }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  if (audio) return audio;
  const chunks = [];
  let err = null;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev = null;
    try { ev = JSON.parse(s); } catch { continue; }
    if (ev && typeof ev.data === 'string' && ev.data) chunks.push(Buffer.from(ev.data, 'base64'));
    if (ev && ev.code && ev.code !== 0 && ev.code !== 20000000) err = `${ev.code} ${ev.message || ''}`;
  }
  if (err) throw new Error(`TTS 失败 ${err}`);
  if (chunks.length) return Buffer.concat(chunks);
  throw new Error(`没有收到音频数据: ${raw.slice(0, 200)}`);
}

/** 调火山接口合成 → 返回本地音频路径（主 URL 失败会重试 altBaseUrls） */
async function synthesize(text, { rate = 0, loud = 0, voice = null, emotion = null, emotionScale = null } = {}) {
  const cfg = loadCfg();
  // ★ 必须走 pickSpeaker：面板存的是「中文名｜id」整串，直接当 speaker 会 55000000
  const speaker = pickSpeaker(cfg, voice);
  const urls = [cfg.baseUrl || DEFAULT_URL, ...(Array.isArray(cfg.altBaseUrls) ? cfg.altBaseUrls : [])].filter(Boolean);
  let lastErr = null;

  for (const url of urls) {
    try {
      const headers = buildHeaders(cfg, speaker);
      // emotionScale/rate/loud 可能来自标记解析，统一在 buildPayload 里过 numOf()
      const body = JSON.stringify(buildPayload(cfg, text, { speaker, rate, loud, emotion, emotionScale }));
      const resp = await fetch(url, { method: 'POST', headers, body });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 300)}`);
      const audio = parseAudio(raw);

      const outDir = cfg.outDir || join(PLUGIN_DIR, 'out');
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, `qq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${cfg.format || 'mp3'}`);
      writeFileSync(path, audio);
      return path;
    } catch (e) {
      lastErr = e;
      // ★ 2026-11-11：资源不匹配兜底 —— 复刻音色到底属于 icl-1.0 还是 icl-2.0，
      //   取决于它是在哪一版复刻服务里建的（ID 前缀不可靠，实测 S_ 前缀挂 icl-1.0 反而 403）。
      //   这里遇到 403 / resource mismatched，就换另一个 icl 资源再试一次。
      try {
        const msg = e instanceof Error ? e.message : String(e);
        const curRid = resolveResourceId(cfg, speaker);
        const alt = altResourceId(curRid, speaker);
        if (alt && /403|55000000|resource/i.test(msg)) {
          const headers = buildHeaders(cfg, speaker, alt);
          const body = JSON.stringify(buildPayload(cfg, text, { speaker, rate, loud, emotion, emotionScale }));
          const resp = await fetch(url, { method: 'POST', headers, body });
          const raw = await resp.text();
          if (resp.ok) {
            const audio = parseAudio(raw);
            const outDir2 = cfg.outDir || join(PLUGIN_DIR, 'out');
            mkdirSync(outDir2, { recursive: true });
            const p2 = join(outDir2, `qq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${cfg.format || 'mp3'}`);
            writeFileSync(p2, audio);
            return p2;
          }
        }
      } catch { /* 兜底失败：走原来的 emotion 重试逻辑 */ }
      // 音色不支持 emotion 时，去掉 emotion 再试一次同 URL
      // ★ 2026-11-14（CodeRabbit 审查）：这一步原来写死用**原 resource**（buildHeaders 不传 rid），
      //   于是"复刻音色挂错 icl 资源 + 不支持情绪"这两个问题叠在一起时，三条路全失败：
      //     ① 原 resource + 带情绪 → 资源不匹配
      //     ② 换 alt resource + 带情绪 → 情绪不支持
      //     ③ 去情绪 + 原 resource → 又回到资源不匹配（就是这里）
      //   现在去情绪这一轮把两个候选资源**都试**，不再押在原资源上。
      if (emotion) {
        const baseRid = resolveResourceId(cfg, speaker);
        const candidates = [...new Set([baseRid, altResourceId(baseRid, speaker)].filter(Boolean))];
        for (const rid of candidates) {
          try {
            const headers = buildHeaders(cfg, speaker, rid);
            const body = JSON.stringify(buildPayload(cfg, text, { speaker, rate, loud }));
            const resp = await fetch(url, { method: 'POST', headers, body });
            const raw = await resp.text();
            if (resp.ok) {
              const audio = parseAudio(raw);
              const outDir = cfg.outDir || join(PLUGIN_DIR, 'out');
              mkdirSync(outDir, { recursive: true });
              const path = join(outDir, `qq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${cfg.format || 'mp3'}`);
              writeFileSync(path, audio);
              return path;
            }
          } catch { /* 这个候选失败，试下一个 */ }
        }
      }
    }
  }
  throw lastErr || new Error('合成失败');
}

/** 发语音：先直调宿主 sender（能拿到真实错误），失败再退 ctx.sendMedia，并依次换 kind */
async function sendVoice(ctx, path) {
  const sender = ctx.sender;
  const target = ctx.target;
  const kinds = ['voice', 'file', 'image'];
  const errs = [];
  if (sender && typeof sender.sendMedia === 'function' && target) {
    for (const kind of kinds) {
      try {
        await sender.sendMedia(target, kind, { localPath: path });
        return { ok: true, via: `sender:${kind}`, errs };
      } catch (e) {
        errs.push(`sender:${kind}=${(e && e.message) || e}`);
      }
    }
  }
  for (const kind of kinds) {
    try {
      const ok = await ctx.sendMedia({ path, kind });
      if (ok) return { ok: true, via: `ctx.sendMedia:${kind}`, errs };
      errs.push(`ctx.sendMedia:${kind}=false`);
    } catch (e) {
      errs.push(`ctx.sendMedia:${kind}=${(e && e.message) || e}`);
    }
  }
  return { ok: false, via: null, errs };
}

/** 串行队列：seed-tts-2.0 有并发限制，连续多条语音撞并发就会失败 */
let QUEUE = Promise.resolve();
function enqueue(fn) {
  const p = QUEUE.then(fn, fn);
  QUEUE = p.then(() => undefined, () => undefined);
  return p;
}

export default async function onOutbound(ctx, next) {
  try {
    // 出站 ctx 只有 dataRoot，没有 config —— 配置读取全靠它
    if (ctx && typeof ctx.dataRoot === 'string' && ctx.dataRoot) _dataRoot = ctx.dataRoot;
    // 只在「正文发送前」改写；turnEnd 阶段正文已经发出去了
    if (ctx.phase && ctx.phase !== 'send') return next();
    if (ctx.kind && ctx.kind !== 'text') return next();

    const original = String(ctx.text || '');
    if (!original.includes('语音合成')) return next();

    const { rest, jobs } = extract(original);
    if (!jobs.length) return next();

    const cleaned = rest.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const voiceOnly = cleaned.length === 0;

    // ① 先把标记从正文里摘掉
    if (voiceOnly) ctx.rewrite('');
    else ctx.rewrite(cleaned);

    // ② 合成 + 发送丢后台，不阻塞正文
    const runJobs = async () => {
      for (const job of jobs) {
        try {
          const opt = parseOpts(job.opts, ctx.logger);
          // 串行 + 失败重试一次（并发限制/瞬时抖动都能扛）
          let path = null;
          for (let attempt = 0; attempt < 2 && !path; attempt++) {
            try {
              path = await enqueue(() => synthesize(job.text, opt));
            } catch (e) {
              if (attempt === 1) throw e;
              await new Promise((r) => setTimeout(r, 900));
            }
          }
          // 发：先直调 sender（可看到真实错误），再退 ctx.sendMedia，kind 依次 voice/file/image
          const r = await sendVoice(ctx, path);
          const ok = r.ok;
          if (!ok) {
            try {
              const cfg = loadCfg();
              const dir = cfg.outDir || join(PLUGIN_DIR, 'out');
              appendFileSync(join(dir, '_tts-error.log'),
                `${new Date().toISOString()}\tSEND-FAIL\t${r.errs.join(' | ')}\tfile=${path}\n`, 'utf8');
            } catch { /* 忽略 */ }
          }
          ctx.note?.(`语音合成 ${ok ? `已发(${r.via})` : '发送失败'} · 情绪=${opt.emotion || '-'} 语速=${opt.rate} 音量=${opt.loud} · ${job.text.slice(0, 20)}`);
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          ctx.note?.(`语音合成失败: ${msg}`);
          // 落一份错误日志，方便事后查（note 走 debug 级，不一定看得见）
          try {
            const cfg = loadCfg();
            const dir = cfg.outDir || join(PLUGIN_DIR, 'out');
            mkdirSync(dir, { recursive: true });
            appendFileSync(join(dir, '_tts-error.log'),
              `${new Date().toISOString()}\t${msg}\ttext=${job.text.slice(0, 40)}\topts=${job.opts}\n`, 'utf8');
          } catch { /* 忽略 */ }
          try { await ctx.send(`（语音合成失败：${msg.slice(0, 60)}）`); } catch { /* 忽略 */ }
        }
      }
    };

    if (typeof ctx.background === 'function') ctx.background(runJobs);
    else void runJobs();

    // ③ 只剩语音 → 消灭这条正文（但"纯语音模式"关掉时，正文为空也照常返回让上层发空消息被吞）
    if (voiceOnly) {
      const cfg = loadCfg();
      if (cfg.voiceOnlyEnabled !== false) {
        ctx.annihilate('voice-only');
        return; // annihilate 之后不要再 next()
      }
      ctx.rewrite('（语音消息）');   // 不消灭就补一句占位，避免空正文引发异常
    }
    return next();
  } catch (e) {
    ctx.note?.(`tts-voice 异常: ${(e && e.message) || e}`);
    return next();
  }
}
