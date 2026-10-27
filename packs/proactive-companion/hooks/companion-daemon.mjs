/**
 * companion-daemon.mjs — 主动陪伴与私聊智能关怀巡检守护进程
 *
 * 核心机制（双驱动并行）：
 * 1. 路线一【作息时段关怀（Window Greeting）】：
 *    - 早安问候 (默认开启，08:30 ~ 09:30)
 *    - 午后提神 (默认关闭，14:00 ~ 14:30，可按需在设置中开启)
 *    - 傍晚提醒 (默认关闭，18:30 ~ 19:30，可按需在设置中开启)
 *    - 晚安陪伴 (默认开启，22:30 ~ 23:30)
 *    - 各窗口支持在设置面板独立开启/关闭、时段自定义；每个窗口当天最多触发 1 次。
 * 2. 路线二【空闲超时冒泡（Idle Poke）】：
 *    - 距离上次私聊对话超过设定阈值（默认 3 小时）且当前处于活跃时段时，主动戳一下主人。
 *    - 支持在设置面板独立开启/关闭、修改超时小时数。
 * 3. 频控与多层防打扰机制：
 *    - 夜间免打扰（DND）：默认 23:30 ~ 08:30 绝对静默；
 *    - 每日频控上限：每天最多主动发起 5 次（路线一与二共享总配额，早晚各 1 次，其余留给白天空闲冒泡）；
 *    - 冷却退避机制：两次主动发起间至少冷却 2.5 小时；
 *    - 连续未回复退避：若连续发了主动问候而主人未曾回复，下次等待时间加长；连续 2 次无回复自动休眠，绝不连环轰炸。
 * 4. 智能驱动：
 *    - 唤醒目标原私聊会话，由原会话模型生成人设与上下文一致的关怀；
 *    - 会话不可用时报告原因，不回退到固定话术；接纳唤醒不等于 QQ 已送达。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConfig, pickConfig, readExtConfig, resolveTargetOpenid, safeOpenid, writeExtConfig } from '../lib/config.mjs';
import { requestCompanionCare, withCompanionLock } from '../lib/session.mjs';

/**
 * 声明设置面板（在「QQ机器人扩展」-「设置中心」中直接渲染可视化配置表单）
 */
export const qqbotSettingsPage = {
  title: '主动陪伴关怀设置',
  desc: '配置机器人在私聊中主动关怀主人的双驱动并行策略（时段问候 + 空闲超时冒泡）与防打扰规则。',
  schema: [
    // 全局基础配置
    { key: 'enabled', type: 'bool', label: '启用主动关怀总开关', default: true, hint: '总开关：关闭后将停止一切主动问候与冒泡' },
    { key: 'targetOpenid', type: 'string', label: '主人 OpenID', default: '', hint: '接收主动关怀的目标私聊 OpenID（留空时仅回退到宿主提供的主人列表；支持在私聊中输入 /openid 自动填入）' },
    { key: 'maxUnanswered', type: 'number', label: '连续无应答休眠上限', default: 3, hint: '连续主动关怀达到该次数且未收到对方回复时自动休眠（路线一与路线二共享计数，默认 3 次）；0 表示不休眠' },
    { key: 'dailyMax', type: 'number', label: '每天最大关怀次数', default: 5, hint: '两条路线共享每日额度（默认 5 次）；0 表示不限每日次数，仍遵守免打扰、冷却和未回复保护'  },
    { key: 'minIntervalHours', type: 'number', label: '两次关怀最小间隔(小时)', default: 0.5, hint: '两次主动发送之间的最小冷却时间（默认 0.5 小时）；0 表示关闭冷却，仍遵守其他保护规则' },
    { key: 'dndStart', type: 'string', label: '免打扰开始时间', default: '23:30', hint: '夜间免打扰起始（24小时制 HH:mm）' },
    { key: 'dndEnd', type: 'string', label: '免打扰结束时间', default: '08:30', hint: '早晨免打扰结束（24小时制 HH:mm）' },

    // 路线一：作息时段定时问候
    { key: 'windowGreetingEnabled', type: 'bool', label: '【路线一】开启作息时段关怀', default: true, hint: '在早安、晚安等关键时间窗口主动问候（每个窗口当天最多触发 1 次）' },
    { key: 'morningEnabled', type: 'bool', label: '└─ 开启早安问候', default: true },
    { key: 'morningStart', type: 'string', label: '└─ 早安开始时间', default: '08:30' },
    { key: 'morningEnd', type: 'string', label: '└─ 早安结束时间', default: '09:30' },

    { key: 'afternoonEnabled', type: 'bool', label: '└─ 开启午后提神', default: false, hint: '默认关闭，按需开启' },
    { key: 'afternoonStart', type: 'string', label: '└─ 午后开始时间', default: '14:00' },
    { key: 'afternoonEnd', type: 'string', label: '└─ 午后结束时间', default: '14:30' },

    { key: 'eveningEnabled', type: 'bool', label: '└─ 开启傍晚提醒', default: false, hint: '默认关闭，按需开启' },
    { key: 'eveningStart', type: 'string', label: '└─ 傍晚开始时间', default: '18:30' },
    { key: 'eveningEnd', type: 'string', label: '└─ 傍晚结束时间', default: '19:30' },

    { key: 'nightEnabled', type: 'bool', label: '└─ 开启晚安陪伴', default: true },
    { key: 'nightStart', type: 'string', label: '└─ 晚安开始时间', default: '22:30' },
    { key: 'nightEnd', type: 'string', label: '└─ 晚安结束时间', default: '23:30' },

    // 路线二：空闲超时主动冒泡
    { key: 'idlePokeEnabled', type: 'bool', label: '【路线二】开启空闲超时主动冒泡', default: true, hint: '当主人较长时间未发消息时，主动戳一下主人' },
    { key: 'idleHoursThreshold', type: 'number', label: '└─ 空闲超时阈值(小时)', default: 1, hint: '默认 1 小时；大于 0 使用小时阈值，设为 0 使用下方分钟阈值'  },
    { key: 'idleMinutesThreshold', type: 'number', label: '└─ 空闲超时阈值(分钟)', default: 30, hint: '仅小时为 0 时生效；最少 1 分钟' },
  ],
};



const runtimeFields = ['lastBubbleTs','lastInteractionTs','consecutiveBubblesWithoutReply','dailyDate','dailyCount','greetedWindowsToday','lastCheckTs','lastCheckReason','lastSendError'];
export function localDate(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
}
function inRange(now, start, end) {
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
function latestHistory(env, target, now) {
  const dir = join(env.dataRoot || join(process.cwd(),'dshqqbot'), '.qqbot','msg-history', 'c2c_'+target);
  let activity = 0, user = 0;
  if (!existsSync(dir)) return {activity,user};
  for (const name of readdirSync(dir).filter(n=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse().slice(0,7)) {
    for (const line of readFileSync(join(dir,name),'utf8').split(/\r?\n/)) {
      try {
        const item = JSON.parse(line);
        const ts = Number(item.t || item.ts || Date.parse(item.time));
        if (!Number.isFinite(ts) || ts <= 0 || ts > now) continue;
        activity = Math.max(activity,ts);
        if (!item.me && item.s === target) user = Math.max(user,ts);
      } catch {}
    }
    if (user) break;
  }
  return {activity,user};
}
// Export the actual timer callback so regression tests exercise production logic.
export function checkCompanion(env, options = {}) {
  return withCompanionLock(env, () => inspectCompanion(env, options));
}
async function inspectCompanion(env, { manual = false } = {}) {
  let legacy = {};
  try { legacy = await env.store?.load?.() || {}; } catch {}
  const ext = readExtConfig(env);
  const state = normalizeConfig({...legacy,...pickConfig(ext)});
  const target = resolveTargetOpenid(env,legacy,ext);
  const now = Date.now(), date = new Date(now), today = localDate(date);
  const hhmm = String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0');
  const finish = (reason,error='') => {
    const patch = Object.fromEntries(runtimeFields.map(key=>[key,state[key]]));
    writeExtConfig(env,{...patch,lastCheckTs:now,lastCheckReason:reason,lastSendError:error});
    return {sent:false,accepted:reason==='queued',reason,error};
  };
  if (state.dailyDate !== today) {
    state.dailyDate=today; state.dailyCount=0; state.greetedWindowsToday=[];
  }
  if (!state.enabled) return finish('disabled');
  if (!target) return finish('missing_target');
  try {
    const history=latestHistory(env,target,now);
    state.lastInteractionTs=Math.max(state.lastInteractionTs,history.activity);
    if (history.user > state.lastBubbleTs) state.consecutiveBubblesWithoutReply=0;
  } catch { return finish('history_read_failed','无法读取私聊历史'); }
  if (state.mutedDate===today) return finish('muted_today');
  if (state.dailyMax > 0 && state.dailyCount >= state.dailyMax) return finish('daily_limit');
  if (inRange(hhmm,state.dndStart,state.dndEnd)) return finish('dnd');
  const maxUnanswered = state.maxUnanswered != null ? Number(state.maxUnanswered) : 3;
  if (maxUnanswered > 0 && state.consecutiveBubblesWithoutReply >= maxUnanswered) return finish('awaiting_reply');
  const cooldown=state.minIntervalHours*3600000*(state.consecutiveBubblesWithoutReply>0?1.6:1);
  if (state.lastBubbleTs && now-state.lastBubbleTs < cooldown) return finish('cooldown');
  let scenario=manual?'manual':'';
  if (!scenario && state.windowGreetingEnabled && (!state.lastInteractionTs || now-state.lastInteractionTs>=1200000)) {
    for (const key of ['morning','afternoon','evening','night']) {
      if (state[key+'Enabled'] && !state.greetedWindowsToday.includes(key) && inRange(hhmm,state[key+'Start'],state[key+'End'])) { scenario=key; break; }
    }
  }
  if (!scenario && state.idlePokeEnabled) {
    if (!state.lastInteractionTs) return finish('no_interaction_history');
    const threshold=state.idleHoursThreshold>0?state.idleHoursThreshold*3600000:state.idleMinutesThreshold*60000;
    if (now-state.lastInteractionTs>=threshold) scenario='idle_care';
  }
  if (!scenario) return finish('waiting_threshold');
  try { await requestCompanionCare(env,target,scenario); }
  catch (error) {
    env.logger?.warn?.('[companion] '+error.message);
    return finish('send_failed',error.message);
  }
  state.lastBubbleTs=now; state.dailyCount++; state.consecutiveBubblesWithoutReply++;
  if (scenario!=='idle_care' && scenario!=='manual') state.greetedWindowsToday.push(scenario);
  return finish('queued');
}
let generation=0, timer=null, first=null, pending=Promise.resolve();
export default {
  async run(env) {
    const token=++generation;
    clearTimeout(first); clearInterval(timer);
    const check=()=> {
      // Serialize reloads and ticks, and drop ticks queued by an old generation.
      pending=pending.then(()=>token===generation?checkCompanion(env):undefined).catch(error=>env.logger?.warn?.('[companion] '+error.message));
      return pending;
    };
    first=setTimeout(check,15000);
    timer=setInterval(check,30000);
    env.registerDispose?.(()=>{if(token===generation){generation++;clearTimeout(first);clearInterval(timer);}});
    env.logger?.info?.('[companion] 已启动，每 30 秒巡检；状态命令可查看未发送原因');
  },
  async dispose() { generation++;clearTimeout(first);clearInterval(timer);await pending; }
};
