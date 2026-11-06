/**
 * 卸载清理：把插件在各处落盘的用户数据删干净。
 *
 * 背景：DSH 插件的 `ctx.effect` 只负责内存副作用（停定时器、摘监听、杀 helper），
 * 不会动磁盘。而本插件在用户数据目录下留了三块东西，卸载/重装后都会残留：
 *   - `<DSH_HOME>/dsh-pet-qq/`   QQ 技能（含 napcat/ 网关安装器、已装的 QQ 网关与登录态、配置、日志）
 *   - `<DSH_HOME>/dsh-pet/`      宠物本体（主配置、pet 素材、对话记忆、动画缓存、日志）
 *   - `<DSH_HOME>/electron/`     Electron 运行时（约 104MB，可重下，默认保留）
 *
 * 两条清理路径，对应两种"卸载"：
 * 1. **用户在插件页面直接删插件** → 走 Cordis `ctx.effect`，与"禁用"无法区分，
 *    所以只清**可再生、无隐私**的东西（`napcat/` 网关，实测约 1.5GB，随时可重下），
 *    配置与 QQ 登录态保留——见 `qq/index.js` 的清理块。
 * 2. **用户在设置页点「彻底卸载并清理」**（二次确认）→ 走 `wipeAll()` 全清，
 *    含配置与登录态。这是唯一会删用户数据的路径，且必须用户主动确认。
 *
 * 绝不静默全删：误卸载会连带抹掉 QQ 登录态与宠物配置，且不可恢复。
 *
 * @module dsh-pet-qq/uninstall
 */
import { existsSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dshHome } from './util.js';

/**
 * 计算待清理目录列表。
 * @param {{includeElectron?: boolean, includePet?: boolean, home?: string}} [opts] 选项
 * @returns {{home: string, targets: Array<{key: string, path: string}>}} 根与目录清单
 */
export function collectTargets(opts = {}) {
  const home = opts.home ?? dshHome();
  /** @type {Array<{key: string, path: string}>} */
  const targets = [{ key: 'qq', path: join(home, 'dsh-pet-qq') }];
  if (opts.includePet !== false) targets.push({ key: 'pet', path: join(home, 'dsh-pet') });
  if (opts.includeElectron === true) targets.push({ key: 'electron', path: join(home, 'electron') });
  return { home, targets };
}

/**
 * 删一个目录，带 Windows 文件锁重试。
 * @param {string} dir 目录
 * @param {{retries?: number, delayMs?: number}} [opts] 重试
 * @returns {Promise<{path: string, removed: 'deleted'|'absent'|'failed', error?: string}>} 结果
 */
export async function wipeDir(dir, opts = {}) {
  const retries = opts.retries ?? 5;
  const delayMs = opts.delayMs ?? 200;
  if (!existsSync(dir)) return { path: dir, removed: 'absent' };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: retries });
      return { path: dir, removed: 'deleted' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === retries) return { path: dir, removed: 'failed', error: msg };
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { path: dir, removed: 'failed', error: 'unreachable' };
}

/**
 * 同步删一个目录，给 `ctx.effect` 的清理钩子用。
 *
 * 为什么必须同步：`ctx.effect` 的清理函数返回后，DSH 可能立刻销毁进程，
 * 异步 `rm()` 还没跑完就被打断，结果什么都没删掉。`rmSync` 在返回前完成，
 * 不会被进程退出截断——代价是阻塞几十毫秒（删 1.5GB 网关目录可能更久），
 * 但卸载路径上这点延迟是值得的。
 * @param {string} dir 目录
 * @param {{retries?: number}} [opts] 重试
 * @returns {{path: string, removed: 'deleted'|'absent'|'failed', error?: string}} 结果
 */
export function wipeDirSync(dir, opts = {}) {
  const retries = opts.retries ?? 3;
  if (!existsSync(dir)) return { path: dir, removed: 'absent' };
  try {
    // maxRetries 让 Node 在 Windows 上自动重试被占用的文件
    rmSync(dir, { recursive: true, force: true, maxRetries: retries });
    return { path: dir, removed: 'deleted' };
  } catch (error) {
    return { path: dir, removed: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 执行清理。
 * @param {{includeElectron?: boolean, includePet?: boolean, home?: string}} [opts] 选项
 * @returns {Promise<{ok: boolean, home: string, removed: Array<string>, failed: Array<{path: string, error: string}>}>}
 */
export async function wipeAll(opts = {}) {
  const { home, targets } = collectTargets(opts);
  /** @type {Array<string>} */
  const removed = [];
  /** @type {Array<{path: string, error: string}>} */
  const failed = [];
  for (const t of targets) {
    const r = await wipeDir(t.path);
    if (r.removed === 'deleted') removed.push(t.key);
    else if (r.removed === 'failed') failed.push({ path: r.path, error: r.error ?? 'unknown' });
    // 'absent'（目录本来就没有）：既不算删除成功也不算失败
  }
  return { ok: failed.length === 0, home, removed, failed };
}
