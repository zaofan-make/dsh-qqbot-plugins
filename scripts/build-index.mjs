#!/usr/bin/env node
/**
 * build-index.mjs — 扫 packs/ 生成 index.json
 *
 * 设计要点（2026-10-24 定）：
 *   · 作者 PR 里**只加自己的目录**，不碰 index.json ⇒ 多人同时提 PR 零冲突。
 *   · 本脚本在合并后自动跑，把 packs/<id>/qqbot-pack.json 拼成索引。
 *   · files 清单也由这里扫出来 —— 作者不用手写，也就不会写漏。
 *   · cover 自动探测目录根下的 cover.png/jpg/webp/gif，不用声明。
 *
 * qqbot-pack.json 需要的字段：
 *   name        必填
 *   author      必填
 *   version     必填
 *   description 可选
 *   homepage    可选
 *   tags        可选 string[]
 *   cover       可选（一般不用填，自动探测）
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const PACKS_DIR = join(ROOT, 'packs');
const OUT = join(ROOT, 'index.json');
const EXTS = new Set(['.mjs', '.js', '.cjs']);
const KINDS = ['tools', 'commands', 'hooks', 'inbound', 'outbound', 'botplay', 'ui'];
// ★ 2026-10-27：加了 'ui' —— 扩展包可以带自己的界面卡片（v1.11.0 起）。
//   ui/ 里是 .html/.css/.js，和代码扩展点不一样：它不走 import，只是静态资源。
// 2026-10-25 修：原来的 files 过滤只认 KINDS 目录 + 只收 .mjs/.js/.cjs，
//   于是 lib/（被 import 的共享代码）和 qqbot-pack.json / README / 封面全被漏掉。
//   症状：安装器按 index.json 的 files 下载 → 装出来的包缺 lib → 作者代码一 import 就崩。
const ROOT_FILES = new Set(['qqbot-pack.json', 'README.md', 'cover.png', 'preview.png', 'LICENSE']);
const SHARED_DIRS = new Set(['lib', 'docs', 'ui']);
/** 文档目录里允许分发的图片（README 引用的截图要能跟着包走，否则市场页和图都挂） */
const ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
/** ui/ 目录里允许的静态资源扩展名 */
const UI_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.svg']);
const COVER_RE = /^cover\.(png|jpe?g|webp|gif)$/i;

const REPO = process.env.GITHUB_REPOSITORY || 'zaofan-make/dsh-qqbot-plugins';
const BRANCH = process.env.GITHUB_REF_NAME || 'main';

function walkFiles(dir, base) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walkFiles(join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const plugins = [];
const problems = [];

let packDirs = [];
try {
  packDirs = readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
} catch {
  packDirs = [];
}

for (const id of packDirs.sort()) {
  const dir = join(PACKS_DIR, id);
  const manifestPath = join(dir, 'qqbot-pack.json');

  if (!existsSync(manifestPath)) {
    problems.push(id + ': 缺 qqbot-pack.json');
    continue;
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    problems.push(id + ': qqbot-pack.json 解析失败 - ' + (e && e.message));
    continue;
  }

  for (const k of ['name', 'author', 'version']) {
    if (!meta[k]) problems.push(id + ': 缺必填字段 ' + k);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    problems.push(id + ': 目录名只能用字母数字-_');
  }

  const all = walkFiles(dir, '');

  // 参与「安装」的文件（2026-10-25 修）
  //   旧规则：只收 KINDS 目录 + 只收 .mjs/.js/.cjs
  //   → 漏了 lib/ 里的共享代码，也漏了 qqbot-pack.json / README / 封面
  //   → 安装器按 files 下载，装出来的包是残的（proactive-companion v1.0.5 就栽在这）
  const files = all.filter((f) => {
    const segs = f.split('/');
    const top = segs[0];
    const ext = extname(f);
    // ① 包根文件：元数据 / 说明 / 封面，一律收
    if (segs.length === 1) return ROOT_FILES.has(top);
    // ② lib/ 等共享代码目录：脚本与 json 都收
    // ui/ 里是静态资源：.html / .css / .js 都要收，否则装出来是空卡片
    if (top === 'ui') return UI_EXTS.has(ext) || ext === '.json' || ASSET_EXTS.has(ext);
    if (SHARED_DIRS.has(top)) return EXTS.has(ext) || ext === '.json' || ASSET_EXTS.has(ext);
    // ③ 扩展点目录：仍只收脚本
    return KINDS.includes(top) && EXTS.has(ext);
  });
  if (files.length === 0) problems.push(id + ': 没有任何扩展文件（tools/ commands/ …）');

  // kinds 只统计扩展点目录 —— lib 不是扩展点，混进来会让面板把它当第七类
  const kinds = [...new Set(
    files.map((f) => f.split('/')[0]).filter((t) => KINDS.includes(t)),
  )];

  // 封面，三种来源（2026-10-26 主人要求支持外部图床）：
  //   ① manifest 里写 http(s) URL   → 原样用，不做任何镜像改写（作者自己挑的图床）
  //   ② manifest 里写包内文件名     → 转成仓库地址
  //   ③ 都没写                      → 自动探测 cover.png/jpg/webp/gif
  let cover = '';
  let coverIsUrl = false;
  const rawCover = meta.cover ? String(meta.cover).trim() : '';
  if (rawCover && /^https?:\/\//i.test(rawCover)) {
    cover = rawCover;
    coverIsUrl = true;
  } else if (rawCover && all.includes(rawCover)) {
    cover = rawCover;
  } else {
    const auto = all.find((f) => COVER_RE.test(f));
    if (auto) cover = auto;
  }

  const entry = {
    id,
    name: String(meta.name || id),
    author: String(meta.author || '未知'),
    version: String(meta.version || '0.0.0'),
    // 2026-10-25：扩展包可声明「需要的最低插件版本」，市场卡片据此对照当前插件版本
    ...(meta.minPluginVersion ? { minPluginVersion: String(meta.minPluginVersion) } : {}),
    description: String(meta.description || ''),
    repo: REPO,
    path: 'packs/' + id,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    kinds,
    files,
  };
  if (meta.homepage) entry.homepage = String(meta.homepage);
  if (cover) {
    entry.cover = coverIsUrl
      ? cover                                                        // 外部图床：原样保留
      : 'https://cdn.jsdelivr.net/gh/' + REPO + '@' + BRANCH + '/packs/' + id + '/' + cover;
  }

  plugins.push(entry);
}

const index = {
  version: 3,
  updated: new Date().toISOString().slice(0, 10),
  note: '本文件由 .github/workflows/build-index.yml 自动生成，请勿手改；新增插件只要在 packs/ 下建目录。',
  plugins,
};

writeFileSync(OUT, JSON.stringify(index, null, 2) + '\n', 'utf8');

console.log('✅ 已生成 index.json：' + plugins.length + ' 个插件');
for (const p of plugins) {
  console.log('   · ' + p.id + ' (' + p.files.length + ' 个文件, kinds=' + p.kinds.join(',') + (p.cover ? ', 有封面' : '') + ')');
}
if (problems.length) {
  console.log('');
  console.log('⚠️ 问题：');
  for (const p of problems) console.log('   - ' + p);
}
