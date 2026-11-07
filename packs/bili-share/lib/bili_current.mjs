/**
 * bili_current.mjs —— 后台工人到底跑哪个版本，只看这一个文件
 *
 * 为什么单独抽一层：宿主对**同名工具**不做热替换（主人 2026-11-07 提醒），
 * 所以每次改算法都要改个名字（bili_grab4 → bili_grab5 …）。
 * 但 lib/bili_worker.mjs 是常驻的，如果它硬写着某个版本，
 * 改了工具不生效（踩过一次：后台永远跑旧代码）。
 * ⇒ 这里只留一行 re-export，升级版本时**只改这一行**。
 */
export * from '../tools/bili_grab.mjs';
