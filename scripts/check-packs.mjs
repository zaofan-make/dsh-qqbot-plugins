#!/usr/bin/env node
/**
 * check-packs.mjs — PR 校验（由 .github/workflows/check-pack.yml 调用）
 *
 * 用法：node scripts/check-packs.mjs [dir1 dir2 ...]
 *   不给参数 = 校验 packs/ 下全部
 *
 * 为什么用 node 而不是 shell 写（2026-10-24 踩坑）：
 *   Actions 的 run 默认是 `bash -e`，而 `[ -z "$x" ] && continue` 这种写法
 *   在条件为假时返回 1，会直接把整个 step 判失败 ——
 *   校验逻辑根本没跑，却报「校验失败」。这类逻辑放 node 里最稳。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const PACKS_DIR = join(ROOT, 'packs');
const EXTS = new Set(['.mjs', '.js', '.cjs']);
const KINDS = ['tools', 'commands', 'hooks', 'inbound', 'outbound', 'botplay'];
const BANNED = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.so', '.dylib', '.msi', '.scr']);
const MAX_BYTES = 2 * 1024 * 1024;

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

function walk(dir, base = '') {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = base ? base + '/' + e.name : e.name;
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else if (e.isFile()) out.push({ rel, abs });
  }
  return out;
}

// ── 目标目录 ──
let targets = process.argv.slice(2).map((s) => s.replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
if (targets.length === 0) {
  try {
    targets = readdirSync(PACKS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => 'packs/' + e.name);
  } catch { targets = []; }
}
// 只认 packs/<id> 这一层
targets = [...new Set(targets.filter((t) => /^packs\/[^/]+$/.test(t)))].sort();

if (targets.length === 0) {
  console.log('（本次没有涉及 packs/<id> 目录，跳过）');
  process.exit(0);
}

console.log('检查 ' + targets.length + ' 个目录：' + targets.join(', '));
console.log('');

for (const rel of targets) {
  const id = rel.split('/')[1];
  const dir = join(ROOT, rel);
  console.log('【' + id + '】');

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    err(id + ': 目录不存在');
    continue;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    err(id + ': id 只能用字母数字-_（它同时是安装后的目录名）');
  }

  // ① manifest
  const mf = join(dir, 'qqbot-pack.json');
  if (!existsSync(mf)) {
    err(id + ': 缺 qqbot-pack.json');
  } else {
    let m = null;
    try { m = JSON.parse(readFileSync(mf, 'utf8')); }
    catch (e) { err(id + ': qqbot-pack.json 解析失败 - ' + (e && e.message)); }
    if (m) {
      for (const k of ['name', 'author', 'version']) {
        if (!m[k]) err(id + ': 缺必填字段 ' + k);
      }
      if (m.version && !/^\d+\.\d+\.\d+/.test(String(m.version))) {
        warn(id + ': version 建议用 x.y.z（现在 ' + m.version + '）');
      }
      if (m.tags && !Array.isArray(m.tags)) err(id + ': tags 必须是数组');
    }
  }

  // ② 文件清单
  const all = walk(dir);
  if (all.length === 0) err(id + ': 目录是空的');

  const scripts = all.filter((f) => KINDS.includes(f.rel.split('/')[0]) && EXTS.has(extname(f.rel)));
  const kinds = [...new Set(scripts.map((f) => f.rel.split('/')[0]))];
  if (scripts.length === 0) {
    err(id + ': 没有任何扩展文件（tools/*.mjs、commands/*.mjs 之类）');
  }

  // ③ 二进制 / 超大
  for (const f of all) {
    const ext = extname(f.rel).toLowerCase();
    if (BANNED.has(ext)) err(id + ': 不许带可执行文件 ' + f.rel);
    let size = 0;
    try { size = statSync(f.abs).size; } catch {}
    if (size > MAX_BYTES) err(id + ': ' + f.rel + ' 超过 2MB（' + (size / 1048576).toFixed(1) + 'MB）');
  }

  // ④ 语法
  for (const f of scripts) {
    try {
      execFileSync(process.execPath, ['--check', f.abs], { stdio: 'pipe' });
    } catch (e) {
      const out = String((e && e.stderr) || (e && e.message) || e).split('\n').slice(0, 4).join('\n');
      err(id + ': 语法错误 ' + f.rel + '\n      ' + out.replace(/\n/g, '\n      '));
    }
  }

  // ⑤ 参数定义形状必须是「扁平字段表」（2026-10-25 改，起因 PR #2）
  //
  //   ⚠️ 更正一次：`parameters` 是 **合法别名**，不要拦它。
  //   dsh 归一化时是 `obj.inputSchema ?? obj.parameters ?? {}`（src/features/extension-store.ts:225），
  //   所以两者都认，只是值必须是扁平字段表。
  //
  //   真正会坏的是「包成标准 JSON Schema」：
  //     { type: 'object', properties: { action: {...} } }
  //   dsh 取到的是整个对象，然后拿它的**顶层键**当参数名
  //   → 模型看到的参数是 type / properties，真正的 action 藏在里面看不见。
  for (const f of scripts) {
    let src = '';
    try { src = readFileSync(f.abs, 'utf8'); } catch { continue; }
    const top = f.rel.split('/')[0];
    if (top !== 'tools' && top !== 'commands') continue;

    // 允许 { 之后换行；只往前看 80 字符，避免误匹配整个文件
    const wrapped = /(?:inputSchema|parameters)\s*:\s*\{[\s\S]{0,80}?type\s*:\s*['"]object['"]/;
    if (wrapped.test(src)) {
      err(
        id + ': ' + f.rel + ' 的参数定义包成了标准 JSON Schema\n' +
        '      dsh 只认扁平写法：inputSchema: { 属性名: { type, description } }\n' +
        '      包了 type/object 之后，dsh 会把 type 和 properties 当成参数名，\n' +
        '      真正的字段全藏在 properties 里 → 模型看不到、调不动'
      );
    }
  }

  // ⑥ 命令/工具的基本契约
  for (const f of scripts) {
    let src = '';
    try { src = readFileSync(f.abs, 'utf8'); } catch { continue; }
    const top = f.rel.split('/')[0];
    if (top === 'tools') {
      if (!/name\s*:/.test(src)) warn(id + ': ' + f.rel + ' 没看到 name 字段');
      // 兼容两种合法写法：属性 `run: async (args, env) => {}` 与方法简写 `async run(args, env) {}`
      // （2026-10-29：原来只认冒号写法，把合法的简写误判成"缺 run"——bili-share 就是这么被拦的；
      //   与 commands 的 handler 检查保持同一套判据）
      if (!/(?:^|[\s,{])(?:async\s+)?run\s*[:(]/m.test(src)) {
        err(id + ': ' + f.rel + ' 缺 run 函数（工具契约要求 run）');
      }
    } else if (top === 'commands') {
      if (!/name\s*:/.test(src)) warn(id + ': ' + f.rel + ' 没看到 name 字段');
      // 兼容两种合法写法：属性 `handler: async (ctx) => {}` 与方法简写 `async handler(ctx) {}`
      // （2026-10-26：原来只认冒号写法，把合法的简写误判成"缺 handler"）
      if (!/(?:^|[\s,{])(?:async\s+)?handler\s*[:(]/m.test(src)) {
        err(id + ': ' + f.rel + ' 缺 handler 函数（命令契约要求 handler，不是 run）');
      }
    }
  }

  const cover = all.find((f) => /^cover\.(png|jpe?g|webp|gif)$/i.test(f.rel));
  console.log('   文件 ' + all.length + ' 个 / 扩展脚本 ' + scripts.length + ' 个 / 类型 ' + (kinds.join(',') || '-') + ' / 封面 ' + (cover ? cover.rel : '无'))
}

console.log('');
if (warns.length) {
  console.log('⚠️ 提醒（不阻断）：');
  for (const w of warns) console.log('   - ' + w);
  console.log('');
}
if (errors.length) {
  console.log('❌ 发现 ' + errors.length + ' 个问题：');
  for (const e of errors) console.log('   - ' + e);
  process.exit(1);
}
console.log('✅ 全部通过');
