/**
 * 状态存储：账号、授牌、审计。
 *
 * 三个文件分开存是刻意的：
 * - `accounts.json` 是账号凭据（含 token），只要能撤销就得能单独删，不能混在配置里；
 * - `grants.json` 是"哪只宠物能用什么"，撤销一次只动这里；
 * - `audit.json` 是流水，环形保留最近 200 条，出问题能回答"是谁什么时候调的"。
 *
 * 所有写入都是原子写——宿主随时可能被关掉，半份 token 比没有 token 更麻烦。
 *
 * @module dsh-pet-douyin-account/store
 */
import { readJson, writeJsonAtomic } from './util.js';

/** 可授予的能力：浏览作品 / 分享 / 私信草稿 */
export const CAPS = /** @type {const} */ (['browse', 'share', 'dm', 'publish']);

/** 能力的中文名（UI 与审计共用，别在两处各写一遍） */
export const CAP_LABEL = { browse: '刷推荐流', share: '分享', dm: '私信', publish: '做发布包' };

/** 审计环形长度 */
const AUDIT_MAX = 200;

/** 用量账本保留的天数（跨重启不清空，但也不必永久留） */
const USAGE_KEEP_DAYS = 14;

/**
 * 本地日期键 `YYYY-MM-DD`（按本机时区，跨日归零靠它）。
 * @param {Date} [d] 时间点
 * @returns {string} 日期键
 */
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 判断一条授牌是否仍然有效（过期时间 0 = 永久）。
 * @param {{caps?: Record<string, boolean>, expiresAt?: number}} grant 授牌
 * @param {number} now 当前时间戳
 * @returns {boolean} 是否有效
 */
export function grantAlive(grant, now) {
  const expiresAt = Number(grant.expiresAt ?? 0);
  return expiresAt === 0 || expiresAt > now;
}

/**
 * 建状态存储。第一次访问时 `load()`，之后内存持有、改动即落盘。
 * @param {{paths: {accountsFile: string, grantsFile: string, auditFile: string}, log: object}} deps 依赖
 * @returns {object} 存储门面
 */
export function createStore({ paths, log }) {
  /** @type {{version: number, currentOpenId: string, accounts: any[]}} */
  let accounts = { version: 1, currentOpenId: '', accounts: [] };
  /** @type {{version: number, grants: any[]}} */
  let grants = { version: 1, grants: [] };
  /** @type {{version: number, entries: any[]}} */
  let audit = { version: 1, entries: [] };
  /** 用量账本：`{ 日期键: { '宠物id|能力': 次数 } }` */
  /** @type {{version: number, days: Record<string, Record<string, number>>}} */
  let usage = { version: 1, days: {} };
  let loaded = null;

  const persistAccounts = () =>
    writeJsonAtomic(paths.accountsFile, accounts).catch((e) =>
      log?.warn(`账号落盘失败：${e instanceof Error ? e.message : String(e)}`),
    );
  const persistGrants = () =>
    writeJsonAtomic(paths.grantsFile, grants).catch((e) =>
      log?.warn(`授牌落盘失败：${e instanceof Error ? e.message : String(e)}`),
    );
  const persistAudit = () =>
    writeJsonAtomic(paths.auditFile, audit).catch((e) =>
      log?.warn(`审计落盘失败：${e instanceof Error ? e.message : String(e)}`),
    );
  // 旧测试只传三个文件时，用量就只活在内存里（no-op 落盘），不强行要求新路径
  const persistUsage = () =>
    paths.usageFile === undefined
      ? Promise.resolve()
      : writeJsonAtomic(paths.usageFile, usage).catch((e) =>
          log?.warn(`用量落盘失败：${e instanceof Error ? e.message : String(e)}`),
        );

  return {
    /**
     * 首次加载（并发调用共享同一次读）。
     * @returns {Promise<void>} 完成
     */
    async load() {
      if (loaded !== null) return loaded;
      loaded = (async () => {
        const a = await readJson(paths.accountsFile, null);
        if (a !== null && typeof a === 'object' && Array.isArray(a.accounts)) {
          accounts = {
            version: 1,
            currentOpenId: typeof a.currentOpenId === 'string' ? a.currentOpenId : '',
            accounts: a.accounts.filter((x) => x !== null && typeof x === 'object' && typeof x.openId === 'string'),
          };
        }
        const g = await readJson(paths.grantsFile, null);
        if (g !== null && typeof g === 'object' && Array.isArray(g.grants)) {
          grants = {
            version: 1,
            grants: g.grants.filter((x) => x !== null && typeof x === 'object' && typeof x.pet === 'string'),
          };
        }
        const au = await readJson(paths.auditFile, null);
        if (au !== null && typeof au === 'object' && Array.isArray(au.entries)) {
          audit = { version: 1, entries: au.entries.slice(-AUDIT_MAX) };
        }
        if (paths.usageFile !== undefined) {
          const us = await readJson(paths.usageFile, null);
          if (us !== null && typeof us === 'object' && us.days !== null && typeof us.days === 'object') {
            usage = { version: 1, days: us.days };
          }
        }
      })();
      return loaded;
    },

    /* ---------------- 账号 ---------------- */

    /**
     * 当前账号（没有则 null）。
     * @returns {any|null} 账号
     */
    account() {
      if (accounts.accounts.length === 0) return null;
      return accounts.accounts.find((a) => a.openId === accounts.currentOpenId) ?? accounts.accounts[0];
    },

    /**
     * 取某个账号的原始对象（含明文 token，只给内部用）。
     * @param {string} openId 账号
     * @returns {any|null} 账号
     */
    findAccount(openId) {
      return accounts.accounts.find((a) => a.openId === openId) ?? null;
    },

    /**
     * 全部已绑定账号（token 已脱敏，给 UI 用）。
     * @returns {any[]} 账号列表
     */
    listAccounts() {
      return accounts.accounts.map((a) => ({
        openId: a.openId,
        nickname: a.nickname ?? '',
        avatar: a.avatar ?? '',
        scope: a.scope ?? '',
        accessExpiresAt: a.accessExpiresAt ?? 0,
        refreshExpiresAt: a.refreshExpiresAt ?? 0,
        addedAt: a.addedAt ?? 0,
        current: a.openId === accounts.currentOpenId,
        hasAccessToken: typeof a.accessToken === 'string' && a.accessToken !== '',
        hasRefreshToken: typeof a.refreshToken === 'string' && a.refreshToken !== '',
      }));
    },

    /**
     * 写入/更新一个账号并设为当前。
     * @param {any} account 账号对象（含明文 token）
     * @returns {Promise<void>} 完成
     */
    async upsertAccount(account) {
      const idx = accounts.accounts.findIndex((a) => a.openId === account.openId);
      if (idx >= 0) accounts.accounts[idx] = { ...accounts.accounts[idx], ...account };
      else accounts.accounts.push(account);
      accounts.currentOpenId = account.openId;
      await persistAccounts();
    },

    /**
     * 只更新 token 字段（刷新时用）。
     * @param {string} openId 账号
     * @param {object} patch 字段
     * @returns {Promise<void>} 完成
     */
    async patchAccount(openId, patch) {
      const hit = accounts.accounts.find((a) => a.openId === openId);
      if (hit === undefined) return;
      Object.assign(hit, patch);
      await persistAccounts();
    },

    /**
     * 把某个账号设为默认（没绑定账号的宠物都用它）。
     * @param {string} openId 账号
     * @returns {Promise<boolean>} 是否切过去了
     */
    async setCurrent(openId) {
      if (!accounts.accounts.some((a) => a.openId === openId)) return false;
      accounts.currentOpenId = openId;
      await persistAccounts();
      return true;
    },

    /**
     * 解绑一个账号（连同它的授牌一起清掉——换号后旧授牌没有意义）。
     * @param {string} openId 账号
     * @returns {Promise<boolean>} 是否删掉了
     */
    async removeAccount(openId) {
      const before = accounts.accounts.length;
      accounts.accounts = accounts.accounts.filter((a) => a.openId !== openId);
      if (accounts.currentOpenId === openId) accounts.currentOpenId = accounts.accounts[0]?.openId ?? '';
      if (accounts.accounts.length === before) return false;
      await persistAccounts();
      return true;
    },

    /* ---------------- 授牌 ---------------- */

    /**
     * 全部授牌（带 alive 标记）。
     * @param {number} now 当前时间
     * @returns {any[]} 授牌列表
     */
    listGrants(now = Date.now()) {
      return grants.grants.map((g) => ({ ...g, alive: grantAlive(g, now) }));
    },

    /**
     * 取某只宠物的授牌。
     * @param {string} pet 宠物 id
     * @returns {any|undefined} 授牌
     */
    grantOf(pet) {
      return grants.grants.find((g) => g.pet === pet);
    },

    /**
     * 设置授牌（覆盖式）。`caps` 里为 false 的能力会被删掉。
     * @param {string} pet 宠物 id
     * @param {Record<string, boolean>} caps 能力开关
     * @param {number} ttlHours 有效期（小时，0 = 永久）
     * @returns {Promise<any>} 写入后的授牌
     */
    async setGrant(pet, caps, ttlHours = 0, extra = {}) {
      const clean = {};
      for (const cap of CAPS) if (caps?.[cap] === true) clean[cap] = true;
      const now = Date.now();
      const expiresAt = ttlHours > 0 ? now + ttlHours * 3600_000 : 0;
      /** 每日配额：0 = 不限（只对授出去的能力有意义，没授的填了也不生效） */
      const quota = {};
      for (const cap of CAPS) {
        const n = Number(extra?.quota?.[cap]);
        quota[cap] = Number.isFinite(n) && n > 0 ? Math.min(999, Math.round(n)) : 0;
      }
      const autonomy = {
        enabled: extra?.autonomy?.enabled === true,
        perDay: Math.max(1, Math.min(50, Math.round(Number(extra?.autonomy?.perDay)) || 3)),
      };
      const next = {
        pet,
        caps: clean,
        grantedAt: now,
        expiresAt,
        accountOpenId: String(extra?.accountOpenId ?? ''),
        quota,
        autonomy,
      };
      const idx = grants.grants.findIndex((g) => g.pet === pet);
      if (idx >= 0) grants.grants[idx] = next;
      else grants.grants.push(next);
      await persistGrants();
      return next;
    },

    /**
     * 撤销某只宠物的全部能力。
     * @param {string} pet 宠物 id
     * @returns {Promise<boolean>} 是否真的撤了
     */
    async revokeGrant(pet) {
      const before = grants.grants.length;
      grants.grants = grants.grants.filter((g) => g.pet !== pet);
      if (grants.grants.length === before) return false;
      await persistGrants();
      return true;
    },

    /**
     * 这只宠物被托管到哪个账号（空串 = 用当前默认账号）。
     * @param {string} pet 宠物 id
     * @returns {string} open_id
     */
    bindOf(pet) {
      return grants.grants.find((g) => g.pet === pet)?.accountOpenId ?? '';
    },

    /**
     * 某个能力的每日上限（0 = 不限）。
     * @param {string} pet 宠物 id
     * @param {'browse'|'share'|'dm'} cap 能力
     * @returns {number} 上限
     */
    quotaOf(pet, cap) {
      const g = grants.grants.find((x) => x.pet === pet);
      return Number(g?.quota?.[cap] ?? 0) || 0;
    },

    /**
     * 今日已用次数（三项都给，方便 UI 一次显示）。
     * @param {string} pet 宠物 id
     * @param {number} [now] 当前时间
     * @returns {{browse: number, share: number, dm: number}} 用量
     */
    usageOf(pet, now = Date.now()) {
      const bucket = usage.days[dateKey(new Date(now))] ?? {};
      // 按 CAPS 遍历：以后加能力不用再回来改这里（漏改过一次，publish 用量读不出来）
      const out = {};
      for (const cap of CAPS) out[cap] = bucket[`${pet}|${cap}`] ?? 0;
      return out;
    },

    /**
     * 查一次配额（不改账本）。执行前调它，别等做完才发现超额。
     * @param {string} pet 宠物 id
     * @param {'browse'|'share'|'dm'} cap 能力
     * @param {number} [now] 当前时间
     * @returns {{ok: boolean, used: number, limit: number, reason?: string}} 判定
     */
    checkQuota(pet, cap, now = Date.now()) {
      const limit = Number(grants.grants.find((x) => x.pet === pet)?.quota?.[cap] ?? 0) || 0;
      const used = (usage.days[dateKey(new Date(now))] ?? {})[`${pet}|${cap}`] ?? 0;
      if (limit > 0 && used >= limit) {
        return {
          ok: false,
          used,
          limit,
          reason: `「${pet}」今天的「${CAP_LABEL[cap]}」配额用完了（${used}/${limit}）`,
        };
      }
      return { ok: true, used, limit };
    },

    /**
     * 记一次用量（成功的调用才记）。
     * @param {string} pet 宠物 id
     * @param {'browse'|'share'|'dm'} cap 能力
     * @param {number} [now] 当前时间
     * @returns {Promise<void>} 完成
     */
    async recordUse(pet, cap, now = Date.now()) {
      const key = dateKey(new Date(now));
      usage.days[key] = usage.days[key] ?? {};
      const field = `${pet}|${cap}`;
      usage.days[key][field] = (usage.days[key][field] ?? 0) + 1;
      const keys = Object.keys(usage.days).sort();
      if (keys.length > USAGE_KEEP_DAYS)
        for (const k of keys.slice(0, keys.length - USAGE_KEEP_DAYS)) delete usage.days[k];
      await persistUsage();
    },

    /**
     * 校验一只宠物是否拥有某个能力。
     *
     * 这是整个插件唯一的权限闸门——所有能力入口都必须先过它。
     * @param {string} pet 宠物 id
     * @param {'browse'|'share'|'dm'} cap 能力
     * @param {number} [now] 当前时间
     * @returns {{ok: boolean, reason?: string}} 判定
     */
    checkGrant(pet, cap, now = Date.now()) {
      if (typeof pet !== 'string' || pet.trim() === '')
        return { ok: false, reason: '没带宠物 id（?pet=），无法校验授牌' };
      if (!CAPS.includes(cap)) return { ok: false, reason: `未知能力：${cap}` };
      const grant = grants.grants.find((g) => g.pet === pet.trim());
      if (grant === undefined) return { ok: false, reason: `宠物「${pet}」没有授牌` };
      if (!grantAlive(grant, now)) return { ok: false, reason: `宠物「${pet}」的授牌已过期` };
      if (grant.caps?.[cap] !== true) return { ok: false, reason: `宠物「${pet}」没有「${CAP_LABEL[cap]}」能力` };
      return { ok: true };
    },

    /* ---------------- 审计 ---------------- */

    /**
     * 记一条审计。
     * @param {{pet?: string, cap?: string, action: string, ok: boolean, detail?: string}} entry 记录
     * @returns {Promise<void>} 完成
     */
    async audit(entry) {
      audit.entries.push({ t: Date.now(), ...entry });
      if (audit.entries.length > AUDIT_MAX) audit.entries.splice(0, audit.entries.length - AUDIT_MAX);
      await persistAudit();
    },

    /**
     * 最近的审计（新的在前）。
     * @param {number} [limit] 条数
     * @returns {any[]} 列表
     */
    listAudit(limit = 50) {
      return audit.entries.slice(-Math.max(1, limit)).reverse();
    },
  };
}
