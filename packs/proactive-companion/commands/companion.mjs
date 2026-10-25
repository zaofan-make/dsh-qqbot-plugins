/**
 * companion.mjs — 主动陪伴与私聊智能关怀管理斜杠命令
 *
 * 用法：
 *   /companion                    — 查看当前状态与今日冒泡统计（双路线并行面板）
 *   /companion on / off           — 启用或停用主动关怀总开关
 *   /companion test               — 手动触发一次主动关怀演练
 *   /companion set idle 3         — 设置空闲多少小时触发关怀（默认 3 小时）
 *   /companion set window on/off  — 开启或关闭作息时段关怀路线
 *   /companion set poke on/off    — 开启或关闭空闲超时冒泡路线
 *   /companion set max 4          — 设置每天最多关怀次数（默认 4 次）
 *   /companion set interval 2.5   — 设置两次关怀最小间隔小时数
 *   /companion set dnd 23:30 08:30 — 设置夜间免打扰时段
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 嗅探最近一次私聊的 OpenID
function detectLatestC2COpenid(env) {
  try {
    const root = env?.dataRoot || join(process.cwd(), 'dshqqbot');
    const knownFile = join(root, '表情包', 'known-chats.jsonl');
    if (existsSync(knownFile)) {
      const lines = readFileSync(knownFile, 'utf8').trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const item = JSON.parse(lines[i]);
          if (item.scope === 'c2c' && item.id) return item.id;
        } catch {}
      }
    }
  } catch {}
  return '';
}

function formatHours(ms) {
  if (ms <= 0) return '0 小时';
  const h = (ms / (3600 * 1000)).toFixed(1);
  return `${h} 小时`;
}

export default {
  name: ['companion', '关怀', '主动陪伴'],
  description: '查看或管理私聊主动陪伴与关怀双驱动策略（作息问候 + 空闲冒泡）',
  usage: '/companion [status|on|off|test|set <key> <val>]',
  handler: async (ctx) => {
    const raw = (ctx.args || ctx.rawArgs || '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const sub = (parts[0] || 'status').toLowerCase();

    // 读写存储
    const store = ctx.store;
    let state = {};
    try {
      if (store && typeof store.load === 'function') {
        state = (await store.load()) || {};
      }
    } catch {
      state = {};
    }

    // 同时读取 ext-config 覆盖项
    try {
      const extCfgPath = join(process.cwd(), '.qqbot-extensions', '.state', 'ext-config', 'companion-daemon.json');
      if (existsSync(extCfgPath)) {
        const cfg = JSON.parse(readFileSync(extCfgPath, 'utf8'));
        if (cfg && typeof cfg === 'object') {
          state = { ...state, ...cfg };
        }
      }
    } catch {}

    const conf = {
      enabled: state.enabled ?? true,
      targetOpenid: state.targetOpenid || detectLatestC2COpenid(ctx.env),
      dailyMax: state.dailyMax ?? 5,
      minIntervalHours: state.minIntervalHours ?? 2.5,
      dndStart: state.dndStart || '23:30',
      dndEnd: state.dndEnd || '08:30',

      windowGreetingEnabled: state.windowGreetingEnabled ?? true,
      morningEnabled: state.morningEnabled ?? true,
      morningStart: state.morningStart || '08:30',
      morningEnd: state.morningEnd || '09:30',

      afternoonEnabled: state.afternoonEnabled ?? false,
      afternoonStart: state.afternoonStart || '14:00',
      afternoonEnd: state.afternoonEnd || '14:30',

      eveningEnabled: state.eveningEnabled ?? false,
      eveningStart: state.eveningStart || '18:30',
      eveningEnd: state.eveningEnd || '19:30',

      nightEnabled: state.nightEnabled ?? true,
      nightStart: state.nightStart || '22:30',
      nightEnd: state.nightEnd || '23:30',

      idlePokeEnabled: state.idlePokeEnabled ?? true,
      idleHoursThreshold: state.idleHoursThreshold ?? 3,

      lastBubbleTs: state.lastBubbleTs ?? 0,
      consecutiveBubblesWithoutReply: state.consecutiveBubblesWithoutReply ?? 0,
      dailyDate: state.dailyDate || '',
      dailyCount: state.dailyCount ?? 0,
      greetedWindowsToday: Array.isArray(state.greetedWindowsToday) ? state.greetedWindowsToday : [],
      lastInteractionTs: state.lastInteractionTs ?? 0,
      ...state
    };

    async function save() {
      if (store && typeof store.save === 'function') {
        await store.save(conf);
      }
    }

    if (sub === 'on') {
      conf.enabled = true;
      conf.consecutiveBubblesWithoutReply = 0;
      await save();
      return '【主动陪伴】已开启。将在私聊空闲与关键作息节点适时主动向你问候关怀~';
    }

    if (sub === 'off') {
      conf.enabled = false;
      await save();
      return '【主动陪伴】已停用。机器人将不再在私聊中主动冒泡发消息。';
    }

    if (sub === 'test') {
      const wakeText = `【系统主动关怀演练测试】
当前时间为 ${new Date().toLocaleTimeString('zh-CN')}。
请以你一贯的语气性格（软萌、自然、对主人微粘可爱的澜澜形象），在私聊中主动向墨旅发出一句问候或分享日常，并带一张表情包。`;

      let triggered = false;
      if (typeof ctx.appendWake === 'function') {
        try {
          await ctx.appendWake(wakeText);
          triggered = true;
        } catch {
          triggered = false;
        }
      }
      if (!triggered && typeof ctx.text === 'function') {
        await ctx.text(conf.targetOpenid, '悄悄戳一下墨旅~ 主动陪伴演练测试成功啦！随时都在呢~', { scope: 'c2c' });
        triggered = true;
      }
      return triggered
        ? '【主动陪伴】演练触发成功！已向私聊通道发送主动问候。'
        : '【主动陪伴】演练失败：当前环境缺少唤醒或发送通道。';
    }

    if (sub === 'set') {
      const key = (parts[1] || '').toLowerCase();
      const val = parts[2];
      if (!key || val == null) {
        return '用法说明：\n/companion set idle <小时数, 如 3>\n/companion set window <on|off>\n/companion set poke <on|off>\n/companion set max <每天最大次数>\n/companion set interval <最小冷却小时数>\n/companion set dnd <HH:mm> <HH:mm>';
      }

      if (key === 'idle') {
        const num = parseFloat(val);
        if (isNaN(num) || num <= 0) return '错误：idle 小时数必须为正数';
        conf.idleHoursThreshold = num;
        await save();
        return `【主动陪伴】已将空闲超时触发时间设为 ${num} 小时。`;
      }

      if (key === 'window') {
        const on = val.toLowerCase() === 'on' || val === '1' || val === 'true';
        conf.windowGreetingEnabled = on;
        await save();
        return `【主动陪伴】作息时段关怀路线已${on ? '开启' : '关闭'}。`;
      }

      if (key === 'poke') {
        const on = val.toLowerCase() === 'on' || val === '1' || val === 'true';
        conf.idlePokeEnabled = on;
        await save();
        return `【主动陪伴】空闲超时主动冒泡路线已${on ? '开启' : '关闭'}。`;
      }

      if (key === 'max') {
        const num = parseInt(val, 10);
        if (isNaN(num) || num <= 0) return '错误：每天最大关怀次数必须为正整数';
        conf.dailyMax = num;
        await save();
        return `【主动陪伴】已将每日最大关怀次数上限设为 ${num} 次。`;
      }

      if (key === 'interval') {
        const num = parseFloat(val);
        if (isNaN(num) || num <= 0) return '错误：最小间隔必须为正数';
        conf.minIntervalHours = num;
        await save();
        return `【主动陪伴】已将两次关怀的最小间隔设为 ${num} 小时。`;
      }

      if (key === 'dnd') {
        const end = parts[3];
        if (!val.includes(':') || !end || !end.includes(':')) {
          return '错误：免打扰格式应为 /companion set dnd 23:30 08:30';
        }
        conf.dndStart = val;
        conf.dndEnd = end;
        await save();
        return `【主动陪伴】免打扰时段已更新为 ${val} ~ ${end}。`;
      }

      return `未知设置项: ${key}`;
    }

    // 默认 status: 输出详细双驱动面板
    const now = Date.now();
    const idleDurationMs = conf.lastInteractionTs ? (now - conf.lastInteractionTs) : 0;
    const greeted = conf.greetedWindowsToday || [];

    const lines = [
      `🌟 【主动陪伴与私聊关怀状态】`,
      `总开关：${conf.enabled ? '🟢 已启用' : '🔴 已停用'}`,
      `目标主人：${conf.targetOpenid}`,
      ``,
      `⏰ 【路线一：作息时段关怀】${conf.windowGreetingEnabled ? '🟢 开启' : '⚪ 关闭'}`,
      `  • 早安问候：${conf.morningEnabled ? '已开' : '已关'} (${conf.morningStart}~${conf.morningEnd}) ${greeted.includes('morning') ? '✅今日已问候' : '⏳未触发'}`,
      `  • 午后提神：${conf.afternoonEnabled ? '已开' : '已关'} (${conf.afternoonStart}~${conf.afternoonEnd}) ${greeted.includes('afternoon') ? '✅今日已问候' : '⏳未触发'}`,
      `  • 傍晚提醒：${conf.eveningEnabled ? '已开' : '已关'} (${conf.eveningStart}~${conf.eveningEnd}) ${greeted.includes('evening') ? '✅今日已问候' : '⏳未触发'}`,
      `  • 晚安陪伴：${conf.nightEnabled ? '已开' : '已关'} (${conf.nightStart}~${conf.nightEnd}) ${greeted.includes('night') ? '✅今日已问候' : '⏳未触发'}`,
      ``,
      `💬 【路线二：空闲超时冒泡】${conf.idlePokeEnabled ? '🟢 开启' : '⚪ 关闭'}`,
      `  • 设定阈值：连续空闲满 ${conf.idleHoursThreshold} 小时主动搭话`,
      `  • 当前空闲时长：${formatHours(idleDurationMs)}`,
      ``,
      `🛡️ 【频控与免打扰保护】`,
      `  • 今日已关怀次数：${conf.dailyCount} / ${conf.dailyMax}`,
      `  • 两次关怀最小冷却：${conf.minIntervalHours} 小时`,
      `  • 夜间免打扰时段：${conf.dndStart} ~ ${conf.dndEnd}`,
      `  • 连续无应答次数：${conf.consecutiveBubblesWithoutReply}${conf.consecutiveBubblesWithoutReply >= 2 ? ' (💤已触发休眠熔断)' : ''}`,
      ``,
      `💡 提示：支持在 DSH「设置中心」中可视化调节各时段开关与时间，或使用 /companion set 指令。`
    ];

    return lines.join('\n');
  }
};
