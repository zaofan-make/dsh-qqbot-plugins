/**
 * bili_worker.mjs —— bili_grab 的后台干活子进程（放在 bili-tools/ 里，避免被当成扩展工具加载）
 *
 * 用法（宿主拼的命令）：
 *   node bili-tools/bili_worker.mjs '{"bvid":"BVxxxx","perSheet":12,"_outFile":".../xxx.json"}'
 *
 * 干完把结果写进 _outFile；宿主那边的定时器一发现文件就去 appendWake 叫醒会话。
 * 也能单独跑（调试用）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runBackgroundJob } from './bili_current.mjs';

const raw = process.argv[2] || '{}';
let payload;
try {
  payload = JSON.parse(raw);
} catch (e) {
  console.error('参数不是 JSON：', e);
  process.exit(2);
}

const r = await runBackgroundJob(payload);
if (payload._outFile) {
  try {
    mkdirSync(dirname(payload._outFile), { recursive: true });
    writeFileSync(payload._outFile, JSON.stringify(r), 'utf8');
  } catch (e) {
    console.error('写结果失败：', e);
  }
}
console.log(r?.msg || '');
process.exit(r?.ok ? 0 : 1);
