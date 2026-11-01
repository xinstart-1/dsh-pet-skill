/**
 * QQ 模块的基础工具。
 *
 * 通用件（原子写、读 JSON、`$DSH_HOME`）直接复用抖音那份实现——它们要保证的语义完全一样，
 * 复制一份只会让两边早晚分叉。日志单独实现，因为要打自己的标签（`[dsh-pet-qq]`）。
 *
 * @module dsh-pet-qq/util
 */
import { appendFile } from 'node:fs/promises';

export { dateKey, dshHome, readJson, stamp, writeJsonAtomic } from '../douyin/util.js';

/**
 * 日志器：内存环形缓冲（给设置页看）+ 追加文件 + 控制台。
 * @param {{file: string, capacity?: number, tag?: string}} opts 选项
 * @returns {{info: Function, warn: Function, error: Function, list: Function, file: string}} 日志器
 */
export function createLog({ file, capacity = 300, tag = 'dsh-pet-qq' }) {
  const ring = [];
  let fileBroken = false;
  const write = (level, msg) => {
    const text = String(msg ?? '');
    const entry = { t: Date.now(), level, msg: text };
    ring.push(entry);
    if (ring.length > capacity) ring.shift();
    const line = `[${new Date(entry.t).toISOString()}] ${level.toUpperCase()} ${text}\n`;
    if (!fileBroken) {
      void appendFile(file, line, 'utf8').catch(() => {
        // 目录不可写时别每条都失败一次
        fileBroken = true;
      });
    }
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(`[${tag}] ${text}`);
  };
  return {
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
    list: () => ring.slice().reverse(),
    file,
  };
}

/**
 * 睡一会儿。
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 完成
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 区间内随机整数（用于"回复前等一会儿"）。
 * @param {[number, number]} range 毫秒区间
 * @returns {number} 毫秒
 */
export function randomDelay(range) {
  const [lo, hi] = Array.isArray(range) ? range : [0, 0];
  const a = Math.max(0, Number(lo) || 0);
  const b = Math.max(a, Number(hi) || a);
  return a + Math.floor(Math.random() * (b - a + 1));
}

/**
 * 把一段文字按句子切成若干条（QQ 里一坨长段落太假）。
 *
 * 只有**超过** `minLen` 才拆，最多 `maxParts` 条：拆得太碎同样是机器味。
 * @param {string} text 正文
 * @param {{minLen?: number, maxParts?: number, maxLen?: number}} [opts] 选项
 * @returns {string[]} 依次发出的若干条
 */
export function splitReply(text, { minLen = 90, maxParts = 3, maxLen = 120 } = {}) {
  const clean = String(text ?? '').trim();
  if (clean.length <= minLen) return clean === '' ? [] : [clean];

  const sentences = clean.match(/[^。！？!?\n]+[。！？!?]?/g) ?? [clean];
  const parts = [];
  let buf = '';
  for (const raw of sentences) {
    const s = raw.trim();
    if (s === '') continue;
    // 已经到 maxParts-1 条之后不再切：剩下的全并进最后一条，绝不丢内容
    if (buf !== '' && buf.length + s.length > maxLen && parts.length < maxParts - 1) {
      parts.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf !== '') parts.push(buf);
  return parts.length === 0 ? [clean] : parts;
}
