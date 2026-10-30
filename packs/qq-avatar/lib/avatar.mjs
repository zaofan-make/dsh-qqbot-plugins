/**
 * avatar.mjs —— 群友头像解析与下载（工具与斜杠命令共用）
 *
 * 2026-10-30 主人要：用 QQ 互联那套 `qqapp/{appId}/{openid}/{size}` 拼法拿群友头像。
 *
 * 关键事实（已核过官方文档）：
 *   · 拼法出处 = QQ 互联 get_user_info 的 figureurl_qq_1/_2：
 *       http://q.qlogo.cn/qqapp/{appId}/{openid}/{40|100}
 *     2018-02-11 域名迁移通知后 → https://thirdqq.qlogo.cn/qqapp/...
 *   · **不需要任何 token**，纯 CDN 直链；openid 用「本机器人视角」的那个（台账里就是）
 *   · 尺寸档：文档只写 40/100，实测 640（最大）/0（原图）也能取
 *
 * 台账：`{dataRoot}/表情包/group-members.jsonl`，每行 {ts,gid,mid,name}
 *   mid = member openid，name = 群昵称（在群里发过言 / 申请过入群的人才有）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AVATAR_SIZE = '640';

/** 头像目录：{dataRoot}/.qqbot-extensions/.state/avatars */
export function avatarDir(dataRoot) {
  const dr = String(dataRoot || '').trim();
  if (!dr) return '';
  const dir = join(dr, '.qqbot-extensions', '.state', 'avatars');
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

/** 头像 URL（免鉴权） */
export function avatarUrl(appId, openid, size = AVATAR_SIZE) {
  const a = String(appId || '').trim();
  const o = String(openid || '').trim();
  if (!a || !o) return '';
  return `https://thirdqq.qlogo.cn/qqapp/${encodeURIComponent(a)}/${encodeURIComponent(o)}/${size}`;
}

/** 读台账 → [{openid, name, gid, ts}]（按 ts 升序，同名取最近的） */
export function readLedger(dataRoot) {
  const dr = String(dataRoot || '').trim();
  if (!dr) return [];
  const f = join(dr, '表情包', 'group-members.jsonl');
  if (!existsSync(f)) return [];
  const out = [];
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        const openid = String(o.mid || o.openid || '').trim();
        if (!openid) continue;
        out.push({ openid, name: String(o.name || '').trim(), gid: String(o.gid || ''), ts: Number(o.ts) || 0 });
      } catch { /* 坏行跳过 */ }
    }
  } catch { return []; }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * 按「名字或 openid」找人。
 *   · 形如 32 位大写十六进制 → 直接当 openid
 *   · 否则按名字模糊匹配（包含即命中，忽略大小写/空格），同名取最近发言的那个
 * @returns {{openid:string,name:string}|{error:string}}
 */
export function resolveWho(dataRoot, who) {
  const q = String(who || '').trim();
  if (!q) return { error: '空' };
  if (/^[0-9A-Fa-f]{32}$/.test(q)) return { openid: q.toUpperCase(), name: '' };

  const rows = readLedger(dataRoot);
  if (!rows.length) return { error: '台账里还没有任何群友（没人发过言）' };

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const key = norm(q);
  // ① 完全相等（取最近的）→ ② 包含
  let hit = null;
  for (const r of rows) if (norm(r.name) === key) hit = r;
  if (!hit) for (const r of rows) if (norm(r.name).includes(key)) hit = r;
  if (!hit) {
    const cands = [...new Set(rows.map((r) => r.name).filter(Boolean))].slice(0, 12);
    return { error: `台账里没有叫「${q}」的人。已知有：${cands.join('、') || '(空)'}` };
  }
  return { openid: hit.openid, name: hit.name };
}

/** 文件名安全化 */
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'unknown';
}

/**
 * 下载头像到 avatars 目录。
 * @returns {Promise<{ok:boolean, path?:string, file?:string, bytes?:number, error?:string}>}
 */
export async function downloadAvatar({ appId, dataRoot, openid, name }) {
  const dir = avatarDir(dataRoot);
  if (!dir) return { ok: false, error: '拿不到 dataRoot' };
  const url = avatarUrl(appId, openid);
  if (!url) return { ok: false, error: 'appId 或 openid 缺失' };

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 dsh-qqbot' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: '空的响应' };
    // 校验真是图片（防止拿到错误页）
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    if (!isJpg && !isPng) return { ok: false, error: '返回的不是图片（可能 openid 不对）' };

    const ext = isPng ? 'png' : 'jpg';
    const file = `${safeName(name || 'qq')}_${String(openid).slice(0, 8)}.${ext}`;
    const path = join(dir, file);
    writeFileSync(path, buf);
    return { ok: true, path, file, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
