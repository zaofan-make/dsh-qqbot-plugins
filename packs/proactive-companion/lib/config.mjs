import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CONFIG_KEYS = [
  'enabled', 'targetOpenid', 'displayName', 'dailyMax', 'minIntervalHours', 'dndStart', 'dndEnd',
  'windowGreetingEnabled', 'morningEnabled', 'morningStart', 'morningEnd',
  'afternoonEnabled', 'afternoonStart', 'afternoonEnd', 'eveningEnabled',
  'eveningStart', 'eveningEnd', 'nightEnabled', 'nightStart', 'nightEnd',
  'idlePokeEnabled', 'idleHoursThreshold', 'idleMinutesThreshold', 'mutedDate',
  'lastCheckTs', 'lastCheckReason', 'lastSendError',
  // Runtime counters are kept in the same ext-config file so daemon, command,
  // and tool views cannot diverge across separate stores.
  'lastBubbleTs', 'consecutiveBubblesWithoutReply', 'dailyDate', 'dailyCount',
  'greetedWindowsToday', 'lastInteractionTs',
  // 2026-10-25：最近一次冒泡走的是哪条路 —— 'wake'（唤醒 AI 自己说）/ 'template'（回退预置文案）。
  // 之前两种都归成 sent，面板上根本分不清，排查时只能去翻出站日志。
  'lastDelivery',
];

export function getDataRoot(env) {
  return env?.dataRoot || join(process.cwd(), 'dshqqbot');
}

export function getExtConfigPath(env) {
  return join(getDataRoot(env), '.qqbot-extensions', '.state', 'ext-config', 'companion-daemon.json');
}

export function readJsonFile(path) {
  try {
    if (!existsSync(path)) return {};
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function readExtConfig(env) {
  return readJsonFile(getExtConfigPath(env));
}

export function pickConfig(value) {
  const out = {};
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value || {}, key)) out[key] = value[key];
  }
  return out;
}

export function normalizeConfig(value = {}) {
  const out = pickConfig(value);
  const positive = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const integer = (v, fallback) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  const time = (v, fallback) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? v : fallback;
  out.enabled = out.enabled !== false;
  out.displayName = typeof out.displayName === 'string' ? out.displayName.trim().slice(0, 80) || '主人' : '主人';
  out.dailyMax = Number.isInteger(Number(out.dailyMax)) && Number(out.dailyMax) >= 0 ? Number(out.dailyMax) : 5;
  out.minIntervalHours = value.minIntervalHours !== null && String(out.minIntervalHours ?? "").trim() !== "" && Number.isFinite(Number(out.minIntervalHours)) && Number(out.minIntervalHours) >= 0 ? Number(out.minIntervalHours) : 2.5;
  out.idleHoursThreshold = Number.isFinite(Number(out.idleHoursThreshold)) && Number(out.idleHoursThreshold) >= 0 ? Number(out.idleHoursThreshold) : 3;
  out.idleMinutesThreshold = Math.max(1, positive(out.idleMinutesThreshold, 30));
  for (const key of ['lastBubbleTs', 'lastInteractionTs', 'consecutiveBubblesWithoutReply']) {
    out[key] = Number.isFinite(Number(out[key])) && Number(out[key]) >= 0 ? Number(out[key]) : 0;
  }
  out.dndStart = time(out.dndStart, '23:30');
  out.dndEnd = time(out.dndEnd, '08:30');
  for (const key of ['morningStart', 'afternoonStart', 'eveningStart', 'nightStart']) out[key] = time(out[key], { morningStart: '08:30', afternoonStart: '14:00', eveningStart: '18:30', nightStart: '22:30' }[key]);
  for (const key of ['morningEnd', 'afternoonEnd', 'eveningEnd', 'nightEnd']) out[key] = time(out[key], { morningEnd: '09:30', afternoonEnd: '14:30', eveningEnd: '19:30', nightEnd: '23:30' }[key]);
  const routeDefaults = {
    windowGreetingEnabled: true,
    morningEnabled: true,
    afternoonEnabled: false,
    eveningEnabled: false,
    nightEnabled: true,
    idlePokeEnabled: true,
  };
  for (const key of Object.keys(routeDefaults)) {
    out[key] = Object.prototype.hasOwnProperty.call(out, key) ? out[key] !== false : routeDefaults[key];
  }
  out.dailyCount = Number.isInteger(Number(out.dailyCount)) && Number(out.dailyCount) >= 0 ? Number(out.dailyCount) : 0;
  out.greetedWindowsToday = Array.isArray(out.greetedWindowsToday) ? out.greetedWindowsToday.filter(v => typeof v === 'string') : [];
  return out;
}

export function writeExtConfig(env, patch) {
  const path = getExtConfigPath(env);
  const dir = join(getDataRoot(env), '.qqbot-extensions', '.state', 'ext-config');
  mkdirSync(dir, { recursive: true });
  const next = normalizeConfig({ ...readJsonFile(path), ...pickConfig(patch) });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // Keep sync semantics for existing callers while serializing writers within
  // this process. Unique temp names prevent cross-process temp-file collisions.
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  try {
    // renameSync replaces the destination atomically on POSIX and on current
    // Windows runtimes when the destination is a regular file.
    try {
      renameSync(tmp, path);
    } catch (error) {
      // Windows may reject replacement while the old file is briefly open.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      if (existsSync(path)) unlinkSync(path);
      renameSync(tmp, path);
    }
    return next;
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw error;
  }
}

export function findLatestC2COpenid(env) {
  const path = join(getDataRoot(env), '表情包', 'known-chats.jsonl');
  try {
    if (!existsSync(path)) return '';
    let latest = { id: '', ts: -1 };
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.scope !== 'c2c' || typeof item.id !== 'string' || !item.id) continue;
        const ts = Number(item.t || item.ts || (item.time ? Date.parse(item.time) : 0)) || 0;
        if (ts >= latest.ts) latest = { id: item.id, ts };
      } catch {}
    }
    return latest.id;
  } catch {
    return '';
  }
}

export function resolveTargetOpenid(env, state = {}, ext = readExtConfig(env)) {
  // Explicit panel configuration wins; legacy store is second; the host owner list
  // is the only implicit fallback. Never choose an arbitrary recent C2C chat:
  // any stranger can otherwise become the recipient of proactive messages.
  const candidates = [ext.targetOpenid, state.targetOpenid, env?.config?.owners?.[0], env?.caps?.owners?.[0]];
  for (const candidate of candidates) {
    const safe = safeOpenid(candidate);
    if (safe) return safe;
  }
  return '';
}

export function isOwnerContext(ctx = {}) {
  if (ctx?.isOwner === true || ctx?.permissions?.isOwner === true || ctx?.sender?.isOwner === true) return true;
  const env = ctx?.env || ctx;
  const list = env?.config?.owners || env?.caps?.owners || [];
  const owners = Array.isArray(list) ? list.map(String) : [];
  if (!owners.length) return false;
  const actor = String(
    ctx?.senderOpenid || ctx?.userOpenid || ctx?.openid || ctx?.sender?.openid ||
    ctx?.user?.openid || ctx?.message?.author?.id || ctx?.message?.sender?.openid || ''
  ).trim();
  return Boolean(actor && owners.includes(actor));
}

export function redactOpenid(value) {
  const id = String(value || '').trim();
  if (id.length <= 8) return id ? '已配置' : '未配置';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function safeOpenid(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : '';
}
