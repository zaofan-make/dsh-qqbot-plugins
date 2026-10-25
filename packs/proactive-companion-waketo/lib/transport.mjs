import { createHash } from 'node:crypto';

// Contracts verified against the installed dsh-qqbot ext-capabilities.js,
// ext-hooks.js and api/group-admin.js. Hooks expose instance config but their
// caps currently have no credentials. caps.text(s) only targets replyTarget.
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.bot.qq.com';
const TIMEOUT_MS = 10_000;
const tokenCache = new Map();
const tokenRequests = new Map();
let lastSequence = 0;

function failure(stage, code, status) {
  // Never copy upstream messages, bodies, causes, URLs or credentials into errors.
  const safeCode = /^(?:\d{1,12}|NO_CREDENTIALS|BAD_RESPONSE|TIMEOUT|NETWORK|UNAVAILABLE|REJECTED|BAD_TARGET|BAD_TEXT|THROW)$/.test(String(code))
    ? String(code) : 'REJECTED';
  const error = new Error(`[companion transport] ${stage}: ${safeCode}${Number.isInteger(status) ? ` (HTTP ${status})` : ''}`);
  error.code = safeCode;
  error.stage = stage;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

async function withTimeout(stage, work) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(failure(stage, 'TIMEOUT'));
        }, TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (timedOut) throw failure(stage, 'TIMEOUT');
    // Only errors created here are safe to propagate. Arbitrary host/fetch
    // errors may contain request headers, bodies or the token itself.
    if (error?.stage === stage && error?.message?.startsWith('[companion transport]')) {
      throw failure(stage, error.code, error.status);
    }
    throw failure(stage, 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(stage, url, init) {
  if (typeof globalThis.fetch !== 'function') throw failure(stage, 'UNAVAILABLE');
  return withTimeout(stage, async (signal) => {
    const response = await globalThis.fetch(url, { ...init, signal });
    let data;
    try {
      data = await response.json();
    } catch {
      throw failure(stage, 'BAD_RESPONSE', response.status);
    }
    if (!response.ok || (data?.code !== undefined && String(data.code) !== '0')) {
      throw failure(stage, data?.code ?? 'REJECTED', response.status);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw failure(stage, 'BAD_RESPONSE', response.status);
    }
    return data;
  });
}

function credentials(env) {
  const appId = typeof env?.config?.appId === 'string' || typeof env?.config?.appId === 'number'
    ? String(env.config.appId).trim() : '';
  const appSecret = typeof env?.config?.appSecret === 'string' ? env.config.appSecret.trim() : '';
  // Do not resolve environment placeholders or read any files/process settings.
  if (!appId || !appSecret || /\$\{|^env:/i.test(appId) || /\$\{|^env:/i.test(appSecret)) return null;
  const key = createHash('sha256').update(JSON.stringify([appId, appSecret])).digest('hex');
  return { appId, appSecret, key };
}

async function accessToken(creds) {
  const hit = tokenCache.get(creds.key);
  if (hit && Date.now() < hit.expiresAt) return hit.token;
  const inflight = tokenRequests.get(creds.key);
  if (inflight) return inflight;
  const pending = (async () => {
    const data = await requestJson('token', TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: creds.appId, clientSecret: creds.appSecret }),
    });
    if (typeof data.access_token !== 'string' || !data.access_token.trim()) {
      throw failure('token', 'BAD_RESPONSE');
    }
    const ttl = Number(data.expires_in ?? 7200);
    if (!Number.isFinite(ttl) || ttl <= 0) throw failure('token', 'BAD_RESPONSE');
    // Never cache past the actual TTL, even for unusually short-lived tokens.
    tokenCache.set(creds.key, {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000,
    });
    return data.access_token;
  })();
  tokenRequests.set(creds.key, pending);
  try {
    return await pending;
  } finally {
    if (tokenRequests.get(creds.key) === pending) tokenRequests.delete(creds.key);
  }
}

async function sendDirect(creds, path, body) {
  const token = await accessToken(creds);
  try {
    await requestJson('message', `${API_BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error?.status === 401) tokenCache.delete(creds.key);
    // Do not retry a message whose delivery might already have occurred.
    throw error;
  }
  return true;
}

async function sendAdapter(env, target, text) {
  const result = await withTimeout('adapter', () => env.text(target, text, { scope: 'c2c' }));
  if (result === false || result?.ok === false) throw failure('adapter', 'REJECTED');
  return true;
}

/**
 * Send plain text to an explicit C2C openid. Resolves true on confirmed API
 * success, or a completed explicit host adapter (legacy void return allowed).
 * Rejects with a credential-free Error carrying code, stage and optional status.
 *
 * Order: caps.api (legacy env.api only when caps.api is absent); NO_CREDENTIALS
 * falls back to env.config.appId/appSecret, then an explicit env.text adapter.
 * Without an API, an explicit adapter precedes instance credentials.
 * Other API failures/timeouts never trigger a second, potentially duplicate send.
 * The adapter must implement text(target, text, {scope:'c2c'}); do not expose
 * makeExtCaps.text(s) as that adapter. No caps.text/qq.sendText guessing occurs.
 * Each host operation and each HTTP exchange has a 10-second deadline; token
 * fetches are cached with a 60-second safety margin and coalesced per credential.
 */
export async function sendCompanionText(env, target, text) {
  if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(target.trim())) {
    throw failure('input', 'BAD_TARGET');
  }
  if (typeof text !== 'string' || !text.trim()) throw failure('input', 'BAD_TEXT');
  const openid = target.trim();
  const path = `/v2/users/${encodeURIComponent(openid)}/messages`;
  lastSequence = Math.max(lastSequence + 1, Math.floor(Date.now() / 1000));
  const body = { content: text, msg_type: 0, msg_seq: lastSequence };
  const apiOwner = typeof env?.caps?.api === 'function' ? env.caps : env;
  const api = typeof apiOwner?.api === 'function' ? apiOwner.api : null;
  const adapter = typeof env?.text === 'function' && env.text !== env?.caps?.text;
  if (api) {
    const result = await withTimeout('caps.api', () => api.call(apiOwner, path, { method: 'POST', body }));
    if (result?.ok === true) return true;
    if (result?.err?.code !== 'NO_CREDENTIALS') {
      throw failure('caps.api', result?.err?.code ?? 'BAD_RESPONSE');
    }
    const creds = credentials(env);
    if (creds) return sendDirect(creds, path, body);
    if (adapter) return sendAdapter(env, openid, text);
    throw failure('credentials', 'NO_CREDENTIALS');
  }
  if (adapter) return sendAdapter(env, openid, text);
  const creds = credentials(env);
  if (creds) return sendDirect(creds, path, body);
  throw failure('transport', 'NO_CREDENTIALS');
}

/**
 * ★ Ask the host to WAKE the AI for an explicit C2C peer (2026-10-13).
 *
 * This is the preferred delivery path: instead of shipping a canned template,
 * the daemon injects a simulated user message into the target conversation and
 * lets the AI answer in character. The host sends the AI's own reply to QQ, so
 * what the user receives is a real turn, not boilerplate.
 *
 * Returns true only when the host confirms delivery. Hosts without
 * caps.wakeTo (older builds) return false so callers fall back to templates.
 * Never throws: a wake failure must not lose the fallback opportunity.
 */
export async function wakeCompanion(env, target, prompt) {
  const caps = env?.caps;
  const wakeTo = caps?.wakeTo;
  if (typeof wakeTo !== 'function') return false;
  if (typeof target !== 'string' || !target.trim()) return false;
  if (typeof prompt !== 'string' || !prompt.trim()) return false;
  try {
    return (await wakeTo.call(caps, 'c2c', target.trim(), prompt)) === true;
  } catch {
    return false;
  }
}
