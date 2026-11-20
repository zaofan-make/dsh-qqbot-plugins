/**
 * model_see.mjs —— **用「当前会话正在用的那个模型」读图**（单工具成包）
 *
 * 主人 2026-11-21 需求：
 *   群友发图时插件只给模型一个本地路径（不塞 image block，除非开了图片聚合）。
 *   想让模型真看到图，又不想把图变成 image block 永久驻留历史（每轮重发、每轮过审核，
 *   撞上上游内容审核就是"毒会话"），于是做一个**工具型读图**通道：
 *     工具内部把图发给视觉模型 → 只把**文字**带回上下文。
 *
 * 关键设计：
 *   · **用当前会话的 provider / model**（env.manager.getEffectiveModel），不另开一套账号；
 *   · Key 优先面板填的，否则按 provider 从宿主 `~/.dsh/.credentials.yaml` 的 `refs.*` 里找
 *     （和 DeepSeek 全家桶同一套做法）；baseUrl 按 provider 内置默认，面板可覆盖；
 *   · 图片：本地路径 → base64 data URL（按**文件头**判类型，QQ 落盘的文件常没扩展名）；
 *     http(s) → 原样交给服务商；
 *   · 走标准 OpenAI 兼容 `POST {baseUrl}/chat/completions` + `image_url` 内容块，
 *     所以 GLM / DeepSeek / OpenAI / 火山等都能用，换家只改 baseUrl 与模型；
 *   · **模型不支持读图也不拦**（主人原话："反正 api 返回错误报错也行"），
 *     错误原样带回（含 HTTP 状态与上游 code），方便一眼看出是 1210 参数非法还是 10013 审核。
 *   · 默认**不传** `max_tokens`：GLM 视觉模型收到会报 1210，DeepSeek 新模型也有改用
 *     `max_completion_tokens` 的，干脆默认不传，需要时用参数显式给。
 *
 * 命令行自测（不进群也能跑）：
 *   node model_see.mjs <图片路径或URL> "描述这张图" [--model deepseek-flash] [--base https://api.deepseek.com] [--key sk-xxx]
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PACK_ID = 'model-vision';

/** 单张图上限：base64 后约 +33%，太大容易把请求体撑爆（DeepSeek 侧上限 48MiB） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** provider → 默认 baseUrl（面板填了就用面板的） */
const DEFAULT_BASE = {
  deepseek: 'https://api.deepseek.com',
  deepseekai: 'https://api.deepseek.com',
  deepseekaiweb: 'https://api.deepseek.com',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  zhipuai: 'https://open.bigmodel.cn/api/paas/v4',
  bigmodel: 'https://open.bigmodel.cn/api/paas/v4',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  openai: 'https://api.openai.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  volce: 'https://ark.cn-beijing.volces.com/api/v3',
  ark: 'https://ark.cn-beijing.volces.com/api/v3',
  siliconflow: 'https://api.siliconflow.cn/v1',
  // 宿主里常见的自建/聚合 provider（见 profiles/*/cordis.patch.yml）
  opencode: 'https://opencode.ai/inference/go/openai/v1',
  'opencode-go': 'https://opencode.ai/inference/go/openai/v1',
  huoshancoding: 'https://ark.cn-beijing.volces.com/api/coding/v3',
};

/** provider → 宿主凭据 refs 里的候选键名（按顺序取第一个有值的） */
const KEY_REFS = {
  deepseek: ['DEEPSEEK_API_KEY'],
  deepseekai: ['DEEPSEEK_API_KEY'],
  deepseekaiweb: ['DEEPSEEK_API_KEY'],
  zhipu: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'],
  zhipuai: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'],
  bigmodel: ['BIGMODEL_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY'],
  glm: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  dashscope: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  volcengine: ['VOLCE_API_KEY', 'ARK_API_KEY', 'HUOSHAN_API_KEY'],
  volce: ['VOLCE_API_KEY', 'ARK_API_KEY', 'HUOSHAN_API_KEY'],
  ark: ['ARK_API_KEY', 'VOLCE_API_KEY'],
  siliconflow: ['SILICONFLOW_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
  huoshancoding: ['HUOSHANCODING_API_KEY', 'VOLCE_API_KEY'],
};

/** 只有这两个 provider 需要 `x-opencode-session` 头（精确匹配，别的家一概不加） */
const OPENCODE_FAMILY = new Set(['opencode', 'opencode-go']);

/** 文件头 → MIME（比扩展名靠谱：QQ 落盘的临时文件常没有后缀） */
function sniffMime(buf) {
  if (buf.length > 8) {
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.subarray(0, 8).toString('latin1').startsWith('\x89PNG')) return 'image/png';
    if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (buf.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  }
  return '';
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** 一个输入项 → 可直接放进 image_url.url 的字符串 */
function toImageUrl(src) {
  const s = String(src || '').trim();
  if (!s) throw new Error('图片路径为空');
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:/i.test(s)) return s;
  if (!existsSync(s)) throw new Error(`文件不存在: ${s}`);
  const st = statSync(s);
  if (!st.isFile()) throw new Error(`不是文件: ${s}`);
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`图片过大（${(st.size / 1024 / 1024).toFixed(1)}MB > ${MAX_IMAGE_BYTES / 1024 / 1024}MB）: ${s}`);
  const buf = readFileSync(s);
  const mime = sniffMime(buf) || MIME_BY_EXT[extname(s).toLowerCase()] || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 解析 images 参数：字符串按换行/竖线/逗号切，数组直接用 */
function parseImages(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  return String(raw || '')
    .split(/[\n|,，]+/)
    .map((x) => x.trim().replace(/^["'`]|["'`]$/g, ''))
    .filter(Boolean);
}

/** 宿主 `~/.dsh/.credentials.yaml` 里 refs.* 的值（按 mtime 缓存，避免每轮读盘） */
let _credCache = { mtime: -1, refs: {} };
function hostCredRefs() {
  try {
    const home = String(process.env.DSH_HOME || '').trim()
      || join(String(process.env.USERPROFILE || process.env.HOME || ''), '.dsh');
    const f = join(home, '.credentials.yaml');
    if (!existsSync(f)) return {};
    const st = statSync(f);
    if (_credCache.mtime === st.mtimeMs) return _credCache.refs;
    const text = readFileSync(f, 'utf8');
    const refs = {};
    // 只认 refs: 段下的 `KEY: value`（简单逐行扫，够用；不做完整 YAML 解析）
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (inRefs && /^\S/.test(line)) inRefs = false;
      if (!inRefs) continue;
      const m = /^\s{2}([A-Za-z0-9_]+):\s*["']?([^"'\s#]+)/.exec(line);
      if (m) refs[m[1]] = m[2];
    }
    _credCache = { mtime: st.mtimeMs, refs };
    return refs;
  } catch {
    return {};
  }
}

/** 面板配置：优先 env.getConfig()，其次 env.config，最后读 ext-config 文件 */
function readCfg(env) {
  let cfg = {};
  try { const c = env?.getConfig?.(env?.peer?.scope); if (c && typeof c === 'object') cfg = { ...c }; } catch { /* ignore */ }
  if (!Object.keys(cfg).length && env?.config && typeof env.config === 'object') cfg = { ...env.config };
  if (!Object.keys(cfg).length) {
    try {
      const root = String(env?.dataRoot || env?.manager?.dataRoot || env?.cwd || '').trim();
      if (root) {
        const f = join(root, '.qqbot-extensions', '.state', 'ext-config', `${PACK_ID}.json`);
        if (existsSync(f)) cfg = JSON.parse(readFileSync(f, 'utf8')) || {};
      }
    } catch { /* ignore */ }
  }
  return cfg || {};
}

/** 当前会话的 provider/model（拿不到就给空串，调用方再兜底） */
function currentModelOf(env, cfg) {
  let provider = String(env?.provider || '').trim();
  let model = '';
  try {
    const scope = env?.peer?.scope || env?.user?.scope;
    const peerId = env?.peer?.peerId;
    if (scope && peerId && typeof env?.manager?.getEffectiveModel === 'function') {
      const m = env.manager.getEffectiveModel(scope, peerId);
      if (m) { provider = String(m.provider || provider); model = String(m.model || ''); }
    }
  } catch { /* ignore */ }
  if (!model) {
    try {
      const rc = env?.agent?.session?.requestContext?.();
      if (rc) { provider = String(rc.provider || provider); model = String(rc.model || rc.modelId || ''); }
    } catch { /* ignore */ }
  }
  if (!model && cfg?.model) model = String(cfg.model).trim();
  return { provider, model };
}

/** 从返回里取正文（兼容 content 是字符串 / 数组两种形状） */
function pickText(json) {
  const c = json?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === 'string' ? b : String(b?.text ?? ''))).join('').trim();
  }
  return '';
}

export const qqbotSettingsPage = {
  title: '模型读图 · 设置',
  desc: '用「当前会话的模型」读图：填了 Key 就用这里的，留空则按 provider 自动读宿主 ~/.dsh/.credentials.yaml',
  schema: [
    { key: 'apiKey', type: 'string', label: 'API Key（可留空）', default: '', placeholder: '留空=自动读宿主凭据' },
    { key: 'baseUrl', type: 'string', label: 'Base URL（可留空）', default: '', placeholder: '留空=按 provider 内置默认，如 https://api.deepseek.com' },
    { key: 'model', type: 'string', label: '模型（可留空）', default: '', placeholder: '留空=用当前会话正在用的模型' },
    { key: 'maxTokens', type: 'number', label: 'max_tokens（0=不传）', default: 0, hint: 'GLM 视觉模型收到 max_tokens 会报 1210，建议 0' },
  ],
};

export default {
  name: 'model_see',
  description:
    '用**当前会话正在用的那个模型**读一张或多张图片（走 OpenAI 兼容的 image_url 格式，只把文字结果带回上下文，'
    + '不会在历史里留下 image block）。'
    + 'images：本地绝对路径或 http(s) 链接，多个用换行/竖线/逗号分隔；prompt：要它看什么（必填）。'
    + '模型不支持读图时会原样返回上游报错。',
  inputSchema: {
    images: { type: 'string', required: true, description: '图片：本地路径或网址，多个用换行/竖线/逗号分隔' },
    prompt: { type: 'string', required: true, description: '要模型看图回答什么（必填），如"描述这张图""图里的文字是什么"' },
    model: { type: 'string', description: '覆盖模型（默认=当前会话的模型）' },
    maxTokens: { type: 'number', description: '可选 max_tokens（默认不传，GLM 视觉模型不认这个参数）' },
    detail: { type: 'string', description: '可选 low/high/auto（部分服务商支持，默认不传）' },
  },

  async run(args, env) {
    const prompt = String(args?.prompt || '').trim();
    if (!prompt) return { ok: false, msg: 'prompt 不能为空（要模型看图回答什么？）' };

    const list = parseImages(args?.images);
    if (!list.length) return { ok: false, msg: 'images 不能为空（本地路径或 http(s) 链接）' };

    const cfg = readCfg(env);
    const { provider, model: curModel } = currentModelOf(env, cfg);
    const model = String(args?.model || cfg?.model || curModel || '').trim();
    if (!model) {
      return { ok: false, msg: '拿不到当前会话的模型名。请在工具参数里传 model，或在扩展设置里填「模型」' };
    }

    const baseUrl = String(cfg?.baseUrl || DEFAULT_BASE[provider.toLowerCase()] || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      return {
        ok: false,
        msg: `不知道 provider「${provider || '(未知)'}」的 API 地址。请在本扩展设置里填 Base URL（例如 https://api.deepseek.com）`,
      };
    }

    // Key：① 面板填的 → ② 宿主 credentials seam（官方正规通道：按操作解析、热更新、环境变量层优先）
    //       → ③ 老宿主没有该服务时，自己读 ~/.dsh/.credentials.yaml 兜底
    let apiKey = String(cfg?.apiKey || '').trim();
    let keyFrom = apiKey ? '面板设置' : '';
    if (!apiKey) {
      const cands = KEY_REFS[provider.toLowerCase()] || [];
      const cred = (() => {
        try { return env?.kernel?.get?.('credentials') || env?.ctx?.get?.('credentials'); } catch { return undefined; }
      })();
      if (cred && typeof cred.resolve === 'function') {
        for (const ref of cands) {
          try {
            const r = await cred.resolve(ref);
            if (r && r.value) {
              apiKey = String(r.value);
              keyFrom = `credentials:${ref}${r.source ? '@' + r.source : ''}`;
              break;
            }
          } catch { /* 换下一个候选 */ }
        }
      }
      if (!apiKey) {
        const refs = hostCredRefs();
        for (const ref of cands) {
          if (refs[ref]) { apiKey = refs[ref]; keyFrom = `credentials.yaml:${ref}`; break; }
        }
      }
    }
    if (!apiKey) {
      const want = (KEY_REFS[provider.toLowerCase()] || []).join(' / ') || '该 provider 的 Key';
      return {
        ok: false,
        msg: `没有可用的 API Key（provider=${provider || '未知'}，宿主凭据里没找到 ${want}）。请在本扩展设置里填 API Key`,
      };
    }

    // 组装 OpenAI 兼容请求
    const content = [{ type: 'text', text: prompt }];
    const notes = [];
    for (const [i, src] of list.entries()) {
      try {
        const url = toImageUrl(src);
        const block = { type: 'image_url', image_url: { url } };
        const detail = String(args?.detail || '').trim();
        if (detail) block.image_url.detail = detail;
        content.push(block);
      } catch (e) {
        notes.push(`第 ${i + 1} 张跳过：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (content.length === 1) {
      return { ok: false, msg: `一张图都没能装进请求：\n${notes.join('\n')}` };
    }

    const body = { model, messages: [{ role: 'user', content }], stream: false };
    const mt = Number(args?.maxTokens ?? cfg?.maxTokens ?? 0) || 0;
    if (mt > 0) body.max_tokens = Math.floor(mt);

    const started = Date.now();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
    // ★ opencode（opencode.ai 的 inference 网关）要求带 `x-opencode-session`，否则 400 MissingSessionID。
    //   ⚠️ 这是 opencode **独有**的要求 —— 判据用**精确白名单**，只对这两个 provider 生效：
    //   deepseek / zhipu / openai / 火山 / dashscope / siliconflow 等**一律不附加任何自定义头**，
    //   免得别的网关因为不认识的多余头而报 400。
    if (OPENCODE_FAMILY.has(provider.toLowerCase())) {
      const sid = String(env?.peerSessionId || env?.exec?.sessionId || '').trim() || randomUUID();
      headers['x-opencode-session'] = sid;
    }
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      return { ok: false, msg: `请求失败（${baseUrl}）：${e instanceof Error ? e.message : String(e)}` };
    }

    const ms = Date.now() - started;
    const raw = await res.text();
    if (!res.ok) {
      // 上游报错原样带回：1210=参数非法 / 10013=内容审核 / 400=请求不合法
      return {
        ok: false,
        msg: `上游返回 HTTP ${res.status}（用模型 ${provider}/${model}）：\n${raw.slice(0, 1200)}`,
      };
    }

    let json;
    try { json = JSON.parse(raw); } catch {
      return { ok: false, msg: `返回不是 JSON：\n${raw.slice(0, 800)}` };
    }

    const text = pickText(json);
    if (!text) {
      return { ok: false, msg: `模型没给正文（可能拒答或被截断）：\n${raw.slice(0, 800)}` };
    }

    const u = json?.usage || {};
    const meta = [
      `模型 ${provider ? provider + '/' : ''}${model} · ${content.length - 1} 张图 · ${ms}ms`,
      u.prompt_tokens !== undefined || u.completion_tokens !== undefined
        ? `tokens in/out: ${u.prompt_tokens ?? '?'} / ${u.completion_tokens ?? '?'}`
        : '',
      notes.length ? notes.join('；') : '',
    ].filter(Boolean).join(' · ');

    return { ok: true, msg: `${text}\n\n— ${meta}` };
  },
};
