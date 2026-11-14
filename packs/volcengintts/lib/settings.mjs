/**
 * settings.mjs — TTS 配置的唯一读取入口
 *
 * 为什么需要它：
 *   `.qqbot-extensions` 里每个扩展文件按「文件名」各存一份配置
 *   → outbound/volcengintts.mjs、tools/tts_voice.mjs、commands/tts.mjs 会各读各的，互相看不见。
 *   所以这里**不按扩展文件名找**，而是按固定候选列表依次读、依次合并，
 *   保证面板里填一次，出站/工具/命令三处都生效。
 *
 * 读取顺序（后面的覆盖前面的，即"面板 > 旧配置 > 包内默认"）：
 *   1. 包内 settings.json            ← 随包分发的默认值（可选）
 *   2. 旧版 工具/tts-plugin/tts-config.json ← 兼容迁移，老用户不用重填
 *   3. {dataRoot}/.qqbot-extensions/.state/ext-config/volcengintts.json ← 面板主存
 *   4. 同目录 tts_voice.json / tts.json ← 面板若挂在别的文件上时的兜底
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包根目录（lib 的上一级） */
export const PACK_DIR = dirname(HERE);

export const DEFAULT_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

/** 包内默认值：只有这里真正缺省才用得到，面板值永远优先 */
export const DEFAULTS = {
  // ★ 2026-11-14（CodeRabbit 抓到回归）：**默认必须是空**，不能是 'apiKey'。
  //   原因：loadSettings 会在 DEFAULTS 之上合并面板值，而"空串不覆盖默认"——
  //   于是老用户（只填过 AppId/AccessToken、从没保存过 authMode）读出来就是 'apiKey'，
  //   被我上一版 buildHeaders 的严格检查判成"你选了 API Key 却没填"，直接抛错。
  //   也就是说：升级一次，旧版鉴权用户全部无法合成。空串 = "没选过"，由凭据推断。
  authMode: '',
  apiKey: '',
  appId: '',
  accessToken: '',
  baseUrl: DEFAULT_URL,
  altBaseUrls: [],
  defaultSpeaker: 'zh_female_vv_uranus_bigtts',
  resourceId: 'auto',
  model: 'seed-tts-2.0-expressive',
  format: 'mp3',
  sampleRate: 24000,
  uid: 'dsh-tts-voice',
  // 情绪/语调总开关：关掉就只合成字面文本（有的音色不支持情感，关掉更稳）
  emotionEnabled: true,
  // 正文里除语音标记外一个字都不剩时，是否只发语音（默认是）
  voiceOnlyEnabled: true,
  outDir: '',
};

/** 从各种 env 里抠出 dataRoot（不同扩展点叫法不同） */
export function dataRootOf(env) {
  const e = env || {};
  const cands = [
    e.dataRoot,
    e.caps && e.caps.dataRoot,
    e.ctx && e.ctx.dataRoot,
    process.env.DSH_QQBOT_DATA_ROOT,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  // 兜底：从 DSH_HOME/qqbot-settings 推（qqbot-settings 与 .qqbot-extensions 同级）
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const guess = join(home, 'qqbot-settings');
  return existsSync(guess) ? guess : home;
}

/** 配置候选路径（低优先级在前） */
export function settingsCandidates(dataRoot) {
  const list = [join(PACK_DIR, 'settings.json')];
  // 旧版 Windows 配置（仅 Windows 上探测；Linux/Termux 下这条路径毫无意义，
  // 而且 `D:/...` 在 POSIX 里不是绝对路径，留着只会变成一条奇怪相对路径）
  if (process.platform === 'win32') {
    list.push('D:/newwenjianjia/aiwork/鲸鱼娘/工具/tts-plugin/tts-config.json');
  }
  if (dataRoot) {
    const cfgDir = join(dataRoot, '.qqbot-extensions', '.state', 'ext-config');
    // 面板按扩展文件名存配置：主存是 volcengintts.json，
    // 旧名（tts-voice / tts_voice / tts）继续兜底，方便从旧版无痛迁移
    list.push(join(cfgDir, 'volcengintts.json'));
    list.push(join(cfgDir, 'tts-voice.json'));
    list.push(join(cfgDir, 'tts_voice.json'));
    list.push(join(cfgDir, 'tts.json'));
  }
  return list;
}

function safeReadJson(p) {
  try {
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

/** 读合并后的配置；`sources` 会告诉你每个字段最后来自哪个文件（排错用） */
export function loadSettings(env) {
  const dataRoot = dataRootOf(env);
  const candidates = settingsCandidates(dataRoot);
  let cfg = { ...DEFAULTS };
  const sources = [];
  for (const p of candidates) {
    const j = safeReadJson(p);
    if (!j) continue;
    // 空串不覆盖有值的（面板里清空某项不该把默认值抹掉）
    for (const [k, v] of Object.entries(j)) {
      if (v === '' || v === null || v === undefined) continue;
      cfg[k] = v;
    }
    sources.push(p);
  }
  if (!cfg.outDir) cfg.outDir = join(PACK_DIR, 'out');
  return { cfg, dataRoot, sources, candidates };
}

/** 音色别名：voice=ja → voicePresets.ja（统一小写匹配） */
export function resolveVoice(cfg, voice) {
  let v = String(voice || '').trim();
  if (!v) return null;

  // 面板下拉的值是「中文名｜voice_type」这种形式（人能看懂），这里剥出真正的 voice_type。
  // 全角｜和半角 | 都认；没有分隔符就当纯 id 用。
  for (const sep of ['｜', '|']) {
    if (v.includes(sep)) {
      const tail = v.split(sep).pop().trim();
      if (tail) { v = tail; break; }
    }
  }

  const presets = cfg.voicePresets || {};
  if (presets[v]) return presets[v];
  const lower = v.toLowerCase();
  if (presets[lower]) return presets[lower];
  return v;
}

/**
 * 选出最终要用的 speaker（★2026-10-26 修）
 *
 * 坑：面板的 select/datalist 存的是「中文名｜voice_type」整串，
 * 而老代码写的是 `resolveVoice(cfg, voice) || cfg.defaultSpeaker` ——
 * voice 为空时 resolveVoice 返回 null，于是**整串原样**拿去当 speaker，
 * 火山直接回 55000000 "resource ID is mismatched with speaker"。
 *
 * 所以 cfg.customSpeaker / cfg.defaultSpeaker 也**必须**过一遍 resolveVoice。
 */
export function pickSpeaker(cfg, override) {
  const fromOverride = resolveVoice(cfg, override);
  if (fromOverride) return fromOverride;
  const fromCustom = resolveVoice(cfg, cfg.customSpeaker);
  if (fromCustom) return fromCustom;
  const fromDefault = resolveVoice(cfg, cfg.defaultSpeaker);
  if (fromDefault) return fromDefault;
  return String(cfg.defaultSpeaker || '');
}

/**
 * Resource-Id 判定（2026-11-11 修订 —— 旧规则按前缀猜，已实测被推翻）
 *
 * 旧规则（错）：
 *   · `S_` 前缀 ⇒ seed-icl-1.0
 *   · `ICL_` 前缀 ⇒ seed-icl-2.0
 *
 * 实测（2026-11-11，同一把 API Key）：
 *   · 音色 `S_3RlxkTBi2`（在**复刻 2.0** 建的）挂 `seed-icl-1.0` ⇒ **403**
 *     挂 `seed-icl-2.0` ⇒ **200**
 *   · 自拟代号 `whaleclone787cf6b` 挂 `seed-icl-2.0` ⇒ 200，挂 `seed-tts-2.0` ⇒ 55000000
 *
 * 结论：**ID 前缀不可靠，能用的版本取决于该音色是在哪一版复刻服务里建的**。
 * 所以 auto 改成：
 *   ① `_mars_/_moon_` 结尾的老 1.0 大模型音色 → seed-tts-1.0
 *   ② 看起来像「复刻音色」（`S_` / `ICL_` / 不含 `_bigtts` 的自拟代号）→ **优先 seed-icl-2.0**
 *   ③ 其余（`*_bigtts` 的 2.0 官方音色）→ seed-tts-2.0
 *
 * 另外 `synthesize` 里挂了兜底：遇到 403 / resource mismatched 时，
 * 会自动换用另一个 icl 资源再试一次（见 outbound/volcengintts.mjs）。
 * 面板里手填 resourceId 时，一切听面板的（不猜）。
 */
export function isCloneLike(speaker) {
  const sp = String(speaker || '');
  if (!sp) return false;
  if (/^S_/i.test(sp) || /^ICL_/i.test(sp)) return true;   // 复刻槽位 / ICL 角色音色
  return !/_bigtts$/i.test(sp) && !/^zh_|^en_|^ja_|^multi_/i.test(sp);
}

export function resolveResourceId(cfg, speaker) {
  const sp = String(speaker || cfg.defaultSpeaker || '');
  if (/_(mars|moon)_bigtts$/i.test(sp)) return 'seed-tts-1.0';
  if (cfg.resourceId && cfg.resourceId !== 'auto') return cfg.resourceId;
  if (isCloneLike(sp)) return 'seed-icl-2.0';
  return 'seed-tts-2.0';
}

/** 复刻音色的备选资源（403/不匹配时兜底换一个再试） */
export function altResourceId(rid, speaker) {
  if (!isCloneLike(speaker)) return '';
  if (rid === 'seed-icl-2.0') return 'seed-icl-1.0';
  if (rid === 'seed-icl-1.0') return 'seed-icl-2.0';
  return '';
}

export function hasAuth(cfg) {
  return !!((cfg.appId && cfg.accessToken) || cfg.apiKey);
}

/**
 * 拼鉴权头。**先看面板的 `authMode`，再看填了什么**（2026-11-11 修）。
 *
 * ⚠️ 原实现是「有 appId+accessToken 就用旧版三件套」——
 *    用户明明选了 apiKey，只因为控制台页面上还留着 old 的 AppId/Token，
 *    就会**静默走旧版鉴权**：火山回 401/403（load grant: requested grant not found in SaaS storage），
 *    报错还看不出是鉴权方式选错了。现在按 authMode 走：
 *      · 'apiKey' → 只发 X-Api-Key（appId/token 填了也忽略）
 *      · 'legacy' → 只发旧版三件套
 *      · 未设置 → 按"填了什么"猜（旧行为，向后兼容）
 */
export function buildHeaders(cfg, speaker, ridOverride) {
  const h = { 'Content-Type': 'application/json' };
  const mode = String(cfg.authMode || '').trim();
  const hasLegacy = !!(cfg.appId && cfg.accessToken);
  const hasApiKey = !!cfg.apiKey;
  // ★ 2026-11-14（CodeRabbit 审查）：**显式选了模式就只认那一种凭据**。
  //   原来 mode=apiKey 但 apiKey 为空时，会继续往下落到 `else if (appId&&accessToken)`
  //   偷偷用旧版三件套；mode=legacy 而旧版凭据不全时又会退到 X-Api-Key。
  //   用户明确选过的模式不该被静默换掉（火山那边报的是 401/403，根本看不出是选错了）。
  const useLegacy = mode === 'legacy'
    ? true
    : mode === 'apiKey'
      ? false
      : hasLegacy; // 未设置模式 → 按"填了什么"猜（向后兼容）
  if (useLegacy) {
    if (!hasLegacy) {
      throw new Error('鉴权方式选了「旧版三件套」，但 AppId / AccessToken 没填全（或把鉴权方式切成 API Key）');
    }
    h['X-Api-App-Id'] = String(cfg.appId);
    h['X-Api-Access-Key'] = String(cfg.accessToken);
  } else {
    if (!hasApiKey) {
      throw new Error('鉴权方式选了「API Key」，但 API Key 没填（或把鉴权方式切成旧版并填 AppId+AccessToken）');
    }
    h['X-Api-Key'] = String(cfg.apiKey);
  }
  const rid = ridOverride || resolveResourceId(cfg, speaker);
  if (rid) h['X-Api-Resource-Id'] = rid;
  h['X-Api-Request-Id'] = randomUUID();
  return h;
}

export function ensureOutDir(cfg) {
  const dir = cfg.outDir || join(PACK_DIR, 'out');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 面板里该展示的鉴权状态（不泄露密钥本体） */
export function describeAuth(cfg) {
  // 与 buildHeaders 同口径：authMode 优先（否则面板显示与实际用的鉴权会对不上，排查时误导）
  const wantLegacy = String(cfg.authMode || '').trim() === 'legacy';
  const mode = wantLegacy && cfg.appId && cfg.accessToken ? 'legacy' : (cfg.apiKey ? 'apiKey' : (cfg.appId && cfg.accessToken ? 'legacy' : 'none'));
  const mask = (s) => {
    const t = String(s || '');
    if (!t) return '';
    if (t.length <= 8) return '*'.repeat(t.length);
    return t.slice(0, 4) + '****' + t.slice(-4);
  };
  return {
    mode,
    ok: hasAuth(cfg),
    apiKey: mask(cfg.apiKey),
    appId: cfg.appId ? mask(cfg.appId) : '',
    accessToken: mask(cfg.accessToken),
    speaker: cfg.defaultSpeaker,
    resourceId: resolveResourceId(cfg, cfg.defaultSpeaker),
    model: cfg.model,
  };
}
