import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CONFIG_KEYS = [
  'enabled', 'targetOpenid', 'dailyMax', 'maxUnanswered', 'minIntervalHours', 'dndStart', 'dndEnd',
  'windowGreetingEnabled', 'morningEnabled', 'morningStart', 'morningEnd',
  'afternoonEnabled', 'afternoonStart', 'afternoonEnd', 'eveningEnabled',
  'eveningStart', 'eveningEnd', 'nightEnabled', 'nightStart', 'nightEnd',
  'idlePokeEnabled', 'idleHoursThreshold', 'idleMinutesThreshold', 'mutedDate',
  'lastCheckTs', 'lastCheckReason', 'lastSendError',
  // Runtime counters are kept in the same ext-config file so daemon, command,
  // and tool views cannot diverge across separate stores.
  'lastBubbleTs', 'consecutiveBubblesWithoutReply', 'dailyDate', 'dailyCount',
  'greetedWindowsToday', 'lastInteractionTs',
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
  out.dailyMax = Number.isInteger(Number(out.dailyMax)) && Number(out.dailyMax) >= 0 ? Number(out.dailyMax) : 5;
  out.maxUnanswered = Number.isInteger(Number(out.maxUnanswered)) && Number(out.maxUnanswered) >= 0 ? Number(out.maxUnanswered) : 3;
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
  const ownerLists = [
    env?.owners,
    env?.caps?.owners,
    env?.config?.groupAdmin?.owners,
    env?.config?.owners,
  ];
  const ownerFallbacks = ownerLists.flatMap((list) => Array.isArray(list) ? list : []);
  const candidates = [ext.targetOpenid, state.targetOpenid, ...ownerFallbacks];
  for (const candidate of candidates) {
    const safe = safeOpenid(candidate);
    if (safe) return safe;
  }
  return '';
}

export function isOwnerContext(ctx = {}) {
  if (
    ctx?.user?.isOwner === true ||
    ctx?.performer?.isOwner === true ||
    ctx?.isOwner === true ||
    ctx?.permissions?.isOwner === true ||
    ctx?.sender?.isOwner === true
  ) return true;
  const env = ctx?.env || ctx;
  const lists = [
    ctx?.owners,
    ctx?.caps?.owners,
    env?.owners,
    env?.caps?.owners,
    env?.config?.groupAdmin?.owners,
    env?.config?.owners,
  ];
  const owners = [...new Set(lists.flatMap((list) => Array.isArray(list) ? list.map(String) : []))];
  const actor = String(
    ctx?.user?.openid || ctx?.actorOpenid || ctx?.message?.senderId || ctx?.senderId ||
    ctx?.senderOpenid || ctx?.userOpenid || ctx?.openid || ctx?.sender?.openid ||
    ctx?.message?.author?.id || ctx?.message?.sender?.openid || ''
  ).trim();
  if (actor && owners.includes(actor)) return true;

  // Some private-message command contexts omit the host owner capability. In
  // that case, allow only the explicitly configured panel target, never an
  // arbitrary private-message sender or the latest known chat.
  const configuredTarget = safeOpenid(readExtConfig(env).targetOpenid);
  return Boolean(actor && configuredTarget && actor === configuredTarget);
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

/**
 * 从当前命令或消息上下文中提取私聊 OpenID
 * @param {object} ctx
 * @returns {{ ok: boolean, isGroup: boolean, openid: string, reason?: string, fromHistory?: boolean }}
 */
export function extractC2COpenid(ctx = {}) {
  // 检查是否明确处于群聊环境
  const scope = String(
    ctx?.peer?.scope ||
    ctx?.caps?.scope ||
    ctx?.message?.kind ||
    ctx?.message?.scope ||
    ''
  ).toLowerCase();
  const isGroup = scope === 'group' || Boolean(ctx?.message?.groupOpenid || ctx?.message?.group_openid);
  if (isGroup) {
    return { ok: false, isGroup: true, openid: '', reason: 'in_group' };
  }

  const env = ctx?.env || ctx;
  const candidates = [
    ctx?.peer?.scope === 'c2c' ? ctx.peer.peerId : '',
    ctx?.user?.openid,
    ctx?.caps?.scope === 'c2c' ? ctx.caps.peerId : '',
    ctx?.caps?.actorOpenid,
    ctx?.actorOpenid,
    ctx?.senderOpenid,
    ctx?.userOpenid,
    ctx?.openid,
    ctx?.message?.author?.user_openid,
    ctx?.message?.author?.id,
    ctx?.message?.senderId,
    ctx?.replyTarget?.scope === 'c2c' ? ctx.replyTarget.id : '',
  ];

  for (const item of candidates) {
    const safe = safeOpenid(item);
    if (safe) return { ok: true, isGroup: false, openid: safe };
  }

  // 兜底尝试从历史最近 C2C 记录寻找
  const latest = findLatestC2COpenid(env);
  if (latest) {
    return { ok: true, isGroup: false, openid: latest, fromHistory: true };
  }

  return { ok: false, isGroup: false, openid: '', reason: 'missing_openid' };
}

/**
 * 获取当前私聊 OpenID，并在合规时自动将其填入扩展配置中的 targetOpenid
 * @param {object} ctx
 * @returns {{ ok: boolean, openid?: string, isGroup?: boolean, updated?: boolean, text: string }}
 */
export function bindTargetOpenidFromContext(ctx = {}) {
  const result = extractC2COpenid(ctx);
  if (result.isGroup) {
    return {
      ok: false,
      isGroup: true,
      text: '【主动陪伴】本指令用于获取私聊 OpenID 并绑定主动关怀。\n当前处于群聊环境，请在与机器人的【私聊会话】中发送此指令（如 /openid 或 /whoami）以完成自动绑定。',
    };
  }

  if (!result.ok || !result.openid) {
    return {
      ok: false,
      text: '【主动陪伴】未能获取到当前私聊的 OpenID。\n请确认你正在与机器人私聊，并发送一条普通文本后再试。',
    };
  }

  const targetId = result.openid;
  const env = ctx?.env || ctx;
  const conf = readExtConfig(env);
  const currentTarget = safeOpenid(conf.targetOpenid);
  const isOwner = isOwnerContext(ctx);

  // 如果已经配置了且与当前不一致，且当前发送者不是宿主主人，防止非主人篡改
  if (currentTarget && currentTarget !== targetId && !isOwner) {
    return {
      ok: false,
      openid: targetId,
      text: `【主动陪伴】当前私聊 OpenID 为：\n${targetId}\n\n⚠️ 设置中已绑定其他主人 OpenID（${redactOpenid(currentTarget)}）。如需更换绑定，请由主人通过后台设置修改，或由系统主人发送指令。`,
    };
  }

  // 自动写入配置
  const isNew = currentTarget !== targetId;
  writeExtConfig(env, { targetOpenid: targetId });

  const statusNote = conf.enabled === false ? '\n（提示：当前主动陪伴总开关为关闭状态，发送 /companion on 即可开启）' : '';

  if (!isNew) {
    return {
      ok: true,
      openid: targetId,
      updated: false,
      text: `【主动陪伴】当前私聊 OpenID：\n${targetId}\n\nℹ️ 配置中已正确绑定此 OpenID，无需重复设置。${statusNote}`,
    };
  }

  return {
    ok: true,
    openid: targetId,
    updated: true,
    text: `【主动陪伴】当前私聊 OpenID 获取成功！\n\n🔑 私聊 OpenID：\n${targetId}\n\n🎉 已自动填入「主动陪伴关怀设置」的主人配置中！后续的主动问候与空闲冒泡将定向至此私聊。${statusNote}`,
  };
}
