/**
 * dskit_readurl.mjs —— DeepSeek 官方「阅读链接」
 *
 * 只声明 deepseek_read_url（不带搜索）：模型读用户给的链接后作答。
 * 官方限制：只认**最后一条用户消息**里的 URL，最多前 10 个不同 URL；网页正文加密放在
 * signature 里回传，所以这里是一次性同步调用、不保留多轮。
 *
 * 与 dskit_search 的区别：search 是"模型自己去搜"，readurl 是"你给链接，它去读"。
 */
import { cfgForCall, toolVisible } from '../lib/dskit-config.mjs';
import { readUrls } from '../lib/dskit-api.mjs';

export default {
  name: 'dskit_readurl',
  description:
    '用 DeepSeek 官方能力读取网页并作答（最多 10 个链接）。'
    + 'urls 给一个或多个 https 链接（逗号/换行分隔），question 可选（想问什么，不给就总结）。'
    + '返回：读到的页面清单 + 基于网页的回答。',
  inputSchema: {
    urls: { type: 'string', description: '要读的链接，多个用逗号或换行分隔（取前 10 个）' },
    question: { type: 'string', description: '想问的问题；不填则总结网页要点' },
  },

  enabled: (env) => toolVisible(env, 'enableReadUrl'),

  async run(args, env) {
    const cfg = cfgForCall(env);
    if (!cfg) return { ok: false, msg: '没有可用 Key（非 DeepSeek 官方会话时，请在设置页填自己的 Key）' };

    const urls = String(args?.urls || '')
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s));
    if (!urls.length) return { ok: false, msg: 'urls 里没有合法的 http(s) 链接' };

    try {
      const r = await readUrls({ cfg, urls, question: args?.question });
      const lines = [r.text || '(模型没有输出正文)'];
      if (r.pages.length) {
        lines.push('', '读取的页面：', ...r.pages.map((p) => `- ${p.title || p.url}${p.status && p.status !== 'completed' ? `（${p.status}）` : ''}\n  ${p.url}`));
      }
      return { ok: true, msg: lines.join('\n') };
    } catch (err) {
      return { ok: false, msg: String(err instanceof Error ? err.message : err) };
    }
  },
};
