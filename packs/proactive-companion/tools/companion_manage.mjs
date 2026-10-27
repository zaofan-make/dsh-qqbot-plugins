import { isOwnerContext, normalizeConfig, readExtConfig, redactOpenid, resolveTargetOpenid, writeExtConfig } from '../lib/config.mjs';
import { checkCompanion, localDate } from '../hooks/companion-daemon.mjs';

export default {
  name: 'companion_manage',
  description: '查询或调整 QQ 私聊主动关怀策略',
  inputSchema: {
    action: { type: 'string', enum: ['get', 'enable', 'disable', 'mute_today', 'set_idle_hours', 'set_idle_minutes', 'set_route', 'trigger_now'], description: '操作类型' },
    idle_hours: { type: 'number', description: '空闲小时数，>= 0；0 表示使用分钟阈值' },
    idle_minutes: { type: 'number', description: '空闲分钟数，必须 > 0；设置后切换为分钟模式，默认 30 分钟' },
    route_name: { type: 'string', enum: ['window', 'poke'], description: '路线名称' },
    route_enabled: { type: 'boolean', description: '路线是否开启' },
    reason: { type: 'string', description: '调整原因' },
  },
  run: async (args = {}, ctx = {}) => {
    try {
      const result = await manage(args, ctx);
      return { ...result, ok: result.ok !== false, msg: result.message || result.error || JSON.stringify(result) };
    } catch (error) {
      return { ok: false, msg: '陪伴操作失败，请检查扩展配置和宿主日志', error: String(error?.code || 'COMPANION_OPERATION_FAILED') };
    }
  },
};

async function manage(args, ctx) {
    if (!isOwnerContext(ctx)) return { ok: false, error: '仅主人可以查看或修改陪伴设置' };
    const env = ctx?.env || ctx;
    const store = ctx?.store;
    let runtime = {};
    try { runtime = (store && typeof store.load === 'function' && await store.load()) || {}; } catch {}
    const ext = readExtConfig(env);
    const conf = normalizeConfig({ ...runtime, ...ext, targetOpenid: resolveTargetOpenid(env, runtime, ext) });
    const today = localDate();
    if (conf.dailyDate !== today) {
      conf.dailyDate = today;
      conf.dailyCount = 0;
      conf.greetedWindowsToday = [];
    }
    const save = () => writeExtConfig(env, conf);
    const action = String(args.action || '').trim();

    if (action === 'get') {
      return {
        enabled: conf.enabled, targetOpenid: redactOpenid(conf.targetOpenid),
        dailyMax: conf.dailyMax, dailyMaxText: conf.dailyMax === 0 ? '无上限' : `${conf.dailyMax} 次`,
        maxUnanswered: conf.maxUnanswered,
        dailyCount: conf.dailyCount, minIntervalHours: conf.minIntervalHours,
        idleHoursThreshold: conf.idleHoursThreshold, idleMinutesThreshold: conf.idleMinutesThreshold,
        idleThresholdText: conf.idleHoursThreshold === 0 ? `${conf.idleMinutesThreshold} 分钟` : `${conf.idleHoursThreshold} 小时`,
        routes: { window: conf.windowGreetingEnabled, poke: conf.idlePokeEnabled },
        dndWindow: `${conf.dndStart} ~ ${conf.dndEnd}`, mutedDate: conf.mutedDate || '',
        isMutedToday: conf.mutedDate === today,
        isDailyLimitReached: conf.dailyMax > 0 && conf.dailyCount >= conf.dailyMax,
        lastCheckReason: conf.lastCheckReason || '', lastSendError: conf.lastSendError || '',
      };
    }
    if (action === 'enable' || action === 'disable') {
      conf.enabled = action === 'enable';
      if (conf.enabled) conf.consecutiveBubblesWithoutReply = 0;
      save();
      return { ok: true, message: conf.enabled ? '已开启主动陪伴与私聊关怀总开关' : '已停用主动陪伴总开关' };
    }
    if (action === 'mute_today') {
      conf.mutedDate = today;
      save();
      return { ok: true, message: '今天内将保持安静不主动打扰' };
    }
    if (action === 'set_route') {
      if (!['window', 'poke'].includes(args.route_name) || typeof args.route_enabled !== 'boolean') return { ok: false, error: '请同时指定 route_name 和布尔值 route_enabled' };
      conf[args.route_name === 'window' ? 'windowGreetingEnabled' : 'idlePokeEnabled'] = args.route_enabled;
      save();
      return { ok: true, message: `${args.route_name === 'window' ? '作息时段' : '空闲冒泡'}路线已${args.route_enabled ? '开启' : '关闭'}` };
    }
    if (action === 'set_idle_hours') {
      const val = args.idle_hours;
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return { ok: false, error: 'idle_hours 必须是 >= 0 的有效数字；0 使用分钟阈值' };
      conf.idleHoursThreshold = val;
      save();
      return { ok: true, message: val === 0 ? `空闲关怀已切换为分钟模式：${conf.idleMinutesThreshold} 分钟` : `空闲关怀间隔已设置为 ${val} 小时` };
    }
    if (action === 'set_idle_minutes') {
      const val = args.idle_minutes;
      if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return { ok: false, error: 'idle_minutes 必须是 > 0 的有效数字' };
      conf.idleHoursThreshold = 0;
      conf.idleMinutesThreshold = val;
      save();
      return { ok: true, message: `空闲关怀间隔已设置为 ${val} 分钟` };
    }
    if (action === 'trigger_now') {
      const result = await checkCompanion({ ...ctx, ...env }, { manual: true });
      return { ok: result.accepted, ...result, message: result.accepted ? '已接纳原私聊会话唤醒，尚非 QQ 送达确认' : '关怀未触发' };
    }
    return { ok: false, error: `不支持的 action: ${action}` };
}
