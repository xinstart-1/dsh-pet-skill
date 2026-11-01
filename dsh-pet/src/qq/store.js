/**
 * 账本：用量（限速要用）+ 审计（出问题要能倒查）。
 *
 * 为什么值得单独落盘而不是全放内存：限速的"每小时/每天"跨重启必须继续算，
 * 否则重启一次就等于把闸门清零，而重启这件事在调试期一天会发生十几次。
 * 审计只留最近 300 条（环形），够回答"刚才那条是谁回的"。
 *
 * 写盘是**延迟合并**的：一次回复可能写好几条审计，逐条 `writeFile` 只会拖慢发送。
 *
 * @module dsh-pet-qq/store
 */
import { readJson, writeJsonAtomic } from './util.js';

/** 审计环形缓冲上限 */
const AUDIT_MAX = 300;

/**
 * 本地日期键 `YYYY-MM-DD`（按本机时区，跨天就换账本）。
 * @param {number} t 时间戳
 * @returns {string} 键
 */
export function dayKey(t) {
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 本地小时键 `YYYY-MM-DDTHH`（用于每小时限速）。
 * @param {number} t 时间戳
 * @returns {string} 键
 */
export function hourKey(t) {
  const d = new Date(t);
  return `${dayKey(t)}T${String(d.getHours()).padStart(2, '0')}`;
}

/**
 * 建账本。`load()` 之前读到的都是空账（不会误判超额）。
 * @param {{paths: {stateFile: string}, log: object, now?: () => number}} deps 依赖
 * @returns {object} 账本
 */
export function createStore({ paths, log, now = () => Date.now() }) {
  /** @type {{day: string, dayTotal: number, byPeer: Record<string, {hour: string, count: number, lastAt: number}>, audit: any[]}} */
  let state = { day: '', dayTotal: 0, byPeer: {}, audit: [] };
  /** @type {ReturnType<typeof setTimeout>|null} */
  let saveTimer = null;
  let saving = false;

  /** 跨天清零（会话级计数按天重开，小时计数在 usageOf 里按需重开） */
  function rollover(t) {
    const today = dayKey(t);
    if (state.day === today) return;
    state.day = today;
    state.dayTotal = 0;
    state.byPeer = {};
  }

  /** 落盘（延迟 800ms 合并） */
  function scheduleSave() {
    if (saveTimer !== null || saving) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, 800);
    if (typeof saveTimer === 'object' && saveTimer !== null) saveTimer.unref?.();
  }

  /** 立刻落盘 */
  async function flush() {
    if (saving) return;
    saving = true;
    try {
      await writeJsonAtomic(paths.stateFile, state);
    } catch (error) {
      log.warn(`账本写盘失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      saving = false;
    }
  }

  return {
    /** 读账本（文件坏了就当新账，不让一条脏数据把插件卡死） */
    async load() {
      const raw = await readJson(paths.stateFile, null);
      if (raw !== null && typeof raw === 'object') {
        state = {
          day: typeof raw.day === 'string' ? raw.day : '',
          dayTotal: Number(raw.dayTotal) || 0,
          byPeer: raw.byPeer !== null && typeof raw.byPeer === 'object' ? raw.byPeer : {},
          audit: Array.isArray(raw.audit) ? raw.audit.slice(-AUDIT_MAX) : [],
        };
      }
      rollover(now());
    },

    /**
     * 某个会话现在的用量（会自动跨天/跨小时清零）。
     * @param {string} peerId 会话 id
     * @param {number} [t] 时间戳
     * @returns {{hour: number, day: number, lastAt: number}} 用量
     */
    usageOf(peerId, t = now()) {
      rollover(t);
      const entry = state.byPeer[String(peerId ?? '')];
      if (entry === undefined || entry === null || typeof entry !== 'object') {
        return { hour: 0, day: state.dayTotal, lastAt: 0 };
      }
      const hour = entry.hour === hourKey(t) ? Number(entry.count) || 0 : 0;
      return { hour, day: state.dayTotal, lastAt: Number(entry.lastAt) || 0 };
    },

    /**
     * 记一次成功回复。
     * @param {string} peerId 会话 id
     * @param {number} [t] 时间戳
     * @returns {void}
     */
    recordUse(peerId, t = now()) {
      rollover(t);
      const key = String(peerId ?? '');
      const hk = hourKey(t);
      const entry = state.byPeer[key] ?? { hour: hk, count: 0, lastAt: 0 };
      if (entry.hour !== hk) {
        entry.hour = hk;
        entry.count = 0;
      }
      entry.count = (Number(entry.count) || 0) + 1;
      entry.lastAt = t;
      state.byPeer[key] = entry;
      state.dayTotal += 1;
      scheduleSave();
    },

    /**
     * 写一条审计。
     * @param {{action: string, ok?: boolean, peer?: string, detail?: string}} entry 条目
     * @returns {void}
     */
    audit(entry) {
      const item = {
        t: now(),
        action: String(entry?.action ?? ''),
        ok: entry?.ok === true,
        peer: String(entry?.peer ?? '').slice(0, 80),
        detail: String(entry?.detail ?? '').slice(0, 300),
      };
      state.audit.push(item);
      if (state.audit.length > AUDIT_MAX) state.audit.splice(0, state.audit.length - AUDIT_MAX);
      scheduleSave();
    },

    /** 最近审计（新→旧）。 */
    auditList(limit = 50) {
      const n = Math.max(1, Math.min(AUDIT_MAX, Number(limit) || 50));
      return state.audit.slice(-n).reverse();
    },

    /** 汇总快照（给设置页）。 */
    summary() {
      return { day: state.day, dayTotal: state.dayTotal, peers: Object.keys(state.byPeer).length };
    },

    /** 立刻写盘（停插件时调）。 */
    flush,
  };
}
