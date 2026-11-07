/**
 * bili_grab.mjs —— B站「字幕 + 抽帧拼长图」一把梭（纯 cookie，不开浏览器）
 *
 * 主人 2026-11-07 定的能力：
 *   · 输入 BV 号 / 完整链接 / b23.tv 短链 → 抓字幕（AI/UP）+ 智能抽帧拼长图
 *   · 顺手抓视频简介（info.md）
 *   · 跑在后台（spawn 工人），跑完用 env.appendWake 注入提醒
 *   · 单飞锁：同一时间只抓一个，后来的最多排一个（照 /生图 的做法）
 *
 * 产出：<tools>/bili-tools/_out/<BV号>/
 *   info.md / subtitle.md|txt|srt|json / frames/sheet_NN.jpg / video.m4s
 *
 * SESSDATA 来源优先级：环境变量 BILI_SESSDATA → sessdata.txt → 共用 bili_share.json
 *
 * 契约：export default { name, description, inputSchema, run(args, env) } → { ok, msg }
 */
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runningJob, queuePush, queueShift, startWorker, clearJob } from '../lib/bili_queue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 数据都落在扩展包自己的 data/ 下（跟着包走，卸载包就一起没了，干净） */
const DATA_DIR = join(HERE, '..', 'data');
const COOKIE_FILE = join(DATA_DIR, 'sessdata.txt');

/** 找插件的 .state（跟 bili_share 共用 SESSDATA）：从包目录往上找 .qqbot-extensions/.state */
function findSharedCookie() {
  let p = HERE;
  for (let i = 0; i < 6; i++) {
    p = dirname(p);
    for (const c of [
      join(p, '.qqbot-extensions', '.state', 'ext-config', 'bili_share.json'),
      join(p, '.state', 'ext-config', 'bili_share.json'),
    ]) {
      if (existsSync(c)) return c;
    }
  }
  return '';
}
const SHARED_COOKIE_FILE = findSharedCookie();
const JOB_DIR = join(DATA_DIR, '_jobs');
/** 所有产出统一落这里，清理时删这一个文件夹就够 */
const OUT_ROOT = join(DATA_DIR, '_out');
const KEEP_DIRS = 15;
const MAX_AGE_MS = 24 * 3600 * 1000;
const FFMPEG = 'D:/newwenjianjia/videocut/ffmpeg/bin/ffmpeg.exe';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';

// ── WBI 签名（/x/player/wbi/v2 必需）─────────────────────────────
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function mixinKey(orig) {
  return MIXIN_TAB.map((i) => orig[i] || '').join('').slice(0, 32);
}

async function wbiQuery(params, sessdata) {
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', sessdata);
  const wbi = nav?.data?.wbi_img || {};
  const imgKey = (wbi.img_url || '').split('/').pop().split('.')[0];
  const subKey = (wbi.sub_url || '').split('/').pop().split('.')[0];
  if (!imgKey || !subKey) throw new Error('拿不到 wbi keys');
  const key = mixinKey(imgKey + subKey);
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const sorted = Object.keys(all)
    .sort()
    .map((k) => [k, String(all[k]).replace(/[!'()*]/g, '')]);
  const query = new URLSearchParams(sorted).toString();
  const { createHash } = await import('node:crypto');
  const w_rid = createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

// ── HTTP ────────────────────────────────────────────────────────
function headers(sessdata) {
  const h = { 'User-Agent': UA, Referer: REF };
  if (sessdata) h.Cookie = `SESSDATA=${sessdata}`;
  return h;
}

async function getJson(url, sessdata, referer) {
  const h = headers(sessdata);
  if (referer) h.Referer = referer;
  const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 60)}`);
  return r.json();
}

function run(cmd, args, timeoutMs = 300000, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd: cwd || undefined });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      try { p.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: String(e) });
    });
  });
}

function ts(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`.replace('.', ',');
}

function parseBvid(s) {
  const m = String(s || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

/** 短链（b23.tv/xxx）→ 跟随一次 302，从 location 里抠 BV */
async function resolveBvid(input) {
  const s = String(input || '').trim();
  const direct = parseBvid(s);
  if (direct) return direct;
  const m = s.match(/https?:\/\/(?:b23\.tv|bili2233\.cn)\/[\w]+/i);
  if (!m) return '';
  try {
    const r = await fetch(m[0], {
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    return parseBvid(r.headers.get('location') || '');
  } catch {
    return '';
  }
}

/**
 * SESSDATA 优先级（主人 2026-11-07 确认：跟分享卡片的设置共享）：
 *   ① 面板里「B站分享」填的 SESSDATA（bili_share.json）—— 改了立刻生效
 *   ② 本工具 set_cookie 存的 data/sessdata.txt —— 面板没填时兜底
 *   ③ 环境变量 BILI_SESSDATA —— 调试用，压过一切
 */
function loadCookie() {
  if (process.env.BILI_SESSDATA) return process.env.BILI_SESSDATA.trim();
  if (SHARED_COOKIE_FILE) {
    try {
      const j = JSON.parse(readFileSync(SHARED_COOKIE_FILE, 'utf8'));
      const c = String(j.sessdata || j.SESSDATA || '').trim();
      if (c) return c;
    } catch { /* ignore */ }
  }
  try {
    const c = readFileSync(COOKIE_FILE, 'utf8').trim();
    if (c) return c;
  } catch { /* ignore */ }
  return '';
}

// ── 产出目录：滚动清理 ──────────────────────────────────────────
function dirSize(dir) {
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const st = statSync(p);
      total += st.isDirectory() ? dirSize(p) : st.size;
    }
  } catch { /* ignore */ }
  return total;
}

function dirsInOut() {
  if (!existsSync(OUT_ROOT)) return [];
  try {
    return readdirSync(OUT_ROOT)
      .filter((f) => {
        try {
          return statSync(join(OUT_ROOT, f)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((f) => {
        const p = join(OUT_ROOT, f);
        let mtime = 0;
        let size = 0;
        try {
          mtime = statSync(p).mtimeMs;
          size = dirSize(p);
        } catch { /* ignore */ }
        return { name: f, path: p, mtime, size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function pruneOut() {
  const keep = [];
  let removed = 0;
  const now = Date.now();
  for (const d of dirsInOut()) {
    const old = now - d.mtime > MAX_AGE_MS;
    const tooMany = keep.length >= KEEP_DIRS;
    if (old || tooMany) {
      try {
        rmSync(d.path, { recursive: true, force: true });
        removed++;
      } catch { /* ignore */ }
    } else {
      keep.push(d);
    }
  }
  return removed;
}

function clearOut() {
  const dirs = dirsInOut();
  for (const d of dirs) {
    try {
      rmSync(d.path, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  return dirs.length;
}

/** 清空目录内容（删不掉的跳过，后面同名文件会覆盖） */
function cleanDir(dir) {
  mkdirSync(dir, { recursive: true });
  try {
    for (const f of readdirSync(dir)) {
      try {
        rmSync(join(dir, f), { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ── 主体流程 ────────────────────────────────────────────────────
async function grab(bvid, opts = {}, log = () => {}) {
  const sessdata = opts.cookie || loadCookie();
  const out = opts.outDir || join(OUT_ROOT, bvid);
  mkdirSync(out, { recursive: true });

  const result = {
    bvid,
    loggedIn: !!sessdata,
    out,
    title: '',
    duration: 0,
    subtitle: null,
    frameCount: 0,
  };

  // 1) cid
  const pg = await getJson(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, sessdata);
  if (pg.code !== 0 || !pg.data?.length) throw new Error(`pagelist 失败 ${pg.code} ${pg.message || ''}`);
  const page = pg.data[0];
  const cid = page.cid;
  result.duration = page.duration || 0;
  log(`cid=${cid} 时长=${result.duration}s 分P=${page.part || '-'}`);

  // 2) 标题 / UP主 / 简介（简介里常有游戏名、版本、补丁、链接，必须留）
  try {
    const vw = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, sessdata);
    if (vw.code === 0) {
      const d = vw.data || {};
      result.title = d.title || '';
      result.owner = d?.owner?.name || '';
      result.desc = String(d.desc || '').trim();
      result.pubdate = d.pubdate || 0;
      result.stat = {
        view: d?.stat?.view ?? 0,
        like: d?.stat?.like ?? 0,
        coin: d?.stat?.coin ?? 0,
        favorite: d?.stat?.favorite ?? 0,
      };
      if (d.duration) result.duration = d.duration;
      const pub = result.pubdate ? new Date(result.pubdate * 1000).toLocaleString('zh-CN') : '';
      writeFileSync(
        join(out, 'info.md'),
        [
          `# ${result.title || bvid}`,
          '',
          `- BV：${bvid}`,
          `- UP 主：${result.owner || '-'}`,
          `- 时长：${result.duration}s`,
          `- 发布：${pub || '-'}`,
          `- 播放/点赞/投币/收藏：${result.stat.view} / ${result.stat.like} / ${result.stat.coin} / ${result.stat.favorite}`,
          '',
          '## 简介',
          '',
          result.desc || '（这个视频没写简介）',
          '',
        ].join('\n'),
        'utf8',
      );
    }
  } catch { /* 拿不到不影响主流程 */ }

  // 3) 字幕
  if (opts.subtitle !== false) {
    try {
      const q = await wbiQuery({ bvid, cid }, sessdata);
      const j = await getJson(
        `https://api.bilibili.com/x/player/wbi/v2?${q}`,
        sessdata,
        `https://www.bilibili.com/video/${bvid}`,
      );
      const subs = j?.data?.subtitle?.subtitles || [];
      log(`字幕条数=${subs.length}`);
      if (subs.length) {
        const pick = subs.find((s) => /zh/i.test(s.lan || '')) || subs[0];
        let u = pick.subtitle_url || '';
        if (u.startsWith('//')) u = 'https:' + u;
        const body = (await getJson(u, sessdata)).body || [];
        const base = join(out, 'subtitle');
        writeFileSync(base + '.json', JSON.stringify({ lan: pick.lan, body }, null, 1), 'utf8');
        writeFileSync(
          base + '.srt',
          body.map((l, i) => `${i + 1}\n${ts(l.from)} --> ${ts(l.to)}\n${l.content}\n`).join('\n'),
          'utf8',
        );
        writeFileSync(base + '.txt', body.map((l) => l.content).join('\n'), 'utf8');
        writeFileSync(
          base + '.md',
          `# ${result.title || bvid}\n\n` + body.map((l) => `[${Math.floor(l.from)}s] ${l.content}`).join('\n'),
          'utf8',
        );
        result.subtitle = {
          lan: pick.lan,
          lanDoc: pick.lan_doc || '',
          count: body.length,
          files: ['subtitle.md', 'subtitle.txt', 'subtitle.srt', 'subtitle.json'],
          preview: body.slice(0, 5).map((l) => `[${Math.floor(l.from)}s] ${l.content}`),
        };
      }
    } catch (e) {
      log('字幕失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // 4) 抽帧
  if (opts.frames !== false) {
    const qn = String(opts.qn || 32);
    const pu = await getJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=16&fourk=0`,
      sessdata,
    );
    if (pu.code !== 0) throw new Error(`playurl 失败 ${pu.code} ${pu.message || ''}`);
    const dash = pu.data?.dash;
    if (!dash?.video?.length) throw new Error('没有 dash 流（大会员/付费内容？）');

    const step = Math.max(1, Number(opts.step) || 10);
    const maxSec = Number(opts.maxSeconds) || 0;
    const frameMode = String(opts.frameMode || 'scene');
    const framesDir = join(out, 'frames');
    cleanDir(framesDir);

    const vurl = dash.video[0].baseUrl || dash.video[0].base_url;
    const mediaPath = join(out, 'video.m4s');

    if (frameMode === 'interval') {
      const args = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-headers', `Referer: ${REF}\r\nUser-Agent: ${UA}\r\n`,
      ];
      if (maxSec > 0) args.push('-t', String(maxSec));
      args.push('-i', vurl, '-vf', `fps=1/${step}`, '-q:v', '3', join(framesDir, 'f%03d.jpg'));
      log(`抽帧中（匀速每 ${step}s 一张，远程直读）…`);
      let r = await run(FFMPEG, args, Number(opts.timeoutMs) || 240000);
      if (r.code !== 0 || !existsSync(framesDir) || readdirSync(framesDir).length === 0) {
        log('远程直读失败，改下载 m4s…');
        await download(vurl, mediaPath, sessdata);
        const args2 = ['-y', '-hide_banner', '-loglevel', 'error'];
        if (maxSec > 0) args2.push('-t', String(maxSec));
        args2.push('-i', mediaPath, '-vf', `fps=1/${step}`, '-q:v', '3', join(framesDir, 'f%03d.jpg'));
        r = await run(FFMPEG, args2, 180000);
        if (r.code !== 0) throw new Error('抽帧失败：' + r.err.slice(-300));
      }
    } else {
      if (!existsSync(mediaPath) || statSync(mediaPath).size < 1024) {
        log('下载视频流（用于场景分析）…');
        await download(vurl, mediaPath, sessdata);
      }
      let vw = dash.video[0].width || 0;
      let vh = dash.video[0].height || 0;
      if (!vw || !vh) {
        const probe = await run(FFMPEG, ['-hide_banner', '-i', mediaPath], 20000);
        const mm = /(\d{2,5})x(\d{2,5})/.exec(probe.err || '');
        if (mm) {
          vw = Number(mm[1]);
          vh = Number(mm[2]);
        }
      }
      log(`画面 ${vw}x${vh}${vh > vw ? '（竖屏→1列）' : '（横屏→2列）'}`);
      const sheets = await buildSceneSheets(
        mediaPath,
        framesDir,
        {
          perSheet: opts.perSheet,
          cols: opts.cols,
          maxGap: opts.maxGap,
          cut: opts.cut,
          minGap: opts.minGap,
          duration: result.duration,
          maxSeconds: maxSec,
          width: vw,
          height: vh,
        },
        log,
      );
      result.sheets = sheets.sheets;
      result.frameTimes = sheets.times;
      result.frameCount = sheets.times.length;
      result.framesDir = framesDir;
      result.cutPoints = sheets.cuts;
    }

    const files = existsSync(framesDir)
      ? readdirSync(framesDir).filter((f) => /\.jpe?g$/i.test(f)).sort().map((f) => join(framesDir, f))
      : [];
    if (!result.frameCount) result.frameCount = files.length;
    if (!result.frames || !result.frames.length) result.frames = files.slice(0, 40);
    log(`抽帧完成 ${result.frameCount} 张${result.sheets ? `，拼成 ${result.sheets.length} 张长图` : ''}`);
  }

  result.ok = true;
  return result;
}

async function download(url, path, sessdata) {
  const r = await fetch(url, { headers: headers(sessdata), signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(path, buf);
  return buf.length;
}

// ── 智能抽帧 ────────────────────────────────────────────────────
/**
 * 画面变动怎么判：ffmpeg 的 scene 指标 = 当前帧与上一帧的不相似度（0 一样，1 全不同）
 * 阈值经验：0.2 抖动/闪光全进来；0.3 激进；0.4 平衡；0.5 只抓硬切
 * 这里默认 cut=0.35，再用「最长 8 秒强制补一帧」兜住静止画面
 */
async function analyzeScenes(media, work, log) {
  const p = join(work, 'scenes.txt');
  try { if (existsSync(p)) rmSync(p, { force: true }); } catch { /* ignore */ }
  const r = await run(
    FFMPEG,
    [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', media, '-an',
      '-vf', "fps=1,select='gte(scene,0)',metadata=print:file=scenes.txt",
      '-f', 'null', '-',
    ],
    600000,
    work,
  );
  if (!existsSync(p)) {
    log('场景分析没出结果：' + (r.err || '').slice(-120));
    return [];
  }
  const raw = readFileSync(p, 'utf8');
  const samples = [];
  const re = /pts_time:([0-9.]+)[\s\S]*?scene_score=([0-9.]+)/g;
  let m;
  while ((m = re.exec(raw))) samples.push({ t: parseFloat(m[1]), score: parseFloat(m[2]) });
  return samples.sort((a, b) => a.t - b.t);
}

/** 抽一帧，左上角烧上「序号 + 时间戳」（失败退回无字版） */
async function extractFrame(media, t, dst, seq) {
  const label = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const txt = seq ? `${seq} ${label}` : label;
  const esc = txt.replace(/[:'\\]/g, (c) => '\\' + c);
  const vf =
    `scale=480:-1,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':` +
    `text='${esc}':x=10:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6`;
  let r = await run(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', media, '-frames:v', '1', '-vf', vf, dst],
    60000,
  );
  if (r.code !== 0 || !existsSync(dst)) {
    r = await run(
      FFMPEG,
      ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', media, '-frames:v', '1', '-vf', 'scale=480:-1', dst],
      60000,
    );
  }
  return r.code === 0 && existsSync(dst);
}

/** 两张图有多像（1=一模一样） */
async function ssim(a, b) {
  const r = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'info', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'],
    20000,
  );
  const m = /All:([0-9.]+)/.exec(r.err || '');
  return m ? parseFloat(m[1]) : 0;
}

async function buildSceneSheets(media, framesDir, opts, log) {
  const portrait = Number(opts.height) > Number(opts.width);
  const cols = Math.min(4, Math.max(1, Number(opts.cols) || (portrait ? 1 : 2)));
  const perSheet = Math.min(24, Math.max(2, Number(opts.perSheet) || (portrait ? 8 : 16)));
  const maxGap = Math.max(2, Number(opts.maxGap) || 8);
  const cut = Number(opts.cut) || 0.35;
  const minGap = Math.max(0.5, Number(opts.minGap) || 2);
  const limit = Number(opts.maxSeconds) || 0;

  const samples = await analyzeScenes(media, framesDir, log);
  if (!samples.length) return { sheets: [], times: [], cuts: [] };
  const avg = samples.reduce((s, x) => s + x.score, 0) / samples.length;
  log(`场景分析 ${samples.length} 个采样点，平均变动分 ${avg.toFixed(3)}`);

  // ① 选帧
  const picked = [];
  let last = -1e9;
  let lastIdx = 0;
  if (samples.length) {
    picked.push({ t: samples[0].t, score: samples[0].score, cut: true });
    last = samples[0].t;
    lastIdx = 1;
  }
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (limit && s.t > limit) break;
    const gap = s.t - last;
    const isCut = s.score >= cut;
    const win = samples.slice(lastIdx, i + 1);
    const avgScore = win.length ? win.reduce((a, x) => a + x.score, 0) / win.length : 0;
    const cap = avgScore < 0.02 ? Math.min(maxGap * 1.6, 12) : maxGap;
    if (gap >= cap || (isCut && gap >= minGap)) {
      picked.push({ t: s.t, score: s.score, cut: isCut });
      last = s.t;
      lastIdx = i + 1;
    }
  }

  // ①-2 长视频总量控制（照 storyboard 插件：人记住的是"大概"，帧不是越多越好）
  const dur = Number(opts.duration) || 0;
  const MAX_TOTAL = dur <= 180 ? 16 : dur <= 600 ? 40 : dur <= 1200 ? 56 : 72;
  let pickedFinal = picked;
  if (picked.length > MAX_TOTAL) {
    const stepK = picked.length / MAX_TOTAL;
    const out = [];
    let lastT = -1;
    for (let i = 0; i < MAX_TOTAL; i++) {
      const p = picked[Math.min(picked.length - 1, Math.floor(i * stepK))];
      if (!p || p.t === lastT) continue;
      out.push(p);
      lastT = p.t;
    }
    pickedFinal = out;
    log(`帧数超上限，${picked.length} → ${pickedFinal.length} 帧`);
  }
  const cuts = pickedFinal.filter((p) => p.cut).map((p) => Math.round(p.t));
  log(`选中 ${pickedFinal.length} 帧（硬切 ${cuts.length} 处）`);

  // ② 抽到 raw/，再用 SSIM 剔掉几乎一样的邻帧
  const rawDir = join(framesDir, 'raw');
  cleanDir(rawDir);
  const kept = [];
  for (const p of pickedFinal) {
    const f = join(rawDir, String(kept.length + 1).padStart(4, '0') + '.jpg');
    if (!(await extractFrame(media, p.t, f, kept.length + 1))) continue;
    if (kept.length) {
      const sim = await ssim(kept[kept.length - 1].file, f);
      if (sim >= 0.97) {
        try { rmSync(f, { force: true }); } catch { /* ignore */ }
        continue;
      }
    }
    kept.push({ t: p.t, file: f, cut: p.cut });
  }
  const dupRemoved = pickedFinal.length - kept.length;
  if (dupRemoved) log(`去掉 ${dupRemoved} 张几乎重复的帧（SSIM≥0.97）`);

  // ③ 均匀分组
  const total = kept.length;
  if (!total) return { sheets: [], times: [], cuts };
  const sheetCount = Math.max(1, Math.ceil(total / perSheet));
  const per = Math.ceil(total / sheetCount);
  const groups = [];
  for (let start = 0; start < total; ) {
    const end = Math.min(total, start + per);
    groups.push(kept.slice(start, end));
    start = end;
  }

  // ④ 每组拼长图
  const sheets = [];
  const times = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const dir = join(framesDir, 'sheet_' + String(gi + 1).padStart(2, '0'));
    cleanDir(dir);
    let idx = 0;
    for (const p of g) {
      idx++;
      try {
        copyFileSync(p.file, join(dir, String(idx).padStart(4, '0') + '.jpg'));
        times.push(p.t);
      } catch { /* ignore */ }
    }
    if (!idx) continue;

    // 二重细分：这一段帧越密（快节奏），格子切得越细（3 列 + 整图缩小）
    const gapAvg = idx > 1 ? (g[idx - 1].t - g[0].t) / (idx - 1) : 99;
    const gCols = portrait ? 1 : gapAvg < 4 ? 3 : cols;
    const gRows = Math.ceil(idx / gCols);
    const lastFile = join(dir, String(idx).padStart(4, '0') + '.jpg');
    for (let k = idx + 1; k <= gCols * gRows; k++) {
      try { copyFileSync(lastFile, join(dir, String(k).padStart(4, '0') + '.jpg')); } catch { /* ignore */ }
    }
    const sheetPath = join(framesDir, 'sheet_' + String(gi + 1).padStart(2, '0') + '.jpg');
    const tileVf =
      `tile=${gCols}x${gRows}:padding=6:margin=6:color=0x141414` + (gCols >= 3 ? ',scale=1100:-1' : '');
    const r = await run(
      FFMPEG,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', join(dir, '%04d.jpg'), '-vf', tileVf, '-frames:v', '1', '-q:v', '3', sheetPath],
      120000,
    );
    if (r.code === 0 && existsSync(sheetPath)) {
      sheets.push({ file: sheetPath, frames: g.length, from: Math.round(g[0].t), to: Math.round(g[g.length - 1].t) });
    } else {
      log(`第 ${gi + 1} 张拼图失败：${(r.err || '').slice(-120)}`);
    }
  }
  return { sheets, times, cuts };
}

// ── 同步干活 ────────────────────────────────────────────────────
async function doGrab(args) {
  const pruned = pruneOut();
  const bv = (await resolveBvid(args?.bvid)) || String(args?.bvid || '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) {
    return { ok: false, msg: 'BV 号不对（要 BV + 10 位字母数字，或直接给视频链接/短链）' };
  }
  const logs = [];
  try {
    const r = await grab(
      bv,
      {
        cookie: args?.cookie,
        step: args?.step,
        qn: args?.qn,
        maxSeconds: args?.maxSeconds,
        subtitle: args?.subtitle,
        frames: args?.frames,
        frameMode: args?.frameMode,
        perSheet: args?.perSheet,
        cols: args?.cols,
        maxGap: args?.maxGap,
        cut: args?.cut,
        minGap: args?.minGap,
      },
      (m) => logs.push(m),
    );

    const maxFrames = Math.max(1, Number(args?.maxFrames) || 12);
    const L = [];
    L.push(`✅ ${r.bvid} 抓完了`);
    if (pruned > 0) L.push(`（顺手清了 ${pruned} 个过期产出）`);
    if (r.title) L.push(`标题：${r.title}`);
    if (r.owner) L.push(`UP 主：${r.owner}${r.stat ? `　播放 ${r.stat.view}` : ''}`);
    L.push(`时长：${r.duration}s　输出：${r.out}`);
    if (r.desc) {
      const d1 = r.desc.replace(/\s+/g, ' ').trim();
      L.push(`简介：${d1.slice(0, 400)}${d1.length > 400 ? '…（全文在 info.md）' : ''}`);
    } else {
      L.push('简介：（视频没写简介）');
    }
    if (r.subtitle) {
      L.push(`字幕：${r.subtitle.lanDoc || r.subtitle.lan} ${r.subtitle.count} 条 → subtitle.md / .txt / .srt / .json`);
      if (r.subtitle.preview.length) {
        L.push('开头预览：');
        for (const p of r.subtitle.preview) L.push('  ' + p);
      }
    } else {
      L.push(`字幕：没拿到${r.loggedIn ? '（该视频可能确实没字幕）' : ' —— 没存 SESSDATA，AI 字幕必须有登录态'}`);
    }
    if (r.sheets && r.sheets.length) {
      L.push(`长图：${r.sheets.length} 张（每张 ${r.sheets[0]?.frames || 0} 帧，共 ${r.frameCount} 帧）`);
      for (const s of r.sheets) L.push(`  sheet ${s.from}s~${s.to}s → ${s.file}`);
    } else if (r.frameCount) {
      L.push(`抽帧：${r.frameCount} 张 → ${r.framesDir}`);
      for (const f of r.frames.slice(0, maxFrames)) L.push('  ' + f);
    }
    if (r.cutPoints && r.cutPoints.length) {
      L.push(`检测到硬切点：${r.cutPoints.slice(0, 20).join('s, ')}s`);
    }
    return { ok: true, msg: L.join('\n'), data: r };
  } catch (e) {
    return {
      ok: false,
      msg: `抓取失败：${e instanceof Error ? e.message : String(e)}\n过程日志：\n${logs.join('\n')}`,
    };
  }
}

/** 工人侧入口（bili_worker.mjs 调它） */
export async function runBackgroundJob(payload) {
  const args = { ...payload };
  delete args._outFile;
  const r = await doGrab(args);
  if (payload._outFile) {
    try {
      mkdirSync(dirname(payload._outFile), { recursive: true });
      writeFileSync(payload._outFile, JSON.stringify(r), 'utf8');
    } catch { /* ignore */ }
  }
  return r;
}

// ── 后台：单飞锁 + 最多排一个 ───────────────────────────────────
const PENDING = [];

function startBackgroundJob(args, env) {
  const running = runningJob();
  if (running) {
    const q = queuePush({ id: running.id, args, at: Date.now() });
    if (!q.ok) {
      return { ok: false, msg: `现在正抓着一个视频（编号 ${running.id}），后面已经排了一个了，等它跑完再来吧` };
    }
    PENDING.push({ args, env });
    return { ok: true, msg: `⏳ 现在正抓着一个（编号 ${running.id}），你这个排上了，前面跑完自动接上` };
  }
  return launchJob(args, env);
}

function launchJob(args, env) {
  const id = 'bili-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const resFile = join(JOB_DIR, id + '.json');
  try {
    startWorker(id, args, resFile);
  } catch (e) {
    return {
      ok: false,
      msg: '后台任务起不来：' + (e instanceof Error ? e.message : String(e)) + '（可加 sync=true 同步跑）',
    };
  }
  watchJob(id, resFile, env);
  return {
    ok: true,
    msg: `⏳ 已在后台开抓（编号 ${id}），跑完会自动叫你一声\n产出：扩展包 data/_out/<BV号>/`,
    data: { jobId: id, resultFile: resFile },
  };
}

function watchJob(id, resFile, env) {
  const t0 = Date.now();
  let done = false;
  const finish = (text) => {
    if (done) return;
    done = true;
    try { env?.appendWake?.(text); } catch { /* ignore */ }
    try { clearJob(id); } catch { /* ignore */ }
    try { queueShift(); } catch { /* ignore */ }
    const next = PENDING.shift();
    if (next) launchJob(next.args, next.env);
  };

  const timer = setInterval(() => {
    if (Date.now() - t0 > 20 * 60 * 1000) {
      clearInterval(timer);
      finish(`[bili后台任务 ${id}] 超过 20 分钟没结果，可能失败了，去看看 _jobs 目录`);
      return;
    }
    if (!existsSync(resFile)) return;
    clearInterval(timer);
    let r;
    try {
      r = JSON.parse(readFileSync(resFile, 'utf8'));
    } catch {
      return;
    }
    finish(
      r?.ok
        ? `[bili后台任务 ${id} 完成了]\n${r.msg}\n（要发图就从这个结果里的路径取）`
        : `[bili后台任务 ${id} 失败了]\n${r?.msg || '没拿到原因'}`,
    );
  }, 3000);
  if (typeof timer.unref === 'function') timer.unref();
}

// ── 工具导出 ────────────────────────────────────────────────────
export default {
  name: 'bili_grab',
  description:
    'B站「字幕+抽帧长图」一把梭，纯 cookie 不走浏览器：给 BV 号/链接/短链 → 抓字幕(md/txt/srt)+简介(info.md)+按画面变动抽帧拼长图。默认丢后台，跑完自动注入提醒；单飞锁，同时只抓一个。',
  inputSchema: {
    action: {
      type: 'string',
      enum: ['grab', 'set_cookie', 'show_cookie', 'cookie_help', 'info', 'clear'],
      description:
        'grab(默认)=抓取；set_cookie=保存 SESSDATA；show_cookie=看有没有存；cookie_help=教怎么拿 cookie；info=看产出目录与占用；clear=清空全部产出',
    },
    bvid: { type: 'string', description: 'BV 号 / 视频完整 URL / b23.tv 短链' },
    cookie: { type: 'string', description: 'SESSDATA 值（临时用，存下来用 set_cookie）' },
    sync: {
      type: 'boolean',
      description: 'false(默认)=丢后台跑，跑完自动提醒；true=当场等结果（命令里用）',
    },
    step: { type: 'number', description: '匀速模式抽帧间隔秒数，默认 10' },
    frameMode: {
      type: 'string',
      enum: ['scene', 'interval'],
      description: 'scene(默认)=按画面变动挑帧并拼长图；interval=老式匀速抽帧',
    },
    perSheet: { type: 'number', description: '一张长图最多拼几帧，默认 16（竖屏 8），上限 24' },
    cols: { type: 'number', description: '长图列数，默认横屏 2 / 竖屏 1（行数自动算）' },
    maxGap: { type: 'number', description: '最长多少秒必须补一帧，默认 8' },
    cut: { type: 'number', description: '画面大变动阈值 0~1，默认 0.35' },
    minGap: { type: 'number', description: '两次选帧最少隔几秒，默认 2' },
    qn: { type: 'number', description: '清晰度 32=480P(默认) 64=720P 80=1080P' },
    maxSeconds: { type: 'number', description: '只处理前 N 秒（默认 0=全片）' },
    maxFrames: { type: 'number', description: '返回给对话的帧路径最多几个，默认 12' },
    subtitle: { type: 'boolean', description: '是否抓字幕，默认 true' },
    frames: { type: 'boolean', description: '是否抽帧，默认 true' },
  },

  run: async (args, env) => {
    const action = String(args?.action || 'grab');

    if (action === 'cookie_help') {
      return {
        ok: true,
        msg: [
          'SESSDATA 怎么拿（1 分钟）：',
          '1. 电脑 Chrome 打开 bilibili.com，确认已登录',
          '2. 按 F12 → 顶部选 Application（应用）',
          '3. 左侧 Cookies → https://www.bilibili.com',
          '4. 找 SESSDATA 那一行，双击 Value 全选复制（很长，常带 %2C）',
          '5. bili_grab action=set_cookie cookie=<粘贴值>',
          '存到：' + COOKIE_FILE,
          '之后直接给 BV 号就能抓 AI 字幕（不清一直有效）',
        ].join('\n'),
      };
    }

    if (action === 'set_cookie') {
      const c = String(args?.cookie || '').trim();
      if (!c) return { ok: false, msg: '没给 cookie 值，用法：action=set_cookie cookie=<SESSDATA>' };
      const clean = c.replace(/^SESSDATA=/i, '').replace(/["']/g, '').trim();
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(COOKIE_FILE, clean + '\n', 'utf8');
      let who = '';
      try {
        const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', clean);
        who = nav?.data?.isLogin ? `已登录：${nav.data.uname}` : 'cookie 无效或已过期（仍存下了）';
      } catch (e) {
        who = '验证失败：' + (e instanceof Error ? e.message : String(e));
      }
      return { ok: true, msg: `SESSDATA 已保存到 ${COOKIE_FILE}\n${who}` };
    }

    if (action === 'show_cookie') {
      const c = loadCookie();
      return {
        ok: true,
        msg: c
          ? `已存 SESSDATA（长度 ${c.length}，尾部 …${c.slice(-8)}）`
          : '还没存 cookie，先 action=set_cookie（不知道哪拿就问 cookie_help）',
      };
    }

    if (action === 'info') {
      const dirs = dirsInOut();
      const total = dirs.reduce((s, d) => s + d.size, 0);
      const L = [`产出目录：${OUT_ROOT}`, `现有 ${dirs.length} 个视频目录，共 ${(total / 1048576).toFixed(1)} MB`];
      for (const d of dirs.slice(0, 10)) {
        L.push(`  ${d.name}　${(d.size / 1048576).toFixed(1)}MB　${new Date(d.mtime).toLocaleString('zh-CN')}`);
      }
      L.push('清理：action=clear（或命令 /扒b站 清理）；超过 24 小时或超过 15 个会自动删最旧的');
      return { ok: true, msg: L.join('\n') };
    }

    if (action === 'clear') {
      const n = clearOut();
      return { ok: true, msg: `已清空 ${OUT_ROOT}，删掉 ${n} 个视频目录` };
    }

    const sync = args?.sync === true || typeof env?.appendWake !== 'function';
    if (sync) return doGrab(args);
    return startBackgroundJob(args, env);
  },
};
