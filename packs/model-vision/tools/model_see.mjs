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
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PACK_ID = 'model-vision';

// ⚠️ **必须放在文件前 4KB 内**：面板扫描设置页时只读每个扩展文件的**前 4096 字节**
//    （settings-host.js: `readFileSync(full,'utf8').slice(0, 4096)` 再匹配 `qqbotSettingsPage`），
//    放在文件后半段 ⇒ 面板认不出、没有 ⚙ 设置表单（2026-11-21 主人实测踩到）。
export const qqbotSettingsPage = {
  title: '模型读图 · 设置',
  desc: '两种取值优先级：当前会话优先（默认，用当前会话的 provider/model + 宿主凭据）/ 面板设置优先（先用手填的 Key、Base URL、模型）',
  schema: [
    {
      key: 'sourceMode',
      type: 'select',
      label: '取值优先级',
      default: '当前会话优先',
      options: ['当前会话优先', '面板设置优先'],
      hint: '当前会话优先：模型与地址跟当前会话走，Key 读宿主凭据；面板设置优先：先用手填的三项，缺的才回落',
    },
    { key: 'apiKey', type: 'string', secret: true, label: 'API Key', default: '', placeholder: '留空=按 provider 读宿主凭据' },
    { key: 'baseUrl', type: 'string', label: 'Base URL', default: '', placeholder: '留空=按 provider 内置默认（只接受 https，本机回环可用 http）' },
    { key: 'model', type: 'string', label: '模型', default: '', placeholder: '留空=用当前会话正在用的模型' },
    { key: 'maxTokens', type: 'number', label: 'max_tokens（0=不传）', default: 0, hint: 'GLM 视觉模型收到 max_tokens 会报 1210，建议 0' },
  ],
};

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

/** 本机回环主机：只有这些允许用 http（会带 Bearer Key 出去，别的地方必须 https） */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * 校验 baseUrl：只接受 https，http 仅放行本机回环；非法/不安全一律返回空串（调用方报错）。
 * 返回去掉尾部斜杠的地址。
 */
function sanitizeBaseUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return s;
    if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return s;
    return '';
  } catch {
    return '';
  }
}

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
  // ★ CodeRabbit #20（Major）：**只认文件头**，绝不靠扩展名回退成 image/jpeg。
  //   否则被提示注入的 images 参数可以指向 `~/.dsh/.credentials.yaml` 之类，
  //   把非图片文件 base64 后当"图片"发给外部端点 —— 等于凭据外带。
  const mime = sniffMime(buf);
  if (!mime) throw new Error(`不是受支持的图片格式（PNG/JPEG/GIF/WEBP/BMP）: ${s}`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 解析 images 参数：换行/竖线分条；URL 段只在「逗号后紧跟 http(s)」时再切（保住 URL 自带的逗号） */
function parseImages(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  const out = [];
  const push = (s) => {
    const t = String(s || '').trim().replace(/^["'`]|["'`]$/g, '');
    if (t) out.push(t);
  };
  for (const piece of String(raw || '').split(/[\n|]+/)) {
    const s = piece.trim().replace(/^["'`]|["'`]$/g, '');
    if (!s) continue;
    if (/^https?:\/\//i.test(s)) {
      // 一个 URL 可能自带逗号（?crop=1,2,3,4）⇒ 只在「逗号后面紧跟 http(s)://」时才切
      for (const p of s.split(/[,，](?=\s*https?:\/\/)/i)) push(p);
      continue;
    }
    for (const p of s.split(/[,，]+/)) push(p);
  }
  return out;
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

/** 面板配置：优先 env.getConfig（文档化作用域 profile / data），其次 env.config，最后读 ext-config 文件 */
function readCfg(env) {
  let cfg = {};
  // ★ CodeRabbit #20：getConfig 的**文档化**作用域是 'profile' / 'data'（设置卡片=profile，dock 卡=data）；
  //   以前传的是 QQ 会话作用域 'group'/'c2c'，宿主认不认不在契约里 —— 认不出就会静默丢掉面板值。
  for (const scope of ['profile', 'data']) {
    try {
      const c = env?.getConfig?.(scope);
      if (c && typeof c === 'object' && Object.keys(c).length) cfg = { ...cfg, ...c };
    } catch { /* 换下一个作用域 */ }
  }
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

export default {
  name: 'model_see',
  description:
    '用**当前会话正在用的那个模型**读一张或多张图片（走 OpenAI 兼容的 image_url 格式，只把文字结果带回上下文，'
    + '不会在历史里留下 image block）。'
    + 'images：本地绝对路径或 http(s) 链接，多个用**换行或竖线**分隔（单个 URL 里自带的逗号不会被切开）；'
    + 'prompt：要它看什么（必填）。'
    + '模型不支持读图时会原样返回上游报错。',
  inputSchema: {
    images: { type: 'string', required: true, description: '图片：本地路径或网址，多个用换行或竖线分隔（URL 内部的逗号不会被切开；URL 之间也可用逗号接 http(s)）' },
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
    // ★ 2026-11-21 主人要求：面板可选两种取值优先级
    //   · 当前会话优先（默认）：模型 / 地址 / Key 都先跟当前会话与宿主凭据走，面板值作兜底
    //   · 面板设置优先：先用手填的三项，缺的才回落到当前会话 / 宿主凭据
    const panelFirst = /面板/.test(String(cfg?.sourceMode || ''));
    const { provider, model: curModel } = currentModelOf(env, cfg);
    const cfgModel = String(cfg?.model || '').trim();
    const argModel = String(args?.model || '').trim();
    const model = argModel || (panelFirst ? (cfgModel || curModel) : (curModel || cfgModel));
    if (!model) {
      return { ok: false, msg: '拿不到当前会话的模型名。请在工具参数里传 model，或在扩展设置里填「模型」' };
    }

    // ★ CodeRabbit #20（CWE-319）：这里会把 `Authorization: Bearer <Key>` 发出去，
    //   所以 baseUrl 只接受 **https**；http 仅放行本机回环（自建代理场景）。非法值直接拒。
    // ★ CodeRabbit #21（Major）：面板填了 baseUrl 但**不合法**时，绝不能悄悄回落到默认端点 ——
    //   那样会把面板里的模型 / Key / 图片发给另一个服务商。填了却不合法 ⇒ 直接报错。
    const cfgBaseRaw = String(cfg?.baseUrl || '').trim();
    const cfgBase = sanitizeBaseUrl(cfgBaseRaw);
    const defBase = sanitizeBaseUrl(DEFAULT_BASE[provider.toLowerCase()] || '');
    let baseUrl = '';
    if (panelFirst) {
      if (cfgBaseRaw) {
        if (!cfgBase) {
          return { ok: false, msg: `面板里的 Base URL 不安全或不合法（${cfgBaseRaw}）：只接受 https://（本机 127.0.0.1/localhost 可用 http）。已拒绝发送，没有改用其它端点` };
        }
        baseUrl = cfgBase;
      } else {
        baseUrl = defBase;
      }
    } else {
      baseUrl = defBase || cfgBase;
      if (!baseUrl && cfgBaseRaw) {
        return { ok: false, msg: `面板里的 Base URL 不安全或不合法（${cfgBaseRaw}）：只接受 https://（本机回环可用 http）` };
      }
    }
    if (!baseUrl) {
      return {
        ok: false,
        msg: `不知道 provider「${provider || '(未知)'}」的 API 地址。请在本扩展设置里填 Base URL（例如 https://api.deepseek.com）`,
      };
    }

    // Key：宿主 credentials seam（官方正规通道：按操作解析、热更新、环境变量层优先）
    //      → 老宿主没有该服务时，自己读 ~/.dsh/.credentials.yaml 兜底。
    //      面板填的 Key 按 sourceMode 决定排前面还是后面。
    const cfgKey = String(cfg?.apiKey || '').trim();
    let hostKey = '';
    let hostFrom = '';
    {
      const cands = KEY_REFS[provider.toLowerCase()] || [];
      const cred = (() => {
        try { return env?.kernel?.get?.('credentials') || env?.ctx?.get?.('credentials'); } catch { return undefined; }
      })();
      if (cred && typeof cred.resolve === 'function') {
        for (const ref of cands) {
          try {
            const r = await cred.resolve(ref);
            if (r && r.value) {
              hostKey = String(r.value);
              hostFrom = `credentials:${ref}${r.source ? '@' + r.source : ''}`;
              break;
            }
          } catch { /* 换下一个候选 */ }
        }
      }
      if (!hostKey) {
        const refs = hostCredRefs();
        for (const ref of cands) {
          if (refs[ref]) { hostKey = refs[ref]; hostFrom = `credentials.yaml:${ref}`; break; }
        }
      }
    }
    const apiKey = panelFirst ? (cfgKey || hostKey) : (hostKey || cfgKey);
    const keyFrom = apiKey && apiKey === cfgKey ? '面板设置' : hostFrom;
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
    let raw = '';
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
        // ★ CodeRabbit #20：**不许跟随重定向** —— 307/308 会把请求体（含图与 prompt）
        //   重发到新地址；若目标是非回环 http，内容就跑在明文上了。宁可失败也不降级。
        redirect: 'error',
      });
      // ★ CodeRabbit #20：**body 读取必须也在 try 里** —— 服务器只回响应头就断流时
      //   `res.text()` 会 reject；放在 try 外会让整个工具调用抛错，而不是回 `{ok:false}`。
      raw = await res.text();
    } catch (e) {
      return { ok: false, msg: `请求失败（${baseUrl}）：${e instanceof Error ? e.message : String(e)}` };
    }

    const ms = Date.now() - started;
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
