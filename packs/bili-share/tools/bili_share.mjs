/**
 * bili_share.mjs —— B 站视频「搜索 → 取封面/标题/简介/链接 → 分享成图文卡片」
 *
 * 2026-10-29（主人要）：
 *   官方 20261021 新增「图文卡片」消息（msg_type=8，card.type=tuwen + card.content.*），
 *   比纯文本链接富态得多。B 站搜索需要 wbi 签名，写在这里一次搞定。
 *
 * 包内设置（面板「设置中心」可填，存 {dataRoot}/.qqbot-extensions/.state/ext-config/bili_share.json）：
 *   · sessdata：可选。填了搜索更稳（未登录搜索偶发被风控 -412）。
 *     取法：浏览器登录 bilibili.com → F12 → Application/存储 → Cookies → 复制 SESSDATA。
 *     ⚠️ 它是 HttpOnly，`document.cookie` 读不到，只能在开发者工具里手抄。
 *
 * 契约：export default { name, description, inputSchema, run(args, env) } → { ok, msg }
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

/** 设置中心表单（面板自动渲染；值存 ext-config/bili_share.json） */
export const qqbotSettingsPage = {
  title: 'B 站分享',
  desc: '只影响「搜索」的稳定性。SESSDATA 可选：填了搜索更稳；不填也能搜（未登录偶发被风控）。',
  schema: [
    { key: 'sessdata', type: 'string', label: 'SESSDATA（可选）', secret: true },
    { key: 'pageSize', type: 'number', label: '搜索返回条数（默认 5）' },
    { key: 'alwaysDryRun', type: 'bool', label: '只生成卡片内容、不真的发送' },
  ],
};

function readCfg(env) {
  try {
    const dr = String(env?.dataRoot || '');
    if (!dr) return {};
    const p = join(dr, '.qqbot-extensions', '.state', 'ext-config', 'bili_share.json');
    const raw = readFileSync(p, 'utf8');
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : {};
  } catch { return {}; }
}

let WBI = { key: '', at: 0 };

async function jget(url, cookie) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers });
  return await res.json();
}

/** wbi 签名（bilibili-API-collect 标准做法；keys 缓存 30 分钟） */
async function wbiQuery(params, cookie) {
  if (!WBI.key || Date.now() - WBI.at > 30 * 60 * 1000) {
    const nav = await jget('https://api.bilibili.com/x/web-interface/nav', cookie);
    const img = String(nav?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0];
    const sub = String(nav?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0];
    const orig = img + sub;
    WBI = { key: MIXIN_TAB.map((i) => orig[i]).join('').slice(0, 32), at: Date.now() };
  }
  const p = { ...params, wts: String(Math.floor(Date.now() / 1000)) };
  const q = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const w_rid = createHash('md5').update(q + WBI.key).digest('hex');
  return `${q}&w_rid=${w_rid}`;
}

function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}
function httpsPic(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.startsWith('//') ? 'https:' + t : t.replace(/^http:/, 'https:');
}
function durOf(v) {
  if (typeof v === 'string' && v.includes(':')) return v;
  const n = Number(v) || 0;
  if (n >= 3600) return Math.floor(n / 3600) + '小时' + Math.floor((n % 3600) / 60) + '分';
  if (n >= 60) return Math.floor(n / 60) + '分' + (n % 60) + '秒';
  return n ? n + '秒' : '';
}

async function searchVideos(keyword, n, cookie) {
  const qs = await wbiQuery({ search_type: 'video', keyword, page: '1', page_size: String(Math.max(5, n)) }, cookie);
  const res = await jget('https://api.bilibili.com/x/web-interface/wbi/search/type?' + qs, cookie);
  if (res?.code !== 0) throw new Error(`B站搜索失败 code=${res?.code} ${res?.message || ''}${res?.code === -412 ? '（被风控，可在设置里填 SESSDATA）' : ''}`);
  return (res?.data?.result || []).map((v) => ({
    bvid: String(v.bvid || ''),
    title: clean(v.title),
    desc: clean(v.description || '').slice(0, 120),
    pic: httpsPic(v.pic || v.pic_url),
    author: clean(v.author || ''),
    play: Number(v.play) || 0,
    duration: durOf(v.duration),
  })).filter((v) => v.bvid).slice(0, n);
}

async function videoDetail(bvid, cookie) {
  const res = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, cookie);
  if (res?.code !== 0) throw new Error('B站详情失败 code=' + res?.code + ' ' + (res?.message || ''));
  const d = res.data || {};
  return {
    bvid: String(d.bvid || bvid),
    title: clean(d.title),
    desc: clean(d.desc || '').slice(0, 200),
    pic: httpsPic(d.pic),
    author: clean(d.owner?.name || ''),
    duration: durOf(d.duration),
    url: `https://www.bilibili.com/video/${d.bvid || bvid}`,
  };
}
/**
 * 把封面图上传到 QQ 平台（官方 20261021「素材管理」），返回 qqbot-media:// 引用。
 *
 * 为什么需要它：卡片里的 pic_url 如果是 B 站图床外链（i0.hdslb.com），QQ 侧抓图会
 * 因 referer 防盗链偶发失败 ⇒ 卡片缺图 ⇒ 客户端渲染成「标题 + 链接」的纯文字样式。
 * 走平台素材（先 prepare → PUT → complete）就稳定了，而且 90 天内可反复引用。
 *
 * 失败返回空串（调用方回退用原始外链）。
 */
async function uploadCover(url, env) {
  try {
    if (!url || typeof env?.api !== 'function') return { ref: '', preview: '' };
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } });
    if (!r.ok) return { ref: '', preview: '' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 10 * 1024 * 1024) return { ref: '', preview: '' };
    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!/^image\/(png|jpeg|jpg|gif|webp)$/i.test(ct)) return { ref: '', preview: '' };
    const md5 = createHash('md5').update(buf).digest('hex');
    const sha1 = createHash('sha1').update(buf).digest('hex');
    const ext = ct.includes('png') ? '.png' : ct.includes('gif') ? '.gif' : ct.includes('webp') ? '.webp' : '.jpg';
    const name = (url.split('/').pop().split('?')[0] || 'cover').replace(/\.[a-z0-9]+$/i, '') + ext;

    const prep = await env.api('/v2/media-images/prepare', {
      method: 'POST',
      body: { file_name: name, file_size: buf.length, content_type: ct, md5, sha1 },
    });
    if (!prep?.ok) return { ref: '', preview: '' };
    const data = prep.data || {};
    const uploadId = String(data.upload_id || '');
    const presigned = String(data.presigned_url || '');
    if (!uploadId || !presigned) return { ref: '', preview: '' };

    const put = await fetch(presigned, { method: 'PUT', headers: { 'Content-Type': ct }, body: buf });
    if (!put.ok) return { ref: '', preview: '' };
    const etag = String(put.headers.get('etag') || md5).replace(/"/g, '');

    const done = await env.api('/v2/media-images/complete', {
      method: 'POST',
      body: { upload_id: uploadId, md5: etag },
    });
    if (!done?.ok) return { ref: '', preview: '' };
    const d2 = done.data || {};
    return { ref: String(d2.url || ''), preview: String(d2.preview_url || '') };
  } catch { return { ref: '', preview: '' }; }
}


export default {
  name: 'bili_share',
  description:
    'B 站视频搜索并分享成【图文卡片】：给关键词 → 搜到视频 → 取封面/标题/简介/链接 → '
    + '发一张带封面的图文卡片（官方 msg_type=8）。也可只搜不分享（action=search），或直接用 bvid 分享。',
  inputSchema: {
    action: { type: 'string', required: true, enum: ['search', 'share'], description: 'search=只搜结果给你看；share=搜到（或给了 bvid）就直接发图文卡片到当前会话' },
    keyword: { type: 'string', description: '搜索关键词；action=share 且没给 bvid 时用它搜第一条' },
    bvid: { type: 'string', description: 'B 站视频号（如 BV1LBnP6xEi5）；也可直接给视频链接，工具会抠号' },
    index: { type: 'integer', description: '搜到多条时分享第几条（1 起，默认 1）' },
    dryRun: { type: 'boolean', description: 'true=只把卡片内容打给你看，不真的发出去' },
  },
  async run(args, env) {
    const cfg = readCfg(env);
    const sessdata = String(cfg.sessdata || process.env.BILI_SESSDATA || '').trim();
    const cookie = sessdata ? `SESSDATA=${sessdata}` : '';
    const pageSize = Math.min(10, Math.max(1, Number(cfg.pageSize) || 5));

    const action = String(args?.action || 'search');
    const keyword = String(args?.keyword || '').trim();
    const rawBv = String(args?.bvid || '').trim();
    const m = rawBv.match(/BV[0-9A-Za-z]{10}/) || keyword.match(/BV[0-9A-Za-z]{10}/);
    let bvid = m ? m[0] : '';
    const index = Math.max(1, Number(args?.index) || 1);

    try {
      if (action === 'search') {
        if (!keyword) return { ok: false, msg: 'action=search 需要 keyword' };
        const list = await searchVideos(keyword, pageSize, cookie);
        if (!list.length) return { ok: true, msg: `没搜到「${keyword}」的相关视频` };
        const lines = list.map((v, i) =>
          `${i + 1}. ${v.title}\n   ${v.bvid} · ${v.author}${v.play ? ' · ' + v.play + ' 播放' : ''}${v.duration ? ' · ' + v.duration : ''}\n   ${v.desc || '(无简介)'}`).join('\n');
        return { ok: true, msg: `B 站搜到 ${list.length} 条（action=share + bvid 或 index 分享）:\n${lines}` };
      }

      if (action !== 'share') return { ok: false, msg: 'action 只能是 search / share' };
      let info;
      if (!bvid) {
        if (!keyword) return { ok: false, msg: 'action=share 需要 bvid 或 keyword' };
        const list = await searchVideos(keyword, Math.max(pageSize, index), cookie);
        if (!list.length) return { ok: false, msg: `没搜到「${keyword}」的相关视频` };
        const pick = list[Math.min(index - 1, list.length - 1)];
        bvid = pick.bvid;
        try { info = await videoDetail(bvid, cookie); } catch { info = { ...pick, url: `https://www.bilibili.com/video/${bvid}` }; }
      } else {
        info = await videoDetail(bvid, cookie);
      }

      // 封面优先转成平台素材（qqbot-media://），避免外链防盗链导致卡片缺图
      // 2026-10-29 主人定：**不用素材上传**，直接用抓到的 B 站封面外链（实测能抓到就正常显示）

      // ⚠️ 官方格式：card.type + **card.content.{...}**（少包一层 content 会被拒，实测 40011021）
      const card = {
        type: 'tuwen',
        content: {
          title: (info.title || '').slice(0, 50),
          description: (info.desc || ('UP主：' + info.author) || info.title || '').slice(0, 200),
          url: info.url,
          pic_url: info.pic,
        },
      };

      if (args?.dryRun || cfg.alwaysDryRun === true) {
        return { ok: true, msg: '【未发送】卡片内容：\n' + JSON.stringify(card, null, 2) };
      }

      if (!card.content.pic_url) return { ok: false, msg: '这条视频没有封面图，官方图文卡片要求 pic_url 必填' };

      // 优先用插件封装好的 env.card（内部走 SDK 的 extra 透传 + 失败降级 markdown）；
      // 老插件没有这个能力时，直接 HTTP 调官方接口（这条路 16:21 实测可行）。
      if (typeof env?.card === 'function') {
        const okCard = await env.card({
          title: card.content.title,
          description: card.content.description,
          url: card.content.url,
          pic_url: card.content.pic_url,
        });
        if (okCard) return { ok: true, msg: `已分享图文卡片：${card.content.title}
${card.content.url}` };
      }

      const scope = String(env?.peer?.scope || '');
      const peerId = String(env?.peer?.peerId || '');
      if (!scope || !peerId) return { ok: false, msg: '拿不到当前会话（只能在 QQ 会话里用）' };
      const path = scope === 'group' ? `/v2/groups/${peerId}/messages` : `/v2/users/${peerId}/messages`;
      const r = await env.api(path, { method: 'POST', body: { msg_type: 8, card } });
      if (r?.ok) return { ok: true, msg: `已分享图文卡片：${card.content.title}\n${card.content.url}` };

      const md = `**${card.content.title}**\n\n${card.content.description}\n\n![](${card.content.pic_url})\n\n${card.content.url}`;
      const ok2 = await env.markdown(md);
      const why = r?.err?.human || r?.err?.code || '未知';
      return {
        ok: ok2,
        msg: ok2
          ? `图文卡片没发出去（${why}），已降级用 markdown+封面发出：${card.content.title}`
          : `图文卡片与降级都失败（${why}）`,
      };
    } catch (e) {
      return { ok: false, msg: (e instanceof Error ? e.message : String(e)) };
    }
  },
};
