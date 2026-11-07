/**
 * 扒b站2.mjs —— `/扒b站 <BV号>` 扩展命令（2026-11-07 重做）
 *
 * 为什么换名：宿主对同名扩展命令也不做热替换，旧的 `/扒b站` 一直跑着最早的代码
 * （往 cwd/_bili 里 mkdir，在 system32 下直接 EPERM 报错）。
 *
 * 现在这版：
 *   · 复用 tools/bili_grab4.mjs（产出统一落 bili-tools/_out/<BV号>/）
 *   · 把 ctx.caps.appendWake 传给工具 → 走后台，立刻回话，跑完注入提醒
 *
 * 用法：
 *   /扒b站 BV号          后台抓（字幕 + 智能抽帧长图）
 *   /扒b站 BV号 16       每张长图 16 帧
 *   /扒b站 BV号 字幕     只抓字幕
 *   /扒b站 BV号 匀速     老式匀速抽帧
 *   /扒b站 BV号 等待     不后台，当场等结果（短视频想立刻看就用这个）
 *   /扒b站 cookie <值>   存 SESSDATA
 *   /扒b站 目录 / 清理
 *
 * ⚠️ 改完走 /tools-reload。
 */
import tool from '../tools/bili_grab.mjs';

const HELP = [
  '🐋 /扒b站 —— 抓字幕 + 智能抽帧拼长图（纯 cookie，不开浏览器）',
  '',
  '/扒b站 BV1xxxxxxxxx       后台抓，跑完自动提醒你（默认）',
  '/扒b站 https://b23.tv/xxx 短链/完整链接都认',
  '（直接引用一条带 B 站链接的消息，再发 /扒b站 也算）',
  '/扒b站 BV1xxxxxxxxx 16    一张长图拼 16 帧',
  '/扒b站 BV1xxxxxxxxx 字幕   只抓字幕不抽帧',
  '/扒b站 BV1xxxxxxxxx 匀速   老式匀速抽帧（每 10 秒一张）',
  '/扒b站 BV1xxxxxxxxx 等待   不后台，当场等结果',
  '/扒b站 cookie <SESSDATA>  存登录 cookie',
  '/扒b站 cookie            看有没有存 / 怎么拿',
  '/扒b站 目录 / 清理        看占用 / 清空产出',
  '',
  '产出：扩展目录下 bili-tools/_out/<BV号>/（subtitle.md、frames/sheet_NN.jpg）',
].join('\n');

export default {
  name: ['扒b站', 'bili', 'bzl'],
  description: 'B站视频字幕+智能抽帧长图（认 BV 号/链接/短链，也可直接引用消息；后台跑完自动提醒）',
  usage: '/扒b站 <BV号|链接> [帧数|字幕|匀速|等待]　｜　引用带链接的消息再发 /扒b站　｜　/扒b站 cookie <SESSDATA>',
  async handler(ctx) {
    let raw = String(ctx?.command?.raw ?? '').trim();

    // ★ 没带参数就去看「被引用的那条消息」：里面有 BV 号或链接就直接用
    //   （跟 /查图 同一个思路：引用消息挂在 ctx.state.quote）
    if (!raw || !/BV[0-9A-Za-z]{10}|https?:\/\//i.test(raw)) {
      const quote = ctx?.state?.quote || null;
      const text = String(quote?.text || quote?.rawContent || quote?.content || '');
      const m = text.match(/(BV[0-9A-Za-z]{10}|https?:\/\/[^\s<>"'）)]+)/i);
      if (m) raw = m[1];
    }

    if (!raw || /^(help|帮助|\?)$/i.test(raw)) return HELP;

    if (/^(目录|info|ls|占用)$/i.test(raw)) {
      const r = await tool.run({ action: 'info' });
      return String(r?.msg || '').slice(0, 1800);
    }
    if (/^(清理|clear|clean|清空)$/i.test(raw)) {
      const r = await tool.run({ action: 'clear' });
      return String(r?.msg || '').slice(0, 800);
    }

    const m = /^cookie(?:\s+([\s\S]+))?$/i.exec(raw);
    if (m) {
      const val = (m[1] || '').trim();
      if (!val) {
        const s = await tool.run({ action: 'show_cookie' });
        const h = await tool.run({ action: 'cookie_help' });
        return [s.msg, '', h.msg].join('\n').slice(0, 1800);
      }
      const r = await tool.run({ action: 'set_cookie', cookie: val });
      return r.msg;
    }

    const parts = raw.split(/\s+/);
    const bvid = parts[0];
    let perSheet = 12;
    let onlySub = false;
    let frameMode = 'scene';
    let sync = false;
    for (const p of parts.slice(1)) {
      // 链接后面若还带着 ?share_source=… 之类，先剥干净
      if (/^https?:\/\//i.test(p)) continue;
      if (/^\d+$/.test(p)) perSheet = Math.max(2, Math.min(24, Number(p)));
      else if (/^(字幕|sub|s)$/i.test(p)) onlySub = true;
      else if (/^(匀速|interval|平均)$/i.test(p)) frameMode = 'interval';
      else if (/^(智能|scene)$/i.test(p)) frameMode = 'scene';
      else if (/^(等待|等|sync|同步)$/i.test(p)) sync = true;
    }

    // appendWake 从命令能力包里拿（跟 /唤醒 同一条路）→ 工具走后台模式
    const caps = ctx?.caps ?? ctx ?? {};
    const appendWake = caps.appendWake ?? ctx?.appendWake;
    const env = typeof appendWake === 'function' ? { appendWake } : undefined;

    const r = await tool.run(
      {
        action: 'grab',
        bvid,
        frameMode,
        perSheet,
        subtitle: true,
        frames: !onlySub,
        maxFrames: 8,
        sync,
      },
      env,
    );
    return String(r?.msg || '抓取没返回内容').slice(0, 1800);
  },
};
