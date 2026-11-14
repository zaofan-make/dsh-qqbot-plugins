/**
 * dskit-config-v5.mjs —— DeepSeek 全家桶扩展包的「唯一配置读取入口」
 *
 * 三处消费：工具（tools/*）、出站（outbound/*）、面板（qqbotSettingsPage）。
 * 扩展配置落盘在 `{dataRoot}/.qqbot-extensions/.state/ext-config/<文件>.json`。
 *
 * ★ 2026-11-14 主人定的一条铁律（opencode 会话踩到后改）：
 *   **只有当前会话的模型是 DeepSeek 官方时，才允许复用宿主的 DEEPSEEK_API_KEY。**
 *   非官方 provider（如 opencode / openai / 火山）要么自己填 Key，要么这些工具与语音合成一律不工作。
 */
import { existsSync, readFileSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包根目录（lib 的上一级） */
export const PACK_DIR = dirname(HERE);
/** 扩展 id（面板 UI 的 id、pack 的 id 都用它） */
export const PACK_ID = 'deepseek-kit';

export const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  /** 联网工具只支持 deepseek-flash（官方文档明确） */
  model: 'deepseek-flash',
  enableSearch: true,
  enableReadUrl: true,
  enableOcr: true,
  enableAsr: true,
  enableTts: true,
  ttsVoice: 'stella',
  ttsFormat: 'wav',
  ttsEnabled: true,
  searchThinkingDefault: false,
  ocrPurpose: 'text_recognition',
};

/**
 * 面板可能把配置存成的几种文件名（按优先级，后面的覆盖前面的）——
 * **两种命名都要认**：插件按「扩展文件基名」生成 id，出站扩展是 `dskit-tts.mjs`
 * ⇒ 存成 `dskit-tts.json`（连字符）；工具是 `dskit_tts.mjs` ⇒ `dskit_tts.json`（下划线）。
 * 2026-11-14 实测事故：只列了下划线那种，主人明明填了 Key，`ownApiKey` 仍读成空
 * ⇒ opencode provider 的会话判定 false ⇒ 五个工具全隐藏（看着像"填了没用/要重启"）。
 */
const CONFIG_FILES = ['deepseek-kit.json', 'dskit.json', 'dskit_search.json', 'dskit_ocr.json', 'dskit_tts.json', 'dskit-tts.json'];

function readJson(p) {
  try {
    if (!existsSync(p)) return undefined;
    const o = JSON.parse(readFileSync(p, 'utf8'));
    return o && typeof o === 'object' ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 宿主已配的 DeepSeek Key（`{DSH_HOME|~/.dsh}/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`）。
 * 按文件 mtime 缓存，避免每条消息都读盘。
 */
let _hostKeyCache = { key: '', mtime: -1 };
export function hostDeepseekKey() {
  try {
    const home = String(process.env.DSH_HOME || '').trim()
      || join(String(process.env.USERPROFILE || process.env.HOME || ''), '.dsh');
    const f = join(home, '.credentials.yaml');
    if (!existsSync(f)) return '';
    const st = statSync(f);
    if (_hostKeyCache.mtime === st.mtimeMs) return _hostKeyCache.key;
    const text = readFileSync(f, 'utf8');
    const m = /DEEPSEEK_API_KEY:\s*["']?([^\s"'#]+)/.exec(text);
    const key = m ? String(m[1]).trim() : '';
    _hostKeyCache = { key, mtime: st.mtimeMs };
    return key;
  } catch {
    return '';
  }
}

/**
 * 读配置（**不**自动塞宿主 Key）。
 * @returns {object} { ...DEFAULTS, ...面板值, ownApiKey, hostKey }
 */
export function loadConfig(dataRoot) {
  const out = { ...DEFAULTS };
  const packDefaults = readJson(join(PACK_DIR, 'settings.json'));
  if (packDefaults) Object.assign(out, packDefaults);
  const root = String(dataRoot || '').trim();
  if (root) {
    for (const f of CONFIG_FILES) {
      const o = readJson(join(root, '.qqbot-extensions', '.state', 'ext-config', f));
      if (o) Object.assign(out, o);
    }
  }
  out.apiKey = String(out.apiKey ?? '').trim();
  out.ownApiKey = out.apiKey;
  out.hostKey = hostDeepseekKey();
  out.baseUrl = String(out.baseUrl ?? DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  out.model = String(out.model ?? DEFAULTS.model).trim() || DEFAULTS.model;
  out.ttsVoice = String(out.ttsVoice ?? 'stella').trim() || 'stella';
  out.ttsFormat = String(out.ttsFormat ?? 'wav').trim() || 'wav';
  out.ocrPurpose = String(out.ocrPurpose ?? 'text_recognition').trim() || 'text_recognition';
  for (const k of ['enableSearch', 'enableReadUrl', 'enableOcr', 'enableAsr', 'enableTts', 'ttsEnabled', 'searchThinkingDefault']) {
    out[k] = out[k] !== false && String(out[k]) !== 'false';
  }
  return out;
}

/** 有没有面板里填的 Key（不含宿主那份） */
export function hasOwnApiKey(cfg) {
  return !!String(cfg?.ownApiKey || '').trim();
}

/**
 * 当前会话的模型服务商是不是 DeepSeek 官方。
 *
 * 判定优先级：
 *   ① `agent.session.requestContext()` 的 provider / model（真实路由，最准）
 *   ② manager 配置里的 provider
 *   ③ 都拿不到 ⇒ **false**（保守：认不出就不放行；opencode 会话就是这么被抓出来的）
 */
export function providerIsDeepseek(manager, agent, explicitProvider) {
  const hit = (raw) => /deepseek/i.test(String(raw ?? ''));
  // 插件侧算好的 provider（agent 运行时路由 或 modelResolver 的 model-prefs）优先
  if (explicitProvider) return hit(explicitProvider);
  try {
    const rc = (agent && typeof agent === 'object') ? agent.session?.requestContext?.() : undefined;
    if (rc && rc.provider) return hit(rc.provider);
    if (rc && rc.model) return hit(rc.model);
  } catch { /* ignore */ }
  try {
    const p = manager?.config?.provider ?? manager?.modelResolver?.config?.provider;
    if (p) return hit(p);
  } catch { /* ignore */ }
  return false;
}

/** 按 dataRoot 取 manager 实例（插件在 middleware-setup 里登记了 globalThis.__qqbotManagers） */
export function managerForDataRoot(dataRoot) {
  try {
    const gm = globalThis.__qqbotManagers;
    if (!gm) return undefined;
    const entries = gm instanceof Map ? [...gm.entries()] : Object.entries(gm);
    const norm = (k) => String(k || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
    const want = norm(dataRoot);
    if (want) {
      const exact = entries.find(([k]) => norm(k) === want);
      if (exact) return exact[1];
      const loose = entries.find(([k]) => norm(k).endsWith(want) || want.endsWith(norm(k)));
      if (loose) return loose[1];
    }
    return entries.length ? entries[0][1] : undefined;
  } catch {
    return undefined;
  }
}

/** 按出站 ctx.target 找到目标会话的 agent（用于判它当前的 provider） */
export function agentOfTarget(manager, target) {
  try {
    const scope = String(target?.scope || '');
    const peerId = String(target?.peerId || target?.targetId || '');
    if (!manager || !scope || !peerId) return undefined;
    const rec = manager.findByPeer?.(scope, peerId);
    return rec?.agent;
  } catch {
    return undefined;
  }
}

/**
 * 真正可用的 API Key：
 *   面板填的 > （当前会话是 DeepSeek 官方时才用）宿主那份。
 * 返回 '' 表示"这次不该工作"。
 */
export function resolveApiKey(cfg, manager, agent, explicitProvider) {
  const own = String(cfg?.ownApiKey || cfg?.apiKey || '').trim();
  if (own) return own;
  if (providerIsDeepseek(manager, agent, explicitProvider)) return String(cfg?.hostKey || '').trim();
  return '';
}

/**
 * 工具侧统一入口：拿到「可用的 cfg」（apiKey 已填好）或 null。
 * @returns {null | object}
 */
export function cfgForCall(env) {
  const dataRoot = String(env?.dataRoot || env?.manager?.dataRoot || '').trim();
  const cfg = loadConfig(dataRoot);
  const key = resolveApiKey(cfg, env?.manager, env?.agent, env?.provider);
  if (!key) return null;
  return { ...cfg, apiKey: key };
}

/**
 * 工具的共同可见性判据：
 *   ① 有可用 Key（面板自己的，或"官方会话"下的宿主 Key）
 *   ② 对应能力开关没关
 */
/** 诊断：可见性判定为什么失败（写 {dataRoot}/.qqbot-extensions/data/dskit-diag.log） */
function diagTool(abilityKey, cfg, env, reason) {
  try {
    const root = String(env?.dataRoot || env?.manager?.dataRoot || '').trim();
    if (!root) return;
    const dir = join(root, '.qqbot-extensions', 'data');
    mkdirSync(dir, { recursive: true });
    const mask = (s) => (s ? String(s).slice(0, 6) + '..(' + String(s).length + ')' : '(空)');
    const line = [
      new Date().toISOString(),
      'ability=' + String(abilityKey || '-'),
      'reason=' + reason,
      'own=' + mask(cfg?.ownApiKey),
      'host=' + mask(cfg?.hostKey),
      'provider=' + JSON.stringify(env?.provider ?? null),
      'agent=' + (env?.agent ? 'yes' : 'no'),
      'manager=' + (env?.manager ? 'yes' : 'no'),
    ].join(' ') + '\n';
    appendFileSync(join(dir, 'dskit-diag.log'), line, 'utf8');
  } catch { /* 诊断失败不影响主流程 */ }
}
export function toolVisible(env, abilityKey) {
  const dataRoot = String(env?.dataRoot || env?.manager?.dataRoot || '').trim();
  const cfg = loadConfig(dataRoot);
  if (!resolveApiKey(cfg, env?.manager, env?.agent, env?.provider)) return false;
  if (abilityKey && cfg[abilityKey] === false) return false;
  return true;
}

/**
 * 出站侧（语音合成）用：按**目标会话**判"该不该合成"。
 * 非官方会话且没填自己的 Key ⇒ false（标记原样保留，不合成、不剥）。
 */
export function outboundVoiceAllowed(ctx) {
  const dataRoot = String(ctx?.dataRoot || '').trim();
  const cfg = loadConfig(dataRoot);
  const mgr = managerForDataRoot(dataRoot);
  const agent = agentOfTarget(mgr, ctx?.target);
  return !!resolveApiKey(cfg, mgr, agent);
}
