# 如何在扩展里「主动唤醒」某个会话

> 面向扩展作者。以 `packs/proactive-companion` 为例（v1.0.6 起改用这个方案）。
>
> 需求插件版本：**≥ 1.10.44**（`caps.wakeTo` 与 `minPluginVersion` 都是这一版加的）

## 一句话

想让机器人「自己开口」跟某人说话，**不要发预置文案，去唤醒 AI 让它正常回一轮**：

```js
const ok = await env.caps.wakeTo('c2c', openid, prompt);
if (!ok) { /* 回退：自己发文案 */ }
```

- `scope`：`'c2c'` 私聊 / `'group'` 群
- `peerId`：私聊用户 openid / 群 openid
- `prompt`：**当成用户消息注入**的正文（AI 会看到它，然后正常作答，回复自动发到对应 QQ）
- 返回 `true` 表示已投递；`false` 表示没送达（**不抛错**），调用方自己决定回退策略

## 为什么不能直接发文案

`caps.text()` / `caps.api()` 发出去的是**死文本**：

- 不带人格、不带上下文，同一句话今天明天都一样
- 群里看起来像机器人广播，私聊里显得很机械
- 无法根据「上次聊到哪」做衔接

`wakeTo` 走的是**正常回合**：dsh 会补人设、带上该会话的历史、允许它调工具，产出的才是「它自己的话」。

## prompt 怎么写

这是最关键的一步。它会被当作 user 消息注入，所以：

1. **自报家门**，别让 AI 以为对方真的开口了：

   ```
   （系统提示，不是主人说的话）现在是 22:50，你和主人已经有 3 小时没有互动了。
   ```

2. **说清这次要干什么**，别只写「你好」：

   ```
   这次想主动做的是：晚安陪伴。
   请你主动给主人发一条私聊消息：一到两句，用你自己的语气和人设说。
   不要提"系统""提醒""定时""唤醒"这些词，也不要解释你为什么突然说话。
   ```

3. 可选：给一句「语气参考」，但**明确说可以完全换掉**，否则 AI 会照抄模板。

## 三个坑（都踩过）

### 1. 会话会被回收，不能只查活跃表

`manager.findByPeer()` 查的是**进程内活跃会话表**。宿主重启、或空闲一段时间没说话，会话会被回收 → 查到 undefined。

插件的 `caps.wakeTo` 内部已经处理：找不到会话时主动 `getOrCreateByPeerWeb()` 重建再注入。**用 `caps.wakeTo` 就不用管这个；自己调 manager 就必须自己补这一步**。

### 2. 空闲触发是惰性判断

没有「到点响铃」，只有轮询。本包是每 30 秒轮询一次、比较 `now - lastInteraction >= 阈值`。所以真实触发点会比阈值晚最多一个轮询周期。

### 3. 唤醒可能被价值评分拦掉

注入内容太像噪音（纯打招呼、纯「我收到了」）时，可能被判低价值而不产生回合。
对策：**写清为什么找它、要它做什么**；纯告知类内容改用 `appendSilent` 之类的静默通道。

## 本包的完整实现（可直接抄）

- `lib/transport.mjs` → `wakeCompanion()`：包一层，`typeof caps.wakeTo !== 'function'` 时返回 false，让旧宿主优雅回退
- `hooks/companion-daemon.mjs` → `buildWakePrompt()`：拼上面那种自报家门的 prompt
- 发送处：**先 wake、失败才发模板**，并把结果记进 `lastDelivery: 'wake' | 'template'`

```js
const woken = await wakeCompanion(env, target, prompt);
state.lastDelivery = woken ? 'wake' : 'template';
if (!woken) {
  try { await sendCompanionText(env, target, template); } catch (e) { /* 兜底也失败就算了 */ }
}
```

## 声明最低插件版本

用了新能力，就该在 `qqbot-pack.json` 里声明，面板会在装之前就提示不满足：

```json
{
  "name": "主动陪伴与私聊关怀",
  "version": "1.0.6",
  "minPluginVersion": "1.10.44"
}
```

不满足时市场卡片会标红显示「需要插件 ≥ v1.10.44（当前 vX.Y.Z）」。
