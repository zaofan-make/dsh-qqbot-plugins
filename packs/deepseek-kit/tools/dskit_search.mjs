/**
 * dskit_search.mjs —— DeepSeek 官方「联网搜索 / 深度思考搜索 / 图片搜索」
 *
 * 为什么不用现成的 web_search：DeepSeek 这套是**服务端工具** ——
 * 声明 `deepseek_web_search` 后，搜索、开页、页内查找全在服务端完成，模型自己决定搜不搜；
 * 关思考是一次搜索带引用作答，开思考是多步深度搜索（最多约 20 次工具调用）。
 * 用户消息里带图时，还能按图搜索（kind=image_search）。
 *
 * 契约：export default { name, description, inputSchema, enabled, run }
 */
import { cfgForCall, toolVisible } from '../lib/dskit-config-v5.mjs';
import { webSearch } from '../lib/dskit-api.mjs';

export default {
  name: 'dskit_search',
  description:
    '用 DeepSeek 官方联网搜索回答问题（服务端搜索，带引用）。'
    + 'thinking=true 时启用「深度思考搜索」：多步搜索、打开网页、页内查找后再作答；'
    + 'images 传本地图片路径（逗号分隔）可做按图搜索。'
    + '返回答案正文 + 引用来源列表。',
  inputSchema: {
    query: { type: 'string', description: '要查的问题（自然语言即可）' },
    thinking: { type: 'boolean', description: '是否开深度思考搜索（多步检索，慢但更准），默认 false' },
    images: { type: 'string', description: '本地图片路径，逗号分隔（用于按图搜索）' },
  },

  enabled: (env) => toolVisible(env, 'enableSearch'),

  async run(args, env) {
    const cfg = cfgForCall(env);
    if (!cfg) return { ok: false, msg: '没有可用 Key（非 DeepSeek 官方会话时，请在设置页填自己的 Key）' };

    const query = String(args?.query || '').trim();
    if (!query) return { ok: false, msg: 'query 不能为空' };

    const thinking = args?.thinking === true || (args?.thinking === undefined && cfg.searchThinkingDefault === true);
    const imagePaths = String(args?.images || '')
      .split(/[,，;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const r = await webSearch({ cfg, query, thinking, imagePaths });
      if (!r.text) return { ok: false, msg: '模型没有返回正文（可能判断不需要搜索），可以换个问法或开 thinking=true' };

      const lines = [r.text];
      if (r.citations.length) {
        const uniq = [];
        const seen = new Set();
        for (const c of r.citations) {
          if (seen.has(c.url)) continue;
          seen.add(c.url);
          uniq.push(`- ${c.title || c.url}\n  ${c.url}`);
        }
        lines.push('', `引用来源（${uniq.length}）：`, ...uniq);
      }
      const u = r.usage;
      if (u) {
        const st = u.server_tool_use || {};
        lines.push('', `[用量] 搜索 ${Number(st.tool_search ?? 0)} / 抓取 ${Number(st.tool_fetch ?? 0)} / 图片搜索 ${Number(st.tool_image_search ?? 0)}；tokens: ${Number(u.input_tokens ?? 0)}+${Number(u.output_tokens ?? 0)}`);
      }
      return { ok: true, msg: lines.join('\n') };
    } catch (err) {
      return { ok: false, msg: String(err instanceof Error ? err.message : err) };
    }
  },
};
