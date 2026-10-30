/**
 * qq_avatar.mjs —— 群友头像下载工具（AI 可调）
 *
 * 拼法出处：QQ 互联 get_user_info 的 figureurl_qq_1/_2
 *   `http://q.qlogo.cn/qqapp/{appId}/{openid}/{40|100}`
 *   2018-02-11 域名迁移 → `https://thirdqq.qlogo.cn/qqapp/...`（结构不变，免鉴权）
 *   文档只列 40/100，实测 640（最大）也可用。
 *
 * 名字反查走插件已有的群成员台账（`{dataRoot}/表情包/group-members.jsonl`，
 * 就是 id_lookup 用的同一份数据源）—— 没有现成 API，直接读文件。
 *
 * 契约：export default { name, description, inputSchema, run(args, env) } → { ok, msg }
 */
import { downloadAvatar, resolveWho } from '../lib/avatar.mjs';

export default {
  name: 'qq_avatar',
  description:
    '下载群友头像到扩展目录（QQ 互联 qqapp 直链，免鉴权）。'
    + 'who 可传 openid（32 位）或群昵称（模糊匹配台账）；不传=当前说话的人。'
    + '返回保存后的文件路径与文件名。',
  inputSchema: {
    who: { type: 'string', description: '群昵称片段，或 32 位 openid；不填=当前说话的人' },
  },
  async run(args, env) {
    const appId = String(env?.appId || '').trim();
    const dataRoot = String(env?.dataRoot || '').trim();
    if (!appId) return { ok: false, msg: '拿不到 appId（这个能力只能在 QQ 会话里用）' };

    const who = String(args?.who || '').trim();
    let openid = '';
    let name = '';

    if (!who) {
      // 不传 → 当前发言者
      openid = String(env?.user?.openid || env?.actorOpenid || '').trim();
      name = String(env?.user?.name || '').trim();
      if (!openid) return { ok: false, msg: '拿不到当前发言者的 openid' };
    } else {
      const hit = resolveWho(dataRoot, who);
      if (hit.error) return { ok: false, msg: hit.error };
      openid = hit.openid;
      name = hit.name;
    }

    const r = await downloadAvatar({ appId, dataRoot, openid, name });
    if (!r.ok) return { ok: false, msg: `头像下载失败：${r.error}` };

    // 顺手把图发到当前会话（工具在回合内执行 ⇒ replyTarget 带 msgId，走被动回复通道）
    let sent = false;
    if (typeof env?.image === 'function') {
      try {
        const ok = await env.image(r.path);
        sent = ok !== false;
      } catch { /* 发图失败不影响下载 */ }
    }

    return {
      ok: true,
      msg: `${name || openid.slice(0, 8)} 的头像已下载到 ${r.path}（文件名 ${r.file}，${Math.round((r.bytes || 0) / 1024)}KB）${sent ? '，并已发到当前会话' : '（发图未成功）'}`,
    };
  },
};
