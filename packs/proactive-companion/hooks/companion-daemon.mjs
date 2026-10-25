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
 *    - 优先「唤醒 AI 自己说」（caps.wakeTo 注入模拟用户消息，AI 按人设回一轮）；
 *    - 宿主不支持唤醒时回退官方 API / 私聊文本通道投递预置文案；
 *    - 发送通道不可用时安全跳过，不猜测收件人。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConfig, pickConfig, readExtConfig, resolveTargetOpenid, safeOpenid, writeExtConfig } from '../lib/config.mjs';
import { sendCompanionText, wakeCompanion } from '../lib/transport.mjs';

/** 场景 → 唤醒提示里用的中文说明（别写英文 key，AI 会照抄） */
const SCENARIO_LABEL = {
  morning: '早安问候',
  afternoon: '午后提神',
  evening: '傍晚提醒',
  night: '晚安陪伴',
  idle_care: '隔了很久没说话，想随便冒个泡',
};

/** 毫秒 → 人话（用于告诉 AI「多久没聊了」；不给准确数字它容易说错） */
function humanGap(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '一小会儿';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时`;
  return `${Math.floor(hour / 24)} 天`;
}

/**
 * 生成注入给 AI 的「唤醒提示」。它会以 user 消息形态进入目标会话，
 * 所以必须自己声明“这不是 TA 说的话”，否则 AI 会误以为对方开口了。
 * 模板只作为“语气参考”，不作原文投递 —— 目的是让 AI 用自己的话说。
 */
export function buildWakePrompt({ scenario, template, state, hhmm, gapMs }) {
  const name = state?.displayName ? String(state.displayName) : 'TA';
  const label = SCENARIO_LABEL[scenario] || '主动关怀';
  return [
    `（系统提示，不是 ${name} 说的话）现在是 ${hhmm}，你和 ${name} 已经有 ${humanGap(gapMs)} 没有互动了。`,
    `这次想主动做的是：${label}。`,
    `请你主动给 ${name} 发一条私聊消息：一到两句，用你自己的语气和人设说，像真人忽然想起对方随口讲一句那样。`,
    `不要提“系统”“提醒”“定时”“巡检”“唤醒”“主动关怀”这些词，不要解释你为什么突然说话，也不要长篇大论。`,
    `语气参考（可以改、可以完全换掉，别照抄）：${template}`,
  ].join('\n');
}

/**
 * 声明设置面板（在「QQ机器人扩展」-「设置中心」中直接渲染可视化配置表单）
 */
export const qqbotSettingsPage = {
  title: '主动陪伴关怀设置',
  desc: '配置机器人在私聊中主动关怀主人的双驱动并行策略（时段问候 + 空闲超时冒泡）与防打扰规则。',
  schema: [
    // 全局基础配置
    { key: 'enabled', type: 'bool', label: '启用主动关怀总开关', default: true, hint: '总开关：关闭后将停止一切主动问候与冒泡' },
    { key: 'targetOpenid', type: 'string', label: '主人 OpenID', default: '', hint: '接收主动关怀的目标私聊 OpenID（留空时仅回退到宿主提供的主人列表，不会从任意最近 C2C 会话猜测）' },
    { key: 'displayName', type: 'string', label: '称呼', default: '主人', hint: '主动问候时使用的称呼，留空则不特别称呼' },
    { key: 'dailyMax', type: 'number', label: '每天最大关怀次数', default: 5, hint: '两条路线共享每日额度（默认 5 次）；0 表示不限每日次数，仍遵守免打扰、冷却和未回复保护'  },
    { key: 'minIntervalHours', type: 'number', label: '两次关怀最小间隔(小时)', default: 2.5, hint: '两次主动发送之间的最小冷却时间（默认 2.5 小时）；0 表示关闭冷却，仍遵守其他保护规则' },
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
    { key: 'idleHoursThreshold', type: 'number', label: '└─ 空闲超时阈值(小时)', default: 3, hint: '默认 3 小时；大于 0 使用小时阈值，设为 0 使用下方分钟阈值'  },
    { key: 'idleMinutesThreshold', type: 'number', label: '└─ 空闲超时阈值(分钟)', default: 30, hint: '仅小时为 0 时生效；最少 1 分钟' },
  ],
};

const SCENARIO_TEMPLATES = {
  morning: [
    '早上好呀~ {name}醒了吗？新的一天也要顺顺利利哦',
    '呜……揉揉眼睛，早安啦！今天也要元气满满呢~'
  ],
  afternoon: [
    '下午两点啦，是不是容易打瞌睡呀？{name}快伸个懒腰，喝口水提提神~',
    '午后元气补充！突然探头，提醒{name}起来活动一下肩膀哦~'
  ],
  evening: [
    '天色暗下来啦，{name}今天忙完了嘛？别忘了吃晚饭哦，辛苦啦！',
    '傍晚时间到！肚子饿了没？去奖励自己一顿好吃的吧~'
  ],
  night: [
    '夜深了哦，{name}今天打算几点睡？别熬太晚啦，会变成大熊猫的！',
    '差不多该准备钻进被窝啦~ 晚安，祝今晚做个甜甜的好梦~'
  ],
  idle_care: [
    '悄悄探头看一眼……{name}在忙什么呀？好久没跟我说话啦~',
    '戳一下！突然冒泡，提醒{name}记得多喝温水哦。',
    '{name}{name}，在不在呀？要是累了随时找我唠唠嗑~'
  ]
};


const runtimeFields = ['lastBubbleTs','lastInteractionTs','consecutiveBubblesWithoutReply','dailyDate','dailyCount','greetedWindowsToday','lastCheckTs','lastCheckReason','lastSendError','lastDelivery'];
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
export async function checkCompanion(env) {
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
    return {sent:reason==='sent',reason,error};
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
  if (state.consecutiveBubblesWithoutReply >= 2) return finish('awaiting_reply');
  const cooldown=state.minIntervalHours*3600000*(state.consecutiveBubblesWithoutReply>0?1.6:1);
  if (state.lastBubbleTs && now-state.lastBubbleTs < cooldown) return finish('cooldown');
  let scenario='';
  if (state.windowGreetingEnabled && (!state.lastInteractionTs || now-state.lastInteractionTs>=1200000)) {
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
  const list=SCENARIO_TEMPLATES[scenario];
  const template=list[Math.floor(Math.random()*list.length)].replaceAll('{name}',state.displayName);
  // ── 先让 AI 自己说，模板只做兜底（2026-10-13）──────────────────────────
  //   wakeCompanion → 宿主 caps.wakeTo('c2c', openid, prompt)：
  //   往目标会话注入一条模拟 user 消息，AI 按人设正常回一轮，回复由宿主发到 QQ。
  //   这样发出去的是“它的话”，不是预置文案；宿主没接（旧版）或唤醒失败才回退模板。
  const gapMs = state.lastInteractionTs ? now - state.lastInteractionTs : 0;
  const prompt = buildWakePrompt({ scenario, template, state, hhmm, gapMs });
  const woken = await wakeCompanion(env, target, prompt);
  // 2026-10-25：记下这次走的是哪条路，面板/命令一眼可见，不必再翻出站日志猜。
  state.lastDelivery = woken ? 'wake' : 'template';
  if (!woken) {
    try { await sendCompanionText(env,target,template); }
    catch (error) {
      env.logger?.warn?.('[companion] '+error.message);
      return finish('send_failed',error.message);
    }
  }
  state.lastBubbleTs=now; state.dailyCount++; state.consecutiveBubblesWithoutReply++;
  if (scenario!=='idle_care') state.greetedWindowsToday.push(scenario);
  return finish('sent');
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
