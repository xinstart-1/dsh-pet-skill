/**
 * 台账：发过哪些片、每条的结局，以及排期计数。
 *
 * 存在的唯一理由是**去重**——目录监听最怕的就是同一个视频每 30 秒被准备一次。
 * 键用 `路径 + 大小 + 修改时间(秒)`：内容改了大小或 mtime 就会变，等于换了一条片；
 * 不用内容哈希是因为对大文件算 sha256 太贵，而这个组合在本地素材目录里足够可靠。
 *
 * @module dsh-pet-douyin/ledger
 */
import { readJson, writeJsonAtomic } from './util.js';

/** 台账最多保留的条目数（超出的从最早的丢） */
const MAX_ENTRIES = 3000;

/**
 * 一条记录的去重键。
 * @param {{path: string, size: number, mtimeMs: number}} file 文件信息
 * @returns {string} 去重键
 */
export function dedupeKey(file) {
  return `${file.path}|${file.size}|${Math.floor(file.mtimeMs / 1000)}`;
}

/** 空台账形状 */
function emptyLedger() {
  return { version: 1, entries: [], schedule: { lastRunAt: 0, dayKey: '', dayCount: 0, fired: {} } };
}

/**
 * 台账读写器。内存里持一份，每次改动立刻原子落盘——宿主进程随时可能被关掉。
 * @param {{file: string, log?: {warn: Function}}} opts 选项
 * @returns {object} 台账操作集合
 */
export function createLedger({ file, log }) {
  /** @type {ReturnType<typeof emptyLedger>} */
  let data = emptyLedger();
  /** @type {Set<string>} */
  let keys = new Set();
  let loading = null;

  const rebuildKeys = () => {
    keys = new Set(data.entries.map((e) => e.key).filter(Boolean));
  };

  const persist = async () => {
    try {
      await writeJsonAtomic(file, data);
    } catch (error) {
      log?.warn(`台账写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    /**
     * 首次访问时从磁盘加载（并发调用共享同一次读）。
     * @returns {Promise<void>} 加载完成
     */
    async load() {
      if (loading !== null) return loading;
      loading = (async () => {
        const raw = await readJson(file, undefined);
        if (raw !== null && typeof raw === 'object' && Array.isArray(raw.entries)) {
          data = {
            version: 1,
            entries: raw.entries.filter((e) => e !== null && typeof e === 'object'),
            schedule:
              raw.schedule !== null && typeof raw.schedule === 'object'
                ? {
                    lastRunAt: Number(raw.schedule.lastRunAt) || 0,
                    dayKey: typeof raw.schedule.dayKey === 'string' ? raw.schedule.dayKey : '',
                    dayCount: Number(raw.schedule.dayCount) || 0,
                    fired:
                      raw.schedule.fired !== null && typeof raw.schedule.fired === 'object' ? raw.schedule.fired : {},
                  }
                : emptyLedger().schedule,
          };
          rebuildKeys();
        }
      })();
      return loading;
    },

    /**
     * 这条片是不是已经准备过。
     * @param {string} key 去重键
     * @returns {boolean} 是否已存在
     */
    has(key) {
      return keys.has(key);
    },

    /**
     * 记一条新记录（同时刷新去重集合）。
     * @param {object} entry 记录
     * @returns {Promise<object>} 落库后的记录
     */
    async add(entry) {
      data.entries.push(entry);
      if (entry.key) keys.add(entry.key);
      if (data.entries.length > MAX_ENTRIES) data.entries.splice(0, data.entries.length - MAX_ENTRIES);
      await persist();
      return entry;
    },

    /**
     * 改一条记录（按 id）。
     * @param {string} id 记录 id
     * @param {object} patch 要覆盖的字段
     * @returns {Promise<object|null>} 改后的记录；找不到返回 null
     */
    async update(id, patch) {
      const hit = data.entries.find((e) => e.id === id);
      if (hit === undefined) return null;
      Object.assign(hit, patch, { updatedAt: Date.now() });
      await persist();
      return hit;
    },

    /**
     * 最近的记录（新的在前）。
     * @param {number} [limit] 条数
     * @returns {object[]} 记录列表
     */
    list(limit = 50) {
      return data.entries.slice(-Math.max(1, limit)).reverse();
    },

    /**
     * 按 id 取一条。
     * @param {string} id 记录 id
     * @returns {object|undefined} 记录
     */
    find(id) {
      return data.entries.find((e) => e.id === id);
    },

    /**
     * 统计：总数、各状态数、今天准备了几条。
     * @param {string} todayKey 今天的日期键
     * @returns {{total: number, packed: number, published: number, skipped: number, todayCount: number}} 统计
     */
    stats(todayKey) {
      const out = { total: data.entries.length, packed: 0, published: 0, skipped: 0, todayCount: 0 };
      const todayPrefix = todayKey;
      for (const e of data.entries) {
        if (e.status === 'published') out.published += 1;
        else if (e.status === 'skipped') out.skipped += 1;
        else out.packed += 1;
        if (typeof e.packId === 'string' && e.packId.startsWith(todayPrefix)) out.todayCount += 1;
      }
      return out;
    },

    /** @returns {object} 当前排期状态（只读快照） */
    schedule() {
      return structuredClone(data.schedule);
    },

    /**
     * 覆盖排期状态并落盘。
     * @param {object} next 新状态
     * @returns {Promise<void>} 完成
     */
    async setSchedule(next) {
      data.schedule = next;
      await persist();
    },
  };
}
