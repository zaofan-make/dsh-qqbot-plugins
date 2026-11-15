/**
 * whale-emotion-buttons.mjs —— 出站扩展：给她的回复**自动挂一排情绪按钮**
 *
 * 主人 2026-11-15 的需求与三次纠正：
 *   ① 出站时如果这条消息没有按钮/不是按钮卡片，底部自动拼按钮；
 *   ② 按钮动作是**用户对鲸鱼娘做的**（摸摸头 / 戳戳脸 / 喂白饭），不是鲸鱼娘自己鼓腮；
 *   ③ 正文结尾**不拼**动作描写，只挂按钮；
 *   ④ 情绪判别要「参考论文，用结构而不是词表」。
 *
 * ── 情绪判别为什么不能靠词表 ────────────────────────────────────────────────
 * 实测翻车现场：`"哼，主人又来这一套喵~…人家也最喜欢主人了涅嘿嘿！"` 被判成「生气」，
 * 因为规则里写了 `哼`。可那是她的**口头禅**，不是情绪。
 *
 * 中文情感分析的规则派（《基于转折句式的文本情感倾向性分析》、ROSTEA、
 * 以及若干专利 CN110362679A / CN112861541A / CN104391984B）给的结构性结论：
 *
 *   1. **否定词**：不是"出现就翻转"，而是看**作用域**（离情感词多近）+ **奇偶**。
 *      奇数个 → 极性翻转；偶数个（双重否定）→ 保持。且要限制窗口，别让远处的否定词越界。
 *   2. **程度副词**：分级赋权（极其 2.0 / 很 1.5 / 比较 1.1 / 有点 0.8 / 稍微 0.7），
 *      用来缩放情感强度而不是决定极性。
 *   3. **转折结构**：转折词（但/不过/然而）后的子句权重更高 —— 后半句才是说话人想强调的。
 *      但不能僵化成"一定反转"，只做权重倾斜。
 *   4. **语气词（哼/啦/嘛/喵）**：权值极弱、歧义极大，**不能单独触发情感判定**。
 *      正确用法是当"句子边界/作用域终止符"，而不是情感信号。
 *
 * 所以这里的做法：**先剥语气词 → 按标点切子句 → 每个子句里找情感词，
 * 并检查它前面窗口内的否定词（奇偶）与程度副词（倍率）→ 累加打分 → 转折后子句加权重**。
 * 打不出分就归「好奇」，不硬猜。
 *
 * ── 发送链路（踩过的坑，别再踩）────────────────────────────────────────────
 *   · `ctx.transform` 是同步的，**写成 async 会返回 Promise**，上游 flatMap 不 await
 *     ⇒ 消息变空串发不出去（PR #61 的已知问题，见 issue #62）。
 *   · `OutboundCtx.target` 接口写的是 `peerId`，**实际塞进来的是 ReplyTarget，字段名 `targetId`**
 *     —— 读 peerId 永远 undefined，会静默跳过整段发送。
 *   · `sender.sendMarkdownWithKeyboard` **是存在的**（grep 编译产物找不到，但诊断打出来了）。
 *   · `ctx.note()` 在出站链里**没有实现**，拿它打日志等于静默丢弃 ⇒ 这里自己写文件。
 *
 * 放这儿：`{数据根}/.qqbot-extensions/outbound/whale-emotion-buttons.mjs`，改完 `/tools-reload`。
 */

export const name = 'whale-emotion-buttons';

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── 落盘诊断（ctx.note 不可用，只能自己写）──────────────────────────────────
function diag(ctx, line) {
  try {
    const root = String(ctx?.dataRoot ?? '');
    if (!root) return;
    const dir = join(root, '.qqbot');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'outbound-emotion-diag.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch { /* 诊断失败绝不影响主链 */ }
}

/**
 * 每个情绪 → 三个按钮。
 * ★ 按钮是"**用户对鲸鱼娘**做什么"，不是鲸鱼娘自己的动作（用户不会鼓腮，但会戳戳脸）。
 */
const MOODS = {
  happy: { buttons: ['摸摸头', '抱一抱', '喂白饭'] },
  shy: { buttons: ['戳戳脸', '捏捏尾巴', '夸一句'] },
  angry: { buttons: ['拍拍背', '递白饭', '认错了'] },
  tender: { buttons: ['摸摸头', '陪一会儿', '递纸巾'] },
  proud: { buttons: ['夸夸她', '记一功', '再来一次'] },
  curious: { buttons: ['说下去', '给个提示', '换个话题'] },
};

/** 情感词库：只作为"锚点"，真正的极性由它前面的否定/程度结构决定 */
const LEXICON = {
  happy: ['喜欢', '开心', '高兴', '好耶', '太棒', '真棒', '笑死', '不错', '棒极', '嘿嘿', '哈哈'],
  shy: ['害羞', '脸红', '不好意思', '捂脸', '才不是', '哪有', '羞死', '讨厌啦'],
  angry: ['生气', '过分', '气死', '不许', '讨厌你', '烦'],
  tender: ['辛苦', '心疼', '抱抱', '陪你', '担心', '休息', '别累'],
  proud: ['搞定', '完成', '做到', '赢', '第一', '厉害', '办妥', '拿下', '成了'],
  curious: ['为什么', '怎么', '什么', '是不是', '真的吗', '好奇'],
};

/** 否定词：奇数翻转、偶数保持（双重否定） */
const NEGATORS = ['不', '没', '别', '无', '非', '未', '莫', '甭'];
/** 程度副词 → 强度倍率（论文里常见的分级） */
const DEGREES = {
  极其: 2.0, 最: 2.0, 非常: 1.8, 特别: 1.8, 太: 1.6, 很: 1.5, 真: 1.4, 挺: 1.2,
  比较: 1.1, 较: 1.1, 有点: 0.8, 稍微: 0.7, 略: 0.7,
};
/** 转折词：其后的子句权重更高（后半句才是重点） */
const TURNS = ['但是', '但', '不过', '然而', '可是', '只是', '却'];
/** 语气词：**不参与情绪判定**，只当子句边界/作用域终止符 */
const FILLER_RE = /[哼喵啦嘛哩嗯哦噢诶欸呀哇]+/gu;
/** 否定词/程度副词的作用域窗口（往前看几个字） */
const NEG_WINDOW = 4;
const DEG_WINDOW = 4;

/** 单子句打分：对每个情感词，看它前面的否定/程度结构 */
function scoreClause(clause) {
  const out = {};
  for (const [mood, words] of Object.entries(LEXICON)) {
    let sum = 0;
    for (const w of words) {
      let from = 0;
      for (;;) {
        const idx = clause.indexOf(w, from);
        if (idx < 0) break;
        from = idx + w.length;
        const pre = clause.slice(Math.max(0, idx - Math.max(NEG_WINDOW, DEG_WINDOW)), idx);
        // 程度副词倍率（取最靠近的那个）
        let weight = 1;
        for (const [d, mul] of Object.entries(DEGREES)) {
          if (pre.endsWith(d) || pre.slice(-DEG_WINDOW).includes(d)) { weight = mul; break; }
        }
        // 否定词奇偶（作用域窗口内计数）
        //
        // ★ 2026-11-15（CodeRabbit 抓到，实测确认）：「非常开心」会被判错。
        //   因为 **`非` 在否定词表里**，而 `非常` 是程度副词 ——
        //   它把「非」数成一次否定，把 happy 的 1.8 翻转成 -1.8，情绪整个判反。
        //   所以在数否定词之前，先把**程度副词整个从窗口里剔掉**（"非常"→""，"特别"→""…）。
        let win = pre.slice(-NEG_WINDOW);
        for (const d of Object.keys(DEGREES)) win = win.split(d).join('');
        let neg = 0;
        for (const n of NEGATORS) {
          let p = win.indexOf(n);
          while (p >= 0) { neg += 1; p = win.indexOf(n, p + n.length); }
        }
        if (neg % 2 === 1) weight = -weight; // 奇数翻转；偶数（双重否定）保持
        sum += weight;
      }
    }
    if (sum !== 0) out[mood] = sum;
  }
  return out;
}

/**
 * 情绪判别：剥语气词 → 切子句 → 逐句打分 → 转折后加权 → 叠标点信号 → 取最高。
 * 打不出分就归「好奇」（保守，不硬猜）。
 */
function pickMood(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return 'curious';

  // ① 剥语气词：它们是"作用域终止符"，不是情感信号。
  //   ★ 2026-11-15（CodeRabbit 第二轮抓到，实测确认）：**不能直接删**。
  //     `不啦我很开心` 删完变 `不我很开心` ⇒ 那个"不"会跨越语气词去否定"开心"，
  //     正好违背"语气词是作用域终止符"这条原则。
  //     改成**替换成子句分隔符**：`不啦我很开心` → `不，我很开心`，
  //     前半截"不"单独成句（没有情感词，无效），后半截正常判 happy。
  const clean = raw.replace(FILLER_RE, '，');

  // ② 切子句（标点 + 转折词），转折词单独标记
  const pieces = [];
  let buf = '';
  for (const ch of clean) {
    if ('，。！？；,.!?;\n'.includes(ch)) {
      if (buf.trim()) pieces.push({ text: buf, turn: false });
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) pieces.push({ text: buf, turn: false });
  // 转折词：把所在子句拆开，后半段标记 turn=true（只做权重倾斜，不强制反转）
  const clauses = [];
  for (const p of pieces) {
    let rest = p.text;
    let hitTurn = false;
    for (const tw of TURNS) {
      const i = rest.indexOf(tw);
      // ★ 2026-11-15（CodeRabbit 第二轮）：原来是 `i > 0` —— 于是
      //   `生气，但是开心` 切完子句后 rest 就是"但是开心"，indexOf 得 0，
      //   这个判断直接跳过、转折权重没加上，两种情绪同分、由先登记的赢（错的）。
      //   改成 `i >= 0`，并且前面那截为空时不 push（避免塞空子句）。
      if (i >= 0) {
        const head = rest.slice(0, i).trim();
        if (head) clauses.push({ text: head, turn: false });
        rest = rest.slice(i + tw.length);
        hitTurn = true;
        break;
      }
    }
    if (hitTurn && rest.trim()) clauses.push({ text: rest, turn: true });
    else if (rest.trim()) clauses.push({ text: rest, turn: p.turn });
  }

  // ③ 累加打分；转折后的子句权重 ×1.5
  const total = {};
  for (const c of clauses) {
    const sc = scoreClause(c.text);
    const w = c.turn ? 1.5 : 1;
    for (const [m, v] of Object.entries(sc)) total[m] = (total[m] ?? 0) + v * w;
  }

  // ④ 标点是最便宜也最硬的信号（论文里也强调别忽略）
  const ex = (clean.match(/[!！]/gu) ?? []).length;
  const qu = (clean.match(/[?？]/gu) ?? []).length;
  if (ex > 0) total.happy = (total.happy ?? 0) + ex * 0.5;
  if (qu > 0) total.curious = (total.curious ?? 0) + qu * 1.0;

  // ⑤ 取最高分（>0 才算数）
  let best = 'curious';
  let bestScore = 0;
  for (const [m, v] of Object.entries(total)) {
    if (v > bestScore) { bestScore = v; best = m; }
  }
  return bestScore > 0 ? best : 'curious';
}

/** 拼 QQ 的 inline_keyboard：一行，按钮文字就是点击后要发的指令 */
function keyboardOf(instructions) {
  return {
    content: {
      rows: [
        {
          buttons: instructions.map((label, i) => ({
            id: `whale_${i}`,
            render_data: { label, visited_label: label, style: 1 },
            action: {
              type: 2, // 指令按钮：点了往输入框插 @bot + data（不触发回调，不需要后端）
              permission: { type: 2 }, // 所有人可点
              data: label, // 点击后输入框变成「@bot 摸摸头」
              unsupport_tips: '请升级 QQ 客户端后重试',
            },
          })),
        },
      ],
    },
  };
}

/**
 * 正文里带**协议标记**时一律不接管。
 *
 * ★ 2026-11-15 主人实测抓到：她发图时正文是 `[MEDIA:image|D:\\...png]`，
 *   我接管后拿 `sendMarkdownWithKeyboard` 发的却是**原始文本**
 *   —— 而 `[MEDIA:]` 是 transport 的 `parseOutbound` 解析成"媒体段"的，
 *   走我这条路就没人解析它，于是整串路径**原样显示在群里**（图也没了）。
 *   `[RECALL]` / `[rf:xxx]` 同理。
 *   这些标记代表"这条消息要分段发（文本+图+撤回）"，我一个按钮不值得破坏它 ⇒ 直接放行。
 */
const DIRECTIVE_RE = /\[(?:MEDIA|RECALL|rf)\b/i;

function hasDirectives(text) {
  return DIRECTIVE_RE.test(String(text ?? ''));
}

/** 正文里已经带按钮/键盘标记就不重复挂 */
function alreadyHasKeyboard(ctx) {
  if (ctx.kind === 'card' || ctx.kind === 'markdown') return true;
  const raw = JSON.stringify(ctx.segments ?? []);
  return raw.includes('"keyboard"') || raw.includes('inline_keyboard');
}

export default async function onOutbound(ctx, next) {
  const safeNext = typeof next === 'function' ? next : () => undefined;

  try {
    // ① 只在正文发送前动手；只处理"她本人说的话"
    if (ctx?.phase !== 'send') return safeNext();
    if (ctx?.source !== 'assistant/message') return safeNext();
    const text = String(ctx?.text ?? '');
    if (!text.trim()) return safeNext();
    if (alreadyHasKeyboard(ctx)) return safeNext();
    // 带 MEDIA/RECALL/rf 这类协议标记 → 放行（接管会把标记当文字发出去）
    if (hasDirectives(text)) return safeNext();

    const def = MOODS[pickMood(text)] ?? MOODS.curious;

    // ② transform：只做收尾（去掉尾部空白）。
    //    ⚠️ 必须同步返回；async 会被 flatMap 当消息本体，整条变空串（issue #62）
    let transformed = false;
    if (typeof ctx.transform === 'function') {
      transformed = ctx.transform((m) => ({ ...m, text: String(m.text ?? '').trimEnd() }));
    }

    // ③ 发「正文 + 一排按钮」的卡片，替换掉原来那条纯文本
    const cardText = text;
    const keyboard = keyboardOf(def.buttons);
    // ⚠️ target 的真实字段名是 targetId（ReplyTarget），不是接口写的 peerId
    const peerId = String(ctx?.target?.targetId ?? ctx?.target?.peerId ?? '');
    const msgId = String(ctx?.target?.msgId ?? '');
    const scope = String(ctx?.target?.scope ?? '');
    const isGroup = scope === 'group';

    let sent = false;
    // 首选：sender 上现成的带键盘发送
    if (typeof ctx.sender?.sendMarkdownWithKeyboard === 'function' && ctx.target) {
      try {
        const r = await ctx.sender.sendMarkdownWithKeyboard(ctx.target, cardText, keyboard);
        sent = r !== false;
        if (!sent) diag(ctx, '[情绪按钮] sendMarkdownWithKeyboard 返回 false');
      } catch (e) {
        diag(ctx, `[情绪按钮] sendMarkdownWithKeyboard 抛错: ${String(e?.message ?? e)}`);
      }
    }
    // 回落：官方 API 发 msg_type:2
    if (!sent && peerId && typeof ctx.apiCall === 'function') {
      try {
        const body = {
          msg_type: 2,
          markdown: { content: cardText },
          keyboard,
          ...(msgId ? { msg_id: msgId } : {}),
          ...(isGroup ? {} : { content: cardText }),
        };
        const path = isGroup ? `/v2/groups/${peerId}/messages` : `/v2/users/${peerId}/messages`;
        const r = await ctx.apiCall('POST', path, body);
        sent = !(r && typeof r === 'object' && r.ok === false);
        if (!sent) diag(ctx, `[情绪按钮] apiCall ok=false: ${JSON.stringify(r).slice(0, 150)}`);
      } catch (e) {
        diag(ctx, `[情绪按钮] apiCall 抛错: ${String(e?.message ?? e)}`);
      }
    }
    if (!sent) diag(ctx, `[情绪按钮] 两条路都没发出去 peerId=${peerId} hasApi=${typeof ctx.apiCall} hasSenderKb=${typeof ctx.sender?.sendMarkdownWithKeyboard}`);

    if (sent) {
      // 卡片已带同样正文发出 ⇒ 原纯文本不要了（必须不调 next，否则重复一条）
      const ok = typeof ctx.annihilate === 'function' ? ctx.annihilate('已改为带情绪按钮的卡片') : false;
      if (ok) return;
      diag(ctx, '[情绪按钮] 消灭原文本被拒，跳过按钮卡片（避免两条）');
      return safeNext();
    }

    // ④ 发不了卡片：至少让 transform 的收尾生效，正文照常
    if (!transformed) diag(ctx, '[情绪按钮] 宿主不支持 transform，仅放行原文');
    return safeNext();
  } catch (e) {
    diag(ctx, `[情绪按钮] 异常已忽略: ${String(e?.message ?? e)}`);
    return safeNext();
  }
}
