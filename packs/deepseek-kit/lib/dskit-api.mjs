/**
 * dskit-api.mjs —— DeepSeek「全家桶应用 API」的最小封装
 *
 * 只封装本扩展包用到的五个能力（2026-11-14 官方文档）：
 *   1. 联网搜索 / 深度思考搜索（服务端工具 deepseek_web_search，含图片搜索）
 *   2. 阅读链接（服务端工具 deepseek_read_url）
 *   3. OCR     POST /v1/tools/ocr   （multipart：file + purpose）
 *   4. ASR     POST /v1/tools/asr   （multipart：file，16bit PCM WAV 或 Ogg Opus，≤8MiB/≤120s）
 *   5. TTS     POST /v1/tools/tts   （JSON：text / voice_id / format / filter_markdown）
 *
 * 依赖只有 Node 内置的 fetch / FormData / Blob（Node ≥ 18）。
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/** 统一错误：带上 HTTP 状态与服务端原文，便于 AI 自己判断要不要重试 */
export class DskitError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'DskitError';
    this.status = extra.status ?? 0;
    this.body = extra.body ?? '';
  }
}

function authHeaders(cfg, extra = {}) {
  return { Authorization: `Bearer ${cfg.apiKey}`, ...extra };
}

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

async function readErr(res) {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  return body.slice(0, 600);
}

/** JSON 请求（chat/completions、tts） */
async function postJson(cfg, path, body, { timeoutMs = 180_000 } = {}) {
  const url = `${cfg.baseUrl}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(cfg, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (err) {
    throw new DskitError(`请求 ${path} 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const b = await readErr(res);
    throw new DskitError(`HTTP ${res.status} (${path}): ${b}`, { status: res.status, body: b });
  }
  return res;
}

/** multipart 请求（ocr、asr） */
async function postForm(cfg, path, form, { timeoutMs = 240_000 } = {}) {
  const url = `${cfg.baseUrl}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(cfg), // 不要手写 Content-Type，让 fetch 自己带 boundary
      body: form,
      signal: timeoutSignal(timeoutMs),
    });
  } catch (err) {
    throw new DskitError(`上传 ${path} 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const b = await readErr(res);
    throw new DskitError(`HTTP ${res.status} (${path}): ${b}`, { status: res.status, body: b });
  }
  return res;
}

// ══════════════════════════════════════════════════════════════════
// 1) 联网搜索 / 深度思考搜索 / 图片搜索
// ══════════════════════════════════════════════════════════════════

/** 本地图片 → data URL（图片搜索要把它放进 user content） */
export function imageToDataUrl(path) {
  const buf = readFileSync(path);
  const name = basename(path).toLowerCase();
  const mime = name.endsWith('.png') ? 'image/png'
    : name.endsWith('.gif') ? 'image/gif'
      : name.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 跑一次 chat/completions，声明服务端联网工具。
 * 联网由模型自己判断，搜索/开页/页内查找都在服务端完成，客户端只是收结果。
 *
 * @returns {{ text: string, citations: {url:string,title:string}[], calls: unknown[], usage: unknown }}
 */
export async function webSearch({ cfg, query, thinking = false, imagePaths = [], withReadUrl = true }) {
  const tools = [{ type: 'deepseek_web_search' }];
  if (withReadUrl) tools.push({ type: 'deepseek_read_url' });

  const content = [{ type: 'text', text: String(query || '').trim() }];
  for (const p of imagePaths) {
    try {
      content.push({ type: 'image_url', image_url: { url: imageToDataUrl(p) } });
    } catch {
      /* 单张图读失败不影响搜索 */
    }
  }

  const body = {
    model: cfg.model || 'deepseek-flash',
    messages: [{ role: 'user', content: content.length === 1 ? content[0].text : content }],
    tools,
    stream: false,
  };
  // 思考模式 = 深度思考搜索（多步 search / open_page / find_in_page）
  if (thinking) body.thinking = { type: 'enabled' };

  const res = await postJson(cfg, '/chat/completions', body, { timeoutMs: 240_000 });
  const data = await res.json();
  if (data?.error) throw new DskitError(`模型返回错误: ${data.error.message ?? JSON.stringify(data.error)}`);

  const msg = data?.choices?.[0]?.message ?? {};
  const text = String(msg.content ?? '').trim();
  const annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
  const citations = annotations
    .filter((a) => a?.type === 'url_citation' && a?.url_citation?.url)
    .map((a) => ({ url: String(a.url_citation.url), title: String(a.url_citation.title ?? '') }));
  const calls = Array.isArray(msg.server_tool_calls) ? msg.server_tool_calls : [];
  return { text, citations, calls, usage: data?.usage ?? null };
}

/** 只读链接（不搜索）：把 URL 喂给模型，让它读网页后作答 */
export async function readUrls({ cfg, urls, question }) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 10);
  if (!list.length) throw new DskitError('没有可读取的链接');
  const text = [String(question || '').trim(), ...list].filter(Boolean).join('\n');
  const body = {
    model: cfg.model || 'deepseek-flash',
    messages: [{ role: 'user', content: text }],
    tools: [{ type: 'deepseek_read_url' }],
    stream: false,
  };
  const res = await postJson(cfg, '/chat/completions', body, { timeoutMs: 240_000 });
  const data = await res.json();
  if (data?.error) throw new DskitError(`模型返回错误: ${data.error.message ?? JSON.stringify(data.error)}`);
  const msg = data?.choices?.[0]?.message ?? {};
  const pages = [];
  for (const step of Array.isArray(msg.server_tool_calls) ? msg.server_tool_calls : []) {
    for (const c of Array.isArray(step?.calls) ? step.calls : []) {
      if (c?.page?.url) pages.push({ url: String(c.page.url), title: String(c.page.title ?? ''), status: String(c.status ?? '') });
    }
  }
  return { text: String(msg.content ?? '').trim(), pages, usage: data?.usage ?? null };
}

// ══════════════════════════════════════════════════════════════════
// 2) OCR
// ══════════════════════════════════════════════════════════════════

/** 识别 PDF / Word / PPT / 图片里的文字，按页返回 */
export async function ocrFile({ cfg, filePath, purpose }) {
  const st = statSync(filePath);
  if (st.size > 100 * 1024 * 1024) throw new DskitError('文件超过 100 MiB，OCR 接口上限');
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append('purpose', purpose || cfg.ocrPurpose || 'text_recognition');
  form.append('file', new Blob([buf]), basename(filePath));
  // 官方：识别期间服务端会发换行符保活，响应体前面可能有一堆空白 ⇒ 先 trim 再 parse
  const res = await postForm(cfg, '/v1/tools/ocr', form, { timeoutMs: 300_000 });
  const raw = (await res.text()).trim();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new DskitError('OCR 返回不是合法 JSON: ' + raw.slice(0, 200));
  }
  if (data?.error) throw new DskitError(`OCR 失败: ${data.error.message ?? JSON.stringify(data.error)}`);
  const pages = (Array.isArray(data?.pages) ? data.pages : []).map((p) => ({
    index: Number(p?.index ?? 0),
    text: String(p?.text ?? ''),
    truncated: p?.finish_reason === 'length',
  }));
  return { id: data?.id, purpose: data?.purpose, pageCount: Number(data?.page_count ?? pages.length), pages };
}

// ══════════════════════════════════════════════════════════════════
// 3) ASR
// ══════════════════════════════════════════════════════════════════

/** 语音转文字（只吃 16bit PCM WAV 或 Ogg Opus，≤8MiB/≤120s） */
export async function asrFile({ cfg, filePath }) {
  const st = statSync(filePath);
  if (st.size > 8 * 1024 * 1024) throw new DskitError('音频超过 8 MiB；请先转成 16k 单声道 WAV 或 Ogg Opus');
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), basename(filePath));
  const res = await postForm(cfg, '/v1/tools/asr', form, { timeoutMs: 180_000 });
  const data = await res.json();
  return { text: String(data?.text ?? ''), durationMs: Number(data?.duration_ms ?? 0), requestId: data?.request_id };
}

// ══════════════════════════════════════════════════════════════════
// 4) TTS
// ══════════════════════════════════════════════════════════════════

/**
 * 文字转语音，返回音频字节。
 * @param {{cfg:object, text:string, voice?:string, format?:'wav'|'pcm', filterMarkdown?:boolean}} opt
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
export async function ttsText({ cfg, text, voice, format, filterMarkdown }) {
  const t = String(text || '');
  if (!t.trim()) throw new DskitError('没有可朗读的文本');
  if (t.length > 10000) throw new DskitError('文本超过 10,000 个计费字符，请分段');
  const res = await postJson(cfg, '/v1/tools/tts', {
    text: t,
    voice_id: voice || cfg.ttsVoice || 'stella',
    format: format || cfg.ttsFormat || 'wav',
    filter_markdown: filterMarkdown !== false,
  }, { timeoutMs: 300_000 });
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType: String(res.headers.get('content-type') ?? 'audio/wav') };
}
