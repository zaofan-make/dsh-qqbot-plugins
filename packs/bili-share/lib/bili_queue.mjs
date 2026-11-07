/**
 * bili_queue.mjs —— B站抓取「单飞锁 + 最多排一个」小库（照 lib/nai_queue.mjs 的路子）
 *
 * 主人 2026-11-07 要求：同一时间只允一个视频在抓，后来的排队（最多排 1 个），
 * 前面的跑完自动接上。
 *
 * 状态文件：bili-tools/_jobs/job.json + queue.json
 *   job.json  → { id, pid, status, startedAt, args }
 *   queue.json→ [{ args, at }]（只是给人看的备份；运行中的队列在内存里）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 后台工人 */
export const WORKER = path.join(HERE, 'bili_worker.mjs');
/** 状态与结果都放这儿 */
export const DIR = path.join(HERE, '..', 'data', '_jobs');
export const JOB_FILE = path.join(DIR, 'job.json');
export const QUEUE_FILE = path.join(DIR, 'queue.json');

/** 最多排 1 个在屁股后面 */
export const QUEUE_LIMIT = 1;
/** 超过这个时间还没结果就算卡死，允许新任务上 */
const STALE_MS = 15 * 60 * 1000;

export function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
}

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(p, obj) {
  try {
    ensureDir();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** 当前有没有任务在跑（进程活着且在超时内） */
export function runningJob() {
  const j = readJson(JOB_FILE);
  if (!j || j.status !== 'running') return null;
  const fresh = Date.now() - Number(j.startedAt || 0) < STALE_MS;
  if (!pidAlive(j.pid) || !fresh) return null;
  return j;
}

export function clearJob(id) {
  const j = readJson(JOB_FILE);
  if (!j) return;
  if (id && j.id !== id) return;
  writeJson(JOB_FILE, { ...j, status: 'done', finishedAt: Date.now() });
}

export function readQueue() {
  const q = readJson(QUEUE_FILE);
  return Array.isArray(q) ? q : [];
}

export function writeQueue(list) {
  return writeJson(QUEUE_FILE, (list || []).slice(0, QUEUE_LIMIT));
}

/** 入队（满了返回 ok:false） */
export function queuePush(item) {
  const q = readQueue();
  if (q.length >= QUEUE_LIMIT) return { ok: false, size: q.length };
  q.push(item);
  writeQueue(q);
  return { ok: true, size: q.length };
}

export function queueShift() {
  const q = readQueue();
  if (!q.length) return null;
  const item = q.shift();
  writeQueue(q);
  return item;
}

/** 真起工人（写 job.json → spawn → 记 pid） */
export function startWorker(id, args, resFile) {
  ensureDir();
  const job = {
    id,
    status: 'starting',
    startedAt: Date.now(),
    pid: null,
    args,
    resultFile: resFile,
  };
  writeJson(JOB_FILE, job);

  const payload = JSON.stringify({ ...args, action: 'grab', _outFile: resFile });
  const ep = String(process.execPath || '');
  const isNode = /node(\.exe)?$/i.test(ep);
  const exe = isNode ? ep : ep || 'node';
  const childEnv = isNode ? { ...process.env } : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  let logFd = null;
  try { logFd = fs.openSync(path.join(DIR, id + '.log'), 'a'); } catch { /* ignore */ }

  const child = spawn(exe, [WORKER, payload], {
    detached: true,
    stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
    windowsHide: true,
    env: childEnv,
  });
  child.unref();

  const next = { ...job, status: 'running', pid: child.pid };
  writeJson(JOB_FILE, next);
  return { job: next, pid: child.pid };
}
