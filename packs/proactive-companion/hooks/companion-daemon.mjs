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
 *    - 首选通过 `appendWake` 唤醒会话注入提示，由机器人结合人设、主人偏好与近期记忆自然拟真生成；
 *    - 兜底文案库通过直流通道路由。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 声明设置面板（在「QQ机器人扩展」-「设置中心」中直接渲染可视化配置表单）
 */
export const qqbotSettingsPage = {
  title: '主动陪伴关怀设置',
  desc: '配置机器人在私聊中主动关怀主人的双驱动并行策略（时段问候 + 空闲超时冒泡）与防打扰规则。',
  schema: [
    // 全局基础配置
    { key: 'enabled', type: 'bool', label: '启用主动关怀总开关', default: true, hint: '总开关：关闭后将停止一切主动问候与冒泡' },
    { key: 'targetOpenid', type: 'string', label: '主人 OpenID', default: '', hint: '接收主动关怀的目标私聊 OpenID（留空时将自动从最近私聊过的记录或系统台账中获取）' },
    { key: 'dailyMax', type: 'number', label: '每天最大关怀次数', default: 5, hint: '路线一与二共享的每日总额度（默认 5 次：早晚各占 1 次，其余 3 次留给白天空闲冒泡）' },
    { key: 'minIntervalHours', type: 'number', label: '两次关怀最小间隔(小时)', default: 2.5, hint: '两次主动发送之间的最小冷却时间（默认 2.5 小时）' },
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
    { key: 'idleHoursThreshold', type: 'number', label: '└─ 空闲超时阈值(小时)', default: 3, hint: '连续多少小时没有聊天后允许主动发起问候（默认 3 小时）' },
  ],
};

let activeTimer = null;

// 预设情境模板库（用于兜底或启发词生成）
const SCENARIO_TEMPLATES = {
  morning: [
    '早上好呀~ 墨旅醒了吗？新的一天也要顺顺利利哦 [MEDIA:image|D:\\dsh workspace\\dshqqbot\\表情包\\lib\\library\\31_1760087702.png]',
    '呜……揉揉眼睛，早安啦！今天也要元气满满呢~'
  ],
  afternoon: [
    '下午两点啦，是不是容易打瞌睡呀？墨旅快伸个懒腰，喝口水提提神~',
    '午后元气补充！澜澜突然探头，提醒主人起来活动一下肩膀哦~'
  ],
  evening: [
    '天色暗下来啦，墨旅今天忙完了嘛？别忘了吃晚饭哦，辛苦啦！',
    '傍晚时间到！肚子饿了没？去奖励自己一顿好吃的吧~'
  ],
  night: [
    '夜深了哦，墨旅今天打算几点睡？别熬太晚啦，会变成大熊猫的！',
    '差不多该准备钻进被窝啦~ 晚安，祝今晚做个甜甜的好梦~'
  ],
  idle_care: [
    '悄悄探头看一眼……墨旅在忙什么呀？好久没跟我说话啦~',
    '戳一下！本澜澜突然冒泡，提醒墨旅记得多喝温水哦。',
    '墨旅墨旅，在不在呀？要是累了随时找我唠唠嗑~'
  ]
};

function getNowHHMM() {
  const d = new Date();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

function isInTimeRange(nowHHMM, startHHMM, endHHMM) {
  if (!startHHMM || !endHHMM) return false;
  if (startHHMM <= endHHMM) {
    return nowHHMM >= startHHMM && nowHHMM <= endHHMM;
  }
  // 跨午夜的情况，例如 23:30 ~ 08:30
  return nowHHMM >= startHHMM || nowHHMM <= endHHMM;
}

function pickRandom(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

export default {
  run: async (env) => {
    const logger = env.logger || console;
    logger.info('[companion] 主动陪伴守护进程已启动（双驱动并行架构）');

    // 自动探测最近的主人私聊 OpenID（若用户未显式配置）
    function detectLatestC2COpenid() {
      try {
        const root = env.dataRoot || join(process.cwd(), 'dshqqbot');
        const knownFile = join(root, '表情包', 'known-chats.jsonl');
        if (existsSync(knownFile)) {
          const lines = readFileSync(knownFile, 'utf8').trim().split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const item = JSON.parse(lines[i]);
              if (item.scope === 'c2c' && item.id) {
                return item.id;
              }
            } catch {}
          }
        }
      } catch {}
      return '';
    }

    // 加载或初始化配置与持久化状态
    async function getStoreState() {
      let state = {};
      try {
        if (env.store && typeof env.store.load === 'function') {
          state = (await env.store.load()) || {};
        }
      } catch (err) {
        logger.warn(`[companion] 读取存储失败: ${err.message}`);
      }

      // 同时合并从设置中心面板写入的 ext-config 配置（若有）
      try {
        const extCfgPath = join(process.cwd(), '.qqbot-extensions', '.state', 'ext-config', 'companion-daemon.json');
        if (existsSync(extCfgPath)) {
          const cfg = JSON.parse(readFileSync(extCfgPath, 'utf8'));
          if (cfg && typeof cfg === 'object') {
            state = { ...state, ...cfg };
          }
        }
      } catch {}

      // 如果设置中未配置 targetOpenid，则动态自动嗅探最近与机器人发起私聊的 C2C OpenID
      let effectiveOpenid = state.targetOpenid;
      if (!effectiveOpenid) {
        effectiveOpenid = detectLatestC2COpenid() || '';
        // 如果扫描到了有效的私聊对象，自动持久化写回到插件配置里
        if (effectiveOpenid) {
          logger.info(`[companion] 自动识别到主人最近私聊 OpenID: ${effectiveOpenid}，已自动同步写入设置`);
          state.targetOpenid = effectiveOpenid;
          try {
            const root = env.dataRoot || join(process.cwd(), 'dshqqbot');
            const cfgDir = join(root, '.qqbot-extensions', '.state', 'ext-config');
            if (!existsSync(cfgDir)) {
              mkdirSync(cfgDir, { recursive: true });
            }
            const extCfgPath = join(cfgDir, 'companion-daemon.json');
            let existingCfg = {};
            if (existsSync(extCfgPath)) {
              try { existingCfg = JSON.parse(readFileSync(extCfgPath, 'utf8')); } catch {}
            }
            existingCfg.targetOpenid = effectiveOpenid;
            writeFileSync(extCfgPath, JSON.stringify(existingCfg, null, 2), 'utf8');
          } catch (e) {
            logger.warn(`[companion] 自动回写配置失败: ${e.message}`);
          }
          if (env.store && typeof env.store.save === 'function') {
            env.store.save({ ...state, targetOpenid: effectiveOpenid }).catch(() => {});
          }
        }
      }

      return {
        // 全局
        enabled: state.enabled ?? true,
        targetOpenid: effectiveOpenid,
        dailyMax: state.dailyMax ?? 5,
        minIntervalHours: state.minIntervalHours ?? 2.5,
        dndStart: state.dndStart || '23:30',
        dndEnd: state.dndEnd || '08:30',

        // 路线一：时段问候（默认开启早安、晚安；午后与傍晚默认关闭）
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

        // 路线二：空闲冒泡（默认 3 小时）
        idlePokeEnabled: state.idlePokeEnabled ?? true,
        idleHoursThreshold: state.idleHoursThreshold ?? 3,

        // 运行时统计与退避
        lastBubbleTs: state.lastBubbleTs ?? 0,
        consecutiveBubblesWithoutReply: state.consecutiveBubblesWithoutReply ?? 0,
        dailyDate: state.dailyDate || getTodayStr(),
        dailyCount: state.dailyCount ?? 0,
        greetedWindowsToday: Array.isArray(state.greetedWindowsToday) ? state.greetedWindowsToday : [],
        lastInteractionTs: state.lastInteractionTs ?? Date.now(),

        ...state
      };
    }

    async function saveStoreState(state) {
      try {
        if (env.store && typeof env.store.save === 'function') {
          await env.store.save(state);
        }
      } catch (err) {
        logger.warn(`[companion] 保存状态失败: ${err.message}`);
      }
    }

    // 巡检核心逻辑
    async function checkAndTrigger() {
      const state = await getStoreState();
      if (!state.enabled) return;

      const now = Date.now();
      const todayStr = getTodayStr();
      const nowHHMM = getNowHHMM();

      // 日期跨天重置
      if (state.dailyDate !== todayStr) {
        state.dailyDate = todayStr;
        state.dailyCount = 0;
        state.greetedWindowsToday = [];
      }

      // 1. 每日次数上限检查
      if (state.dailyCount >= state.dailyMax) {
        return;
      }

      // 2. 免打扰时段判定 (DND)
      if (isInTimeRange(nowHHMM, state.dndStart, state.dndEnd)) {
        return;
      }

      // 3. 尝试获取最近一次主人与私聊交互时间
      // 检查 .qqbot/msg-history 中的最新记录（优先兼容 dataRoot，避免因相对路径找不到）
      try {
        const root = env.dataRoot || join(process.cwd(), 'dshqqbot');
        const histDir = join(root, '.qqbot', 'msg-history', `c2c_${state.targetOpenid}`);
        const todayFile = join(histDir, `${todayStr}.jsonl`);
        if (existsSync(todayFile)) {
          const lines = readFileSync(todayFile, 'utf8').trim().split('\n').filter(Boolean);
          if (lines.length > 0) {
            // 从后往前扫，分别寻找最近一次任意消息时间和主人发言时间
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const item = JSON.parse(lines[i]);
                const ts = item.t || item.ts || (item.time ? new Date(item.time).getTime() : 0);
                if (!ts) continue;

                // 记录整场会话最新活动时间
                if (ts > state.lastInteractionTs) {
                  state.lastInteractionTs = ts;
                }

                // 判断是否为主人的主动发言（非机器人自己 me:true）
                const isUserMsg = !item.me && item.s !== 'self' && item.s === state.targetOpenid;
                if (isUserMsg) {
                  // 如果主人最新的这条发言发生在我们上次主动关怀之后，重置连续未回复计数
                  if (ts > (state.lastBubbleTs || 0)) {
                    state.consecutiveBubblesWithoutReply = 0;
                  }
                  break;
                }
              } catch { /* 忽略损坏行 */ }
            }
          }
        }
      } catch (e) {
        // 读取失败则沿用已记录的状态
      }

      // 4. 连续未回复退避
      // 如果连续主动发了 2 次都没回，暂时不再骚扰，等待对方说话
      if (state.consecutiveBubblesWithoutReply >= 2) {
        return;
      }

      // 5. 两次主动关怀最小冷却时间判定 (含退避系数)
      const backoffMultiplier = state.consecutiveBubblesWithoutReply > 0 ? 1.6 : 1.0;
      const effectiveIntervalMs = state.minIntervalHours * 3600 * 1000 * backoffMultiplier;
      if (now - state.lastBubbleTs < effectiveIntervalMs) {
        return;
      }

      // 6. 双驱动并行判定逻辑：
      // 路线 A: 作息时段定时关怀 (Window Greeting)
      // 路线 B: 空闲超时主动冒泡 (Idle Poke)
      let scenario = null;
      let promptReason = '';
      let triggeredWindowKey = null;

      // 判定路线 A: 时间窗口关怀
      if (state.windowGreetingEnabled) {
        const greeted = state.greetedWindowsToday || [];

        // 早安 (默认 08:30~09:30)
        if (state.morningEnabled && !greeted.includes('morning') && isInTimeRange(nowHHMM, state.morningStart, state.morningEnd)) {
          scenario = 'morning';
          promptReason = '现在是早晨时间，主人可能刚起床或准备开始新的一天，主动问候早安';
          triggeredWindowKey = 'morning';
        }
        // 午后提神 (默认 14:00~14:30)
        else if (state.afternoonEnabled && !greeted.includes('afternoon') && isInTimeRange(nowHHMM, state.afternoonStart, state.afternoonEnd)) {
          scenario = 'afternoon';
          promptReason = '现在是下午两点左右的犯困时段，提醒主人伸伸懒腰、喝口水提提神';
          triggeredWindowKey = 'afternoon';
        }
        // 傍晚提醒 (默认 18:30~19:30)
        else if (state.eveningEnabled && !greeted.includes('evening') && isInTimeRange(nowHHMM, state.eveningStart, state.eveningEnd)) {
          scenario = 'evening';
          promptReason = '现在是傍晚下班/晚饭时段，关心主人一天辛苦了，提醒好好吃饭休息';
          triggeredWindowKey = 'evening';
        }
        // 晚安陪伴 (默认 22:30~23:30)
        else if (state.nightEnabled && !greeted.includes('night') && isInTimeRange(nowHHMM, state.nightStart, state.nightEnd)) {
          scenario = 'night';
          promptReason = '现在是深夜临睡时段，提醒主人别熬夜太晚，道一声温馨的晚安';
          triggeredWindowKey = 'night';
        }

        // 如果主人在 20 分钟内才刚发过消息，时段问候不宜生硬插入打断当前互动
        if (scenario && (now - state.lastInteractionTs < 20 * 60 * 1000)) {
          scenario = null;
          triggeredWindowKey = null;
        }
      }

      // 判定路线 B: 空闲超时冒泡 (若路线 A 未命中，且开启了空闲冒泡)
      if (!scenario && state.idlePokeEnabled) {
        const idleMs = now - state.lastInteractionTs;
        const targetIdleMs = (state.idleHoursThreshold ?? 3) * 3600 * 1000;
        if (idleMs >= targetIdleMs) {
          scenario = 'idle_care';
          promptReason = `主人已经连续超过 ${state.idleHoursThreshold ?? 3} 小时没有找你聊天了，适度主动冒泡关心一下`;
        }
      }

      // 两条路线均未满足触发条件，静默跳过
      if (!scenario) {
        return;
      }

      logger.info(`[companion] 触发主动关怀！场景: ${scenario}, 原因: ${promptReason}`);

      // 7. 确定发送目标与消息内容
      const targetOpenid = state.targetOpenid || env.caps?.owners?.[0] || '';
      if (!targetOpenid) {
        logger.warn('[companion] 未找到有效的私聊目标 openid，跳过主动关怀');
        return;
      }

      const msgList = SCENARIO_TEMPLATES[scenario] || SCENARIO_TEMPLATES.idle_care;
      const msg = pickRandom(msgList);
      if (!msg) return;

      let triggered = false;

      // 策略 A: 优先通过官方 REST API 直接发往私聊（带 token 鉴权，启动钩子环境最稳健）
      const apiCall = env.caps?.api || env.api;
      if (typeof apiCall === 'function') {
        try {
          const msgSeq = Math.floor(Date.now() / 1000) % 1000000;
          const res = await apiCall(`/v2/users/${encodeURIComponent(targetOpenid)}/messages`, {
            method: 'POST',
            body: { content: msg, msg_type: 0, msg_seq: msgSeq }
          });
          if (res?.ok) {
            triggered = true;
            logger.info(`[companion] 已通过官方 API 成功发送私聊关怀: ${msg}`);
          } else {
            logger.warn(`[companion] 官方 API 发送返回未就绪或受限: ${JSON.stringify(res?.err || res)}`);
          }
        } catch (err) {
          logger.warn(`[companion] 官方 API 调用异常: ${err.message}`);
        }
      }

      // 策略 B: 兜底通用文本通道 (env.caps?.text / env.text / env.qq?.sendText)
      if (!triggered) {
        try {
          if (typeof env.caps?.text === 'function') {
            triggered = await env.caps.text(msg);
          } else if (typeof env.text === 'function') {
            await env.text(targetOpenid, msg, { scope: 'c2c' });
            triggered = true;
          } else if (env.qq && typeof env.qq.sendText === 'function') {
            await env.qq.sendText(targetOpenid, msg, 'c2c');
            triggered = true;
          }
          if (triggered) {
            logger.info(`[companion] 已通过文本通道直发关怀: ${msg}`);
          }
        } catch (err) {
          logger.warn(`[companion] 文本通道发送失败: ${err.message}`);
        }
      }

      // 8. 更新统计状态
      if (triggered) {
        state.lastBubbleTs = now;
        state.dailyCount += 1;
        state.consecutiveBubblesWithoutReply += 1;
        if (triggeredWindowKey) {
          if (!state.greetedWindowsToday.includes(triggeredWindowKey)) {
            state.greetedWindowsToday.push(triggeredWindowKey);
          }
        }
        await saveStoreState(state);
      }
    }

    // 启动初始延迟巡检与周期定时器（每 5 分钟巡检一次）
    const CHECK_INTERVAL_MS = 5 * 60 * 1000;
    setTimeout(() => {
      checkAndTrigger().catch(err => logger.warn(`[companion] 初次巡检异常: ${err.message}`));
    }, 15 * 1000);

    activeTimer = setInterval(() => {
      checkAndTrigger().catch(err => logger.warn(`[companion] 周期巡检异常: ${err.message}`));
    }, CHECK_INTERVAL_MS);
  },

  dispose: async () => {
    if (activeTimer) {
      clearInterval(activeTimer);
      activeTimer = null;
    }
  }
};
