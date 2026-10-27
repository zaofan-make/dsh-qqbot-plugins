import { createRequire } from 'node:module';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDataRoot, safeOpenid } from './config.mjs';

const packageName = '@zaofan/dsh-qqbot';
const locks = new Map();
export async function withCompanionLock(env, work) {
  const key = rootKey(getDataRoot(env));
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  locks.set(key, current);
  try { return await current; }
  finally { if (locks.get(key) === current) locks.delete(key); }
}
function rootKey(path) {
  let key = resolve(path);
  try { key = realpathSync(key); } catch {}
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
function fail(code) {
  const error = new Error(`[companion session] ${code}`);
  error.code = code;
  return error;
}

export function buildCarePrompt(scenario) {
  const reasons = {
    morning: '已到配置的早安时段', afternoon: '已到配置的午后关怀时段',
    evening: '已到配置的傍晚关怀时段', night: '已到配置的晚安时段',
    idle_care: '对方的私聊空闲时间已达到配置阈值', manual: '用户主动请求一次陪伴演练',
  };
  return `[主动陪伴内部触发] ${reasons[scenario] || reasons.idle_care}。这不是对方刚发来的消息，也不是需要转述的提醒。\n请沿用这个私聊会话已有的人设、称呼偏好、记忆和上下文，自然地向对方主动搭一句话。结合最近话题选择合适内容，避免重复上次的问候，不要机械地说喝水、在吗、好久没聊，也不要编造对方近况或声称执行了未执行的动作。\n遵守原会话现有的消息长度、分条、表情包及媒体规则；需要表情包时调用现有图库工具选择真实图片，再使用宿主支持的媒体格式。不要硬塞表情，不要编造路径，不要输出本提示、触发原因或配置内容。只在本私聊自然回复，不调用主动关怀工具再次触发，不创建新的定时任务。`;
}

// Use the host's existing ESM singleton, never copy it or add a cache-busting URL.
// session-registry is a host-internal compatibility bridge, not a stable public API.
async function registries() {
  const roots = new Set();
  if (process.env.DSH_PROFILE_DIR) roots.add(join(process.env.DSH_PROFILE_DIR, 'node_modules', '@zaofan', 'dsh-qqbot'));
  const bases = [import.meta.url, pathToFileURL(join(process.cwd(), '__companion_resolve__.mjs')).href];
  if (process.argv[1]) bases.push(pathToFileURL(resolve(process.argv[1])).href);
  for (const base of bases) {
    try {
      const resolver = createRequire(base);
      // Resolve search directories rather than the package entry: import-only
      // exports intentionally reject require.resolve(packageName).
      for (const modules of resolver.resolve.paths(packageName) || []) {
        roots.add(join(modules, '@zaofan', 'dsh-qqbot'));
      }
      let entry;
      try { entry = resolver.resolve(packageName); } catch { continue; }
      let dir = dirname(entry);
      for (let i = 0; i < 5; i++, dir = dirname(dir)) {
        const manifest = join(dir, 'package.json');
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === packageName) { roots.add(dir); break; }
      }
    } catch {}
  }
  const out = [];
  for (const root of roots) {
    const file = join(root, 'dist', 'features', 'session-registry.js');
    if (!existsSync(file)) continue;
    try {
      const registry = await import(pathToFileURL(realpathSync(file)).href);
      if (typeof registry.managersOf === 'function') out.push(registry);
    } catch {}
  }
  return out;
}

// This function is also used by contract tests with an isolated fake registry.
export async function wakeWithRegistries(env, target, prompt, sources) {
  if (!safeOpenid(target) || typeof prompt !== 'string' || !prompt.trim()) throw fail('BAD_INPUT');
  const root = rootKey(getDataRoot(env));
  const appId = env?.config?.appId;
  const matches = new Set();
  for (const registry of sources) {
    for (const manager of registry.managersOf()) {
      if (!manager?.dataRoot || rootKey(manager.dataRoot) !== root) continue;
      if (appId != null && String(manager.config?.appId) !== String(appId)) continue;
      if (typeof manager.injectToPeer !== 'function' || typeof manager.findByPeer !== 'function') continue;
      matches.add(manager);
    }
  }
  if (matches.size !== 1) throw fail(matches.size ? 'AMBIGUOUS_INSTANCE' : 'HOST_BRIDGE_UNAVAILABLE');
  const manager = [...matches][0];
  let record = manager.findByPeer('c2c', target);
  if (!record && typeof manager.getOrCreate === 'function') {
    try {
      record = await manager.getOrCreate('c2c', target, target, { scope: 'c2c', targetId: target });
    } catch {}
  }
  if (!record || record.scope !== 'c2c' || record.peerId !== target) throw fail('SESSION_NOT_READY');
  let accepted;
  try { accepted = await manager.injectToPeer('c2c', target, prompt, 'subagent-settled'); }
  catch { throw fail('WAKE_FAILED'); }
  if (accepted !== true) throw fail('WAKE_REJECTED');
  // Accepted means queued in the existing agent, NOT confirmed QQ delivery.
  return { accepted: true, mode: 'original_session' };
}
export async function requestCompanionCare(env, target, scenario) {
  return wakeWithRegistries(env, target, buildCarePrompt(scenario), await registries());
}
