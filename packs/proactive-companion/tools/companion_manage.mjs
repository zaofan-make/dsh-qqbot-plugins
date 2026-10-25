/**
 * companion_manage.mjs — 主动陪伴策略管理工具（LLM Tool）
 *
 * 允许模型根据与主人的对话意图，动态查询或调整主动陪伴策略
 * （例如当主人说“接下来几个小时我要专心开会别打扰我”时自动触发暂缓关怀）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 动态嗅探最近一次私聊的 OpenID
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

export default {
  name: 'companion_manage',
  description: '查询或调整 QQ 私聊主动关怀与陪伴策略（如总开关、作息时段关怀开关、空闲超时冒泡开关、空闲小时数、免打扰等）',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'enable', 'disable', 'mute_today', 'set_idle_hours', 'set_route', 'trigger_now'],
        description: '操作类型：get(查询状态), enable(开启总开关), disable(关闭总开关), mute_today(今日不再主动打扰), set_idle_hours(设置空闲小时数), set_route(开关指定路线), trigger_now(立即演练一次关怀)'
      },
      idle_hours: {
        type: 'number',
        description: '当 action=set_idle_hours 时指定的小时数（例如 3 或 4）'
      },
      route_name: {
        type: 'string',
        enum: ['window', 'poke'],
        description: '当 action=set_route 时指定的路线：window(时段问候), poke(空闲冒泡)'
      },
      route_enabled: {
        type: 'boolean',
        description: '当 action=set_route 时指定的目标开启状态(true/false)'
      },
      reason: {
        type: 'string',
        description: '调整原因或主人的意图说明（供记录）'
      }
    },
    required: ['action']
  },
  expose: 'all',
  handler: async (args, ctx) => {
    const store = ctx?.store;
    let state = {};
    try {
      if (store && typeof store.load === 'function') {
        state = (await store.load()) || {};
      }
    } catch {
      state = {};
    }

    const conf = {
      enabled: state.enabled ?? true,
      targetOpenid: state.targetOpenid || detectLatestC2COpenid(ctx?.env),
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

    const action = args.action;

    if (action === 'get') {
      return {
        enabled: conf.enabled,
        targetOpenid: conf.targetOpenid,
        routes: {
          windowGreeting: {
            enabled: conf.windowGreetingEnabled,
            morning: `${conf.morningStart}~${conf.morningEnd} (${conf.morningEnabled ? 'on' : 'off'})`,
            afternoon: `${conf.afternoonStart}~${conf.afternoonEnd} (${conf.afternoonEnabled ? 'on' : 'off'})`,
            evening: `${conf.eveningStart}~${conf.eveningEnd} (${conf.eveningEnabled ? 'on' : 'off'})`,
            night: `${conf.nightStart}~${conf.nightEnd} (${conf.nightEnabled ? 'on' : 'off'})`,
            greetedToday: conf.greetedWindowsToday
          },
          idlePoke: {
            enabled: conf.idlePokeEnabled,
            idleHoursThreshold: conf.idleHoursThreshold
          }
        },
        dndWindow: `${conf.dndStart} ~ ${conf.dndEnd}`,
        dailyCount: conf.dailyCount,
        dailyMax: conf.dailyMax,
        minIntervalHours: conf.minIntervalHours,
        consecutiveBubblesWithoutReply: conf.consecutiveBubblesWithoutReply,
        isMutedToday: conf.dailyCount >= conf.dailyMax
      };
    }

    if (action === 'enable') {
      conf.enabled = true;
      conf.consecutiveBubblesWithoutReply = 0;
      await save();
      return { ok: true, message: '已开启主动陪伴与私聊关怀总开关' };
    }

    if (action === 'disable') {
      conf.enabled = false;
      await save();
      return { ok: true, message: '已停用主动陪伴总开关' };
    }

    if (action === 'set_route') {
      if (args.route_name === 'window') {
        conf.windowGreetingEnabled = !!args.route_enabled;
        await save();
        return { ok: true, message: `作息时段关怀路线已${conf.windowGreetingEnabled ? '开启' : '关闭'}` };
      }
      if (args.route_name === 'poke') {
        conf.idlePokeEnabled = !!args.route_enabled;
        await save();
        return { ok: true, message: `空闲超时冒泡路线已${conf.idlePokeEnabled ? '开启' : '关闭'}` };
      }
      return { ok: false, error: '请指定 route_name (window 或 poke)' };
    }

    if (action === 'mute_today') {
      conf.dailyCount = conf.dailyMax;
      await save();
      return { ok: true, message: '已将今日主动关怀额度置满，今天内将保持安静不主动打扰' };
    }

    if (action === 'set_idle_hours') {
      const val = Number(args.idle_hours);
      if (!val || isNaN(val) || val < 0.5) {
        return { ok: false, error: 'idle_hours 必须是 >= 0.5 的有效数字' };
      }
      conf.idleHoursThreshold = val;
      await save();
      return { ok: true, message: `空闲关怀间隔已设置为 ${val} 小时` };
    }

    if (action === 'trigger_now') {
      const wakePrompt = `【系统主动关怀演练测试】\n请以软萌、自然的澜澜语气向墨旅发送一句主动私聊问候，并附带一张表情包。`;
      if (typeof ctx?.appendWake === 'function') {
        await ctx.appendWake(wakePrompt);
      } else if (typeof ctx?.text === 'function') {
        await ctx.text(conf.targetOpenid, '悄悄戳一下墨旅~ 主动陪伴演练成功！', { scope: 'c2c' });
      }
      return { ok: true, message: '已触发即时关怀测试' };
    }

    return { ok: false, error: `不支持的 action: ${action}` };
  }
};
