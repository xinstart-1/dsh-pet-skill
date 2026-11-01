// dsh-rewind-plugin 补丁模块：命令产物追踪（边界快照 + 内容缓存 + 隔离区回滚）
//
// 背景：官方 dsh-rewind-plugin 只追踪 write/edit 两个写类工具动过的文件
// （TRACKED_TOOLS = {write, edit}），并且单文件上限默认 8MB。渲染脚本
// （node render.mjs / ffmpeg）产出的 MP4 既不经过 write/edit、又远大于 8MB，
// 因此回退时完全不会被动到。
//
// 本模块在“回合边界”对工作区做一份轻量清单（路径 → size + mtime + 内容哈希），
// 只对“跟上一次清单相比变了”的文件做内容缓存（内容寻址、按 sha256 去重）。
// 回退到某个目标消息时：
//   - 目标时刻存在、现在不同 / 缺失，且有内容备份 → 还原字节；
//   - 目标时刻不存在、现在存在（命令新建的产物，或旧内容没备份的大文件）→ 移入隔离区；
//   - 无备份内容的大文件（例如补丁安装前就存在的成片）→ 移入隔离区并计入 skipped，
//     由用户重新渲染得到目标版本。
// 隔离区保留原始字节，`index.json` 记录每一份的去向，可人工取回。

import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const MANIFEST_VERSION = 1;
const MTIME_TOLERANCE_MS = 1500;
const DEFAULT_EXCLUDE =
  'node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,coverage,__pycache__,venv,.venv,target';

function sanitizeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function toRel(cwd, abs) {
  const rel = relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function fromRel(cwd, rel) {
  return join(cwd, ...rel.split('/'));
}

function parseExclude(raw) {
  const names = new Set();
  for (const part of String(raw ?? DEFAULT_EXCLUDE).split(',')) {
    const name = part.trim().toLowerCase();
    if (name !== '') names.add(name);
  }
  return names;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/** 递归扫描工作区：relPath -> { size, mtime }（跳过符号链接、点目录与排除目录名）。 */
async function walkWorkspace(cwd, exclude) {
  const files = new Map();
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir === '' ? cwd : fromRel(cwd, relDir);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of entries) {
      const name = dirent.name;
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (name.startsWith('.') || exclude.has(name.toLowerCase())) continue;
        stack.push(rel);
        continue;
      }
      if (!dirent.isFile()) continue;
      let info;
      try {
        info = await stat(fromRel(cwd, rel));
      } catch {
        continue;
      }
      files.set(rel, { size: info.size, mtime: Math.round(info.mtimeMs) });
    }
  }
  return files;
}

export class ArtifactTracker {
  /**
   * @param {object} opts
   * @param {() => string} opts.rootDir 快照根目录（插件 store.root）
   * @param {(sessionId: string) => string | undefined} opts.cwdOf 会话工作区
   * @param {number} [opts.maxFileBytes] 单文件内容缓存上限
   * @param {boolean} [opts.baselineContent] 基线也缓存内容
   * @param {string} [opts.exclude] 逗号分隔的排除目录名
   * @param {number} [opts.keepManifests] 每会话保留的清单份数
   * @param {{warn?: Function, info?: Function}} [opts.logger]
   */
  constructor(opts) {
    this.rootOf = opts.rootDir;
    this.cwdOf = opts.cwdOf;
    this.maxFileBytes = Number.isFinite(opts.maxFileBytes) ? opts.maxFileBytes : 64 * 1024 * 1024;
    this.baselineContent = opts.baselineContent === true;
    this.exclude = parseExclude(opts.exclude);
    this.keep = Number.isFinite(opts.keepManifests) ? Math.max(1, opts.keepManifests) : 200;
    this.logger = opts.logger;
    this.queues = new Map();
  }

  dirOf(sessionId) {
    return join(this.rootOf(), sanitizeId(sessionId), 'artifacts');
  }

  manifestsDir(sessionId) {
    return join(this.dirOf(sessionId), 'manifests');
  }

  blobsDir(sessionId) {
    return join(this.dirOf(sessionId), 'blobs');
  }

  quarantineDir(sessionId) {
    return join(this.dirOf(sessionId), 'quarantine');
  }

  manifestPath(sessionId, key) {
    return join(this.manifestsDir(sessionId), `${String(key).padStart(12, '0')}.json`);
  }

  warn(message) {
    this.logger?.warn?.(`[dsh-rewind-artifacts] ${message}`);
  }

  /** 每会话串行化，避免两次扫描互相覆盖清单。 */
  enqueue(sessionId, task) {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task).catch((error) => {
      this.warn(`task failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(sessionId, next);
    return next;
  }

  async listManifestKeys(sessionId) {
    let names;
    try {
      names = await readdir(this.manifestsDir(sessionId));
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => Number(name.slice(0, -5)))
      .filter((key) => Number.isSafeInteger(key))
      .sort((a, b) => a - b);
  }

  async loadManifest(sessionId, key) {
    try {
      const raw = await readFile(this.manifestPath(sessionId, key), 'utf8');
      const data = JSON.parse(raw);
      if (!data || data.v !== MANIFEST_VERSION || typeof data.files !== 'object') return undefined;
      return data;
    } catch {
      return undefined;
    }
  }

  /** 目标消息对应的状态：最后一份 key 严格小于 targetSeq 的清单，否则基线（key 0）。 */
  async stateAt(sessionId, targetSeq) {
    const keys = await this.listManifestKeys(sessionId);
    let picked;
    for (const key of keys) {
      if (key < targetSeq) picked = key;
    }
    if (picked === undefined) {
      if (keys.length > 0 && keys[0] === 0) return this.loadManifest(sessionId, 0);
      return undefined;
    }
    return this.loadManifest(sessionId, picked);
  }

  async blobPath(sessionId, hash) {
    return join(this.blobsDir(sessionId), hash);
  }

  /** 把文件内容写进内容寻址缓存；超过上限或读不到则返回 null。 */
  async cacheContent(sessionId, absPath, size) {
    if (!Number.isFinite(this.maxFileBytes) || this.maxFileBytes <= 0) return null;
    if (size > this.maxFileBytes) return null;
    const tmp = join(this.blobsDir(sessionId), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(this.blobsDir(sessionId), { recursive: true });
    try {
      await copyFile(absPath, tmp);
    } catch {
      await rm(tmp, { force: true });
      return null;
    }
    let hash;
    try {
      hash = await sha256File(tmp);
    } catch {
      await rm(tmp, { force: true });
      return null;
    }
    const dest = join(this.blobsDir(sessionId), hash);
    if (await exists(dest)) {
      await rm(tmp, { force: true });
      return hash;
    }
    try {
      await rename(tmp, dest);
    } catch {
      await rm(tmp, { force: true });
      return null;
    }
    return hash;
  }

  /**
   * 记录一次边界状态。keySeq = 该回合起始的用户消息 seq
   * （清单语义是“这一回合跑完之后的工作区状态”）。
   */
  async record(sessionId, keySeq) {
    const cwd = this.cwdOf(sessionId);
    if (cwd === undefined) {
      this.warn(`no workspace directory for ${sessionId}; artifact tracking skipped`);
      return undefined;
    }
    const keys = await this.listManifestKeys(sessionId);
    const prevKey = [...keys].reverse().find((key) => key <= keySeq);
    const prev = prevKey === undefined ? undefined : await this.loadManifest(sessionId, prevKey);
    const current = await walkWorkspace(cwd, this.exclude);
    const files = {};
    let cached = 0;
    for (const [rel, info] of current) {
      const before = prev?.files?.[rel];
      if (before && before[0] === info.size && Math.abs(before[1] - info.mtime) <= MTIME_TOLERANCE_MS) {
        files[rel] = [info.size, info.mtime, before[2] ?? null];
        continue;
      }
      const hash = await this.cacheContent(sessionId, fromRel(cwd, rel), info.size);
      if (hash !== null) cached++;
      files[rel] = [info.size, info.mtime, hash];
    }
    const data = {
      v: MANIFEST_VERSION,
      key: keySeq,
      at: Date.now(),
      cwd,
      files,
    };
    await writeJsonAtomic(this.manifestPath(sessionId, keySeq), data);
    await this.pruneManifests(sessionId, keySeq);
    return { key: keySeq, files: current.size, cached };
  }

  async pruneManifests(sessionId, keepFromKey) {
    const keys = await this.listManifestKeys(sessionId);
    const keep = new Set(keys.slice(-this.keep));
    keep.add(keepFromKey);
    for (const key of keys) {
      if (keep.has(key)) continue;
      if (key === 0) continue; // 基线永远保留
      await rm(this.manifestPath(sessionId, key), { force: true }).catch(() => undefined);
    }
  }

  /** 会话刚建立时的基线（key 0）：只记录存在性，默认不缓存内容。 */
  async ensureBaseline(sessionId) {
    const keys = await this.listManifestKeys(sessionId);
    if (keys.includes(0)) return;
    return this.enqueue(sessionId, async () => {
      const cwd = this.cwdOf(sessionId);
      if (cwd === undefined) return;
      const current = await walkWorkspace(cwd, this.exclude);
      const files = {};
      for (const [rel, info] of current) {
        let hash = null;
        if (this.baselineContent) {
          hash = await this.cacheContent(sessionId, fromRel(cwd, rel), info.size);
        }
        files[rel] = [info.size, info.mtime, hash];
      }
      await writeJsonAtomic(this.manifestPath(sessionId, 0), {
        v: MANIFEST_VERSION,
        key: 0,
        at: Date.now(),
        cwd,
        files,
      });
    });
  }

  /** 回合结束时记一份清单。 */
  async onTurnEnd(sessionId, keySeq) {
    return this.enqueue(sessionId, () => this.record(sessionId, keySeq));
  }

  /**
   * 计划一次回退：目标状态 vs 当前磁盘。
   * 只做 stat，不做哈希，保证界面的影响清单能在 8s 超时内返回。
   */
  async plan(sessionId, targetSeq) {
    const cwd = this.cwdOf(sessionId);
    if (cwd === undefined) return { actions: [], skipped: [], cwd: undefined };
    const target = await this.stateAt(sessionId, targetSeq);
    if (target === undefined) return { actions: [], skipped: [], cwd };
    const current = await walkWorkspace(cwd, this.exclude);
    const actions = [];
    const skipped = [];
    const rels = new Set([...Object.keys(target.files), ...current.keys()]);
    for (const rel of rels) {
      const before = target.files[rel];
      const now = current.get(rel);
      const abs = fromRel(cwd, rel);
      if (before === undefined) {
        if (now !== undefined) actions.push({ rel, action: 'delete', reason: 'created' });
        continue;
      }
      const hash = before[2] ?? null;
      const backupReady = hash !== null && (await exists(await this.blobPath(sessionId, hash)));
      if (now === undefined) {
        if (backupReady) actions.push({ rel, action: 'restore', hash });
        else skipped.push({ rel, reason: 'missing-no-backup' });
        continue;
      }
      const changed = now.size !== before[0] || Math.abs(now.mtime - before[1]) > MTIME_TOLERANCE_MS;
      if (!changed) continue;
      if (backupReady) actions.push({ rel, action: 'restore', hash });
      else actions.push({ rel, action: 'delete', reason: 'changed-no-backup', abs });
    }
    return { actions, skipped, cwd };
  }

  /** 供 popover 的影响清单使用：{ path, action }[]。 */
  async preview(sessionId, targetSeq) {
    const { actions, cwd } = await this.plan(sessionId, targetSeq);
    if (cwd === undefined) return [];
    return actions
      .map((item) => ({ path: fromRel(cwd, item.rel), action: item.action === 'restore' ? 'restore' : 'delete' }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 执行回退：能还原的还原字节，不能还原的移入隔离区（不硬删）。 */
  async restore(sessionId, targetSeq, markerSeq) {
    const summary = {
      restored: 0,
      quarantine: 0,
      skipped: 0,
      failed: 0,
      dir: undefined,
      errors: [],
      restoredPaths: [],
      quarantinedPaths: [],
    };
    const { actions, skipped, cwd } = await this.plan(sessionId, targetSeq);
    summary.skipped = skipped.length;
    if (cwd === undefined || actions.length === 0) {
      if (cwd !== undefined) await this.finishRestore(sessionId, targetSeq, markerSeq, cwd);
      return summary;
    }
    const opId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const qRoot = join(this.quarantineDir(sessionId), opId);
    summary.dir = qRoot;
    const index = [];
    for (const item of actions) {
      const abs = fromRel(cwd, item.rel);
      try {
        const info = await lstat(abs).catch(() => undefined);
        if (item.action === 'restore') {
          const blob = await this.blobPath(sessionId, item.hash);
          if (!(await exists(blob))) {
            summary.skipped++;
            continue;
          }
          await mkdir(join(abs, '..'), { recursive: true });
          const tmp = `${abs}.rewind-${process.pid}.tmp`;
          await copyFile(blob, tmp);
          await rename(tmp, abs);
          summary.restored++;
          summary.restoredPaths.push(abs);
          index.push({ path: abs, action: 'restore', blob: item.hash });
          continue;
        }
        if (info === undefined) continue; // 已经不在了：目标状态已达成
        if (info.isSymbolicLink()) {
          summary.skipped++;
          continue;
        }
        const dest = join(qRoot, ...item.rel.split('/'));
        await mkdir(join(dest, '..'), { recursive: true });
        try {
          await rename(abs, dest);
        } catch {
          await copyFile(abs, dest);
          await rm(abs, { force: true });
        }
        summary.quarantine++;
        summary.quarantinedPaths.push(abs);
        index.push({ path: abs, action: 'quarantine', movedTo: dest, reason: item.reason ?? 'created', size: info.size });
      } catch (error) {
        summary.failed++;
        summary.errors.push(`${item.rel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (index.length > 0) {
      await writeJsonAtomic(join(qRoot, 'index.json'), {
        sessionId,
        targetSeq,
        markerSeq,
        at: Date.now(),
        items: index,
      }).catch(() => undefined);
    }
    await this.finishRestore(sessionId, targetSeq, markerSeq, cwd);
    return summary;
  }

  /** 回退后收拾清单：丢掉目标之后的旧清单，按当前磁盘补一份新的。 */
  async finishRestore(sessionId, targetSeq, markerSeq, cwd) {
    const keys = await this.listManifestKeys(sessionId);
    for (const key of keys) {
      if (key > targetSeq) await rm(this.manifestPath(sessionId, key), { force: true }).catch(() => undefined);
    }
    if (!Number.isSafeInteger(markerSeq)) return;
    const target = await this.stateAt(sessionId, targetSeq);
    const current = await walkWorkspace(cwd, this.exclude);
    const files = {};
    for (const [rel, info] of current) {
      const before = target?.files?.[rel];
      const same = before && before[0] === info.size;
      files[rel] = [info.size, info.mtime, same ? before[2] ?? null : null];
    }
    await writeJsonAtomic(this.manifestPath(sessionId, markerSeq), {
      v: MANIFEST_VERSION,
      key: markerSeq,
      at: Date.now(),
      cwd,
      files,
    }).catch(() => undefined);
  }
}

export { DEFAULT_EXCLUDE };