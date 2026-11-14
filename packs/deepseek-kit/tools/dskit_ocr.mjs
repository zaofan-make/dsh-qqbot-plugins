/**
 * dskit_ocr.mjs —— DeepSeek 官方 OCR（PDF / Word / PPT / 图片）
 *
 * 官方：POST /v1/tools/ocr，multipart（file + purpose），按页返回文本。
 *   · purpose=text_recognition：不含图片的 Word/PPT 直接抽字，其它逐页识别
 *   · purpose=rich_layout_recognition：全部逐页识别，带 <|ref|>…<|box|>[[x1,y1,x2,y2]] 坐标标记
 *
 * 省 token 的关键：长文档**不整篇塞进上下文** —— 全文落到
 * `{dataRoot}/.qqbot-extensions/.state/dskit/ocr/<id>.txt`，工具只回前几页 + 文件路径，
 * 需要细节时让 AI 自己 read_file。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfgForCall, toolVisible } from '../lib/dskit-config-v5.mjs';
import { ocrFile } from '../lib/dskit-api.mjs';

const PREVIEW_PAGES = 5;
const PREVIEW_CHARS = 1200;

export default {
  name: 'dskit_ocr',
  description:
    '用 DeepSeek 官方 OCR 识别 PDF/Word/PPT/图片里的文字，按页返回。'
    + 'path 传本机文件绝对路径；purpose 可选 text_recognition（默认）或 rich_layout_recognition（带版面坐标标记）。'
    + '长文档只回前几页并把全文写到本地文件，返回文件路径供后续读取。',
  inputSchema: {
    path: { type: 'string', description: '本机文件绝对路径（PDF/DOC/DOCX/PPT/PPTX/PNG/JPG/WebP/GIF/BMP/TIFF）' },
    purpose: { type: 'string', description: 'text_recognition（默认）| rich_layout_recognition' },
  },

  enabled: (env) => toolVisible(env, 'enableOcr'),

  async run(args, env) {
    const cfg = cfgForCall(env);
    if (!cfg) return { ok: false, msg: '没有可用 Key（非 DeepSeek 官方会话时，请在设置页填自己的 Key）' };

    // ★ 2026-11-14 修：这里的 `dataRoot` 原来根本没声明（ReferenceError），
    //   try/catch 又会把它吞成"落盘失败"，症状是"识别成功但没有文件"。
    const dataRoot = String(env?.dataRoot || env?.manager?.dataRoot || env?.cwd || '').trim() || '.';

    const path = String(args?.path || '').trim();
    if (!path) return { ok: false, msg: 'path 不能为空' };

    try {
      const r = await ocrFile({ cfg, filePath: path, purpose: args?.purpose });
      const all = r.pages.map((p) => p.text).join('\n\n');

      // 全文落盘（长文档不塞上下文）
      let saved = '';
      try {
        const dir = join(dataRoot || '.', '.qqbot-extensions', '.state', 'dskit', 'ocr');
        mkdirSync(dir, { recursive: true });
        saved = join(dir, `${r.id || Date.now()}.txt`);
        writeFileSync(saved, all, 'utf8');
      } catch {
        saved = '';
      }

      const head = r.pages.slice(0, PREVIEW_PAGES).map((p) => {
        const t = p.text.length > PREVIEW_CHARS ? p.text.slice(0, PREVIEW_CHARS) + '…' : p.text;
        return `【第 ${p.index + 1} 页】${p.truncated ? '（本页输出被截断）' : ''}\n${t}`;
      });
      const lines = [
        `OCR 完成：${r.pageCount} 页，purpose=${r.purpose || cfg.ocrPurpose}`,
        '',
        ...head,
      ];
      if (r.pageCount > PREVIEW_PAGES) lines.push('', `（只显示前 ${PREVIEW_PAGES} 页，共 ${r.pageCount} 页）`);
      if (saved) lines.push('', `全文已保存：${saved}（需要细节用 read_file 读）`);
      if (all.length > 20000 && !saved) lines.push('', '⚠️ 文档较长且落盘失败，只返回了前面的内容');
      return { ok: true, msg: lines.join('\n') };
    } catch (err) {
      return { ok: false, msg: String(err instanceof Error ? err.message : err) };
    }
  },
};
