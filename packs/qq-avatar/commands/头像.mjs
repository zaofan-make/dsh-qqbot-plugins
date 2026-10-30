/**
 * 头像.mjs —— 斜杠命令 /头像 [名字或openid]
 *
 * 2026-10-30 主人需求：
 *   「不带参数 → 静默注入一条模拟用户消息，把发命令的人的头像下载到存储目录，
 *     并注入 xx（有名称优先显示名称）的头像已下载到，文件名 xxxx」
 *   「带参数 → 搜索下载对应的群友或 openid 的头像」
 *
 * ── 注入与"静默"都照现有实现来（别造轮子）────────────────────────
 *   · 静默注入：`caps.appendSilent(text)` —— 能力包里的静默追加（session.append('user/message')，
 *     过 canSilentlyAppend 守卫，不唤醒、不额外烧 token）。同 commands/唤醒.mjs 的取法。
 *   · 不回复：**handler 返回 undefined / null 时 sendCmdResult 直接 return**
 *     （middleware-setup.ts:397 `if (result === undefined || result === null) return;`）
 *     ⇒ 命令执行完什么也不发，这才叫"静默"。
 *   · 兜底：appendSilent 不可用时返回 `{ wake: { content, senderName } }`，
 *     交给聚合层 injectSynthetic（与真人消息同窗口聚合，见 middleware-setup.ts:584）。
 *
 * ⚠️ 命令改动后 `tools_reload` 热刷；个别情况需重启宿主。
 */
import { downloadAvatar, resolveWho } from '../lib/avatar.mjs';

export default {
  name: ['头像', 'avatar', 'touxiang'],
  description: '下载群友头像: /头像 存自己的；/头像 昵称或openid 存对方的',
  usage: '/头像 [群昵称片段 | 32位openid]',

  async handler(ctx) {
    const caps = ctx?.caps ?? ctx ?? {};
    const appId = String(caps.appId || '').trim();
    const dataRoot = String(caps.dataRoot || '').trim();
    if (!appId) return '拿不到 appId，这个命令只能在 QQ 会话里用。';

    const raw = String(ctx?.command?.raw ?? '').trim();
    const whoArg = raw.replace(/^\/?\s*(头像|avatar|touxiang)\s*/i, '').trim();

    // 目标：不带参数 = 发命令的人（命令 ctx 原生有 message.senderId，能力包里有 user）
    let openid = '';
    let name = '';
    if (!whoArg) {
      openid = String(ctx?.message?.senderId || caps.user?.openid || '').trim();
      name = String(ctx?.message?.senderName || caps.user?.name || '').trim();
      if (!openid) return '拿不到你的 openid，没法取头像。';
    } else {
      const hit = resolveWho(dataRoot, whoArg);
      if (hit.error) return hit.error;
      openid = hit.openid;
      name = hit.name;
    }

    const r = await downloadAvatar({ appId, dataRoot, openid, name });
    if (!r.ok) return `头像下载失败：${r.error}`;

    const label = name || openid.slice(0, 8);

    // 把图**发到当前会话**（命令正在处理用户消息 ⇒ replyTarget 带 msgId，天然是被动回复，
    // 优先被动消息；窗口过期时 sendMedia 会按插件既有逻辑降级/失败，不额外处理）
    let sent = false;
    const sendImg = caps.image ?? ctx?.image;
    if (typeof sendImg === 'function') {
      try {
        const ok = await sendImg(r.path);
        sent = ok !== false;
      } catch { /* 发图失败不影响下载结果 */ }
    }

    const note = `${label} 的头像已下载到 ${r.path}，文件名 ${r.file}${sent ? '（已发到当前会话）' : ''}`;

    // ── 静默注入（必须真静默）──────────────────────────────────────
    // `caps.appendSilent` = session.append('user/message') + surface 守卫，**不唤醒**。
    // ⚠️ 千万不要兜底到 `{ wake: {...} }`：那条路走聚合层 injectSynthetic，会在上下文里
    //    渲染成 `[做早饭 ()] ... (@you)` 并**开一个新回合唤醒 AI**（2026-10-30 实测踩到）。
    //    宁可注入失败也不能吵醒它 —— 图已经发出来了，信息本身不丢。
    const appendSilent = caps.appendSilent;
    if (typeof appendSilent === 'function') {
      try { await appendSilent(note); } catch { /* 静默失败：不兜底、不唤醒 */ }
    }
    return undefined;
  },
};
