/**
 * 托管策略：宠物能不能"自己"动，以及为什么不动。
 *
 * 全是纯函数——`now` 由调用方注入，所以"周三 21:07 已跑满每日 3 次"这种判定
 * 能直接写单测，不用等真到那个点。
 *
 * 自主只覆盖 `browse`（读自己作品 + 播报）。理由：
 * - `share` 的价值在"复制给人"，宠物自己复制没有意义；
 * - `dm` 只出草稿，而草稿是人要看的，宠物自己写给自己看没有意义。
 * 所以"自主"= 宠物按计划自己去看几眼，**永不发送**。这条是设计约束，不是懒。
 *
 * @module dsh-pet-douyin-account/policy
 */
import { dateKey } from './store.js';

/**
 * `HH:MM` → 当天第几分钟。
 * @param {string} hhmm 时间
 * @returns {number} 分钟（非法 -1）
 */
function minutesOf(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? '').trim());
  return m === null ? -1 : Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 当前是否落在任一允许时段内（支持跨零点 `23:00-02:00`）。
 * @param {string[]} windows 时段列表（空 = 全天）
 * @param {Date} now 当前时间
 * @returns {{ok: boolean, window?: string}} 判定
 */
export function inWindows(windows, now) {
  const list = Array.isArray(windows) ? windows.filter(Boolean) : [];
  if (list.length === 0) return { ok: true };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const w of list) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(w);
    if (m === null) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    const hit = start <= end ? nowMin >= start && nowMin <= end : nowMin >= start || nowMin <= end;
    if (hit) return { ok: true, window: w };
  }
  return { ok: false };
}

/**
 * 逐只宠物判断这一拍该不该自主跑一次。
 *
 * 六道闸，顺序就是"先说清为什么不跑"的顺序：
 * 总开关 → 授牌仍有效 → 有 browse 能力 → 自主已开启 → 时段 → 今日自主次数。
 * @param {{autonomyEnabled: boolean, autonomyWindow: string[], autonomyIntervalMin: number}} behavior 配置里的 behavior 段
 * @param {any[]} grants 授牌列表（来自 store.listGrants）
 * @param {(pet: string) => {browse: number, share: number, dm: number}} usageOf 查用量
 * @param {Date} now 当前时间
 * @param {Record<string, number>} lastRunAt 每只宠物上次自主跑的时间戳（内存即可，不用落盘）
 * @returns {Array<{pet: string, run: boolean, reason: string}>} 每只宠物的判定
 */
export function decideAutonomy(behavior, grants, usageOf, now, lastRunAt = {}) {
  const results = [];
  if (behavior.autonomyEnabled !== true) {
    return (grants ?? []).map((g) => ({ pet: g.pet, run: false, reason: '自主总开关未开启' }));
  }
  const win = inWindows(behavior.autonomyWindow, now);
  const gapMs = Math.max(10, Number(behavior.autonomyIntervalMin) || 120) * 60_000;

  for (const g of grants ?? []) {
    const base = { pet: g.pet };
    if (g.alive !== true) {
      results.push({ ...base, run: false, reason: '授牌已过期' });
      continue;
    }
    if (g.caps?.browse !== true) {
      results.push({ ...base, run: false, reason: '没有「浏览作品」能力' });
      continue;
    }
    if (g.autonomy?.enabled !== true) {
      results.push({ ...base, run: false, reason: '这只宠物没开自主' });
      continue;
    }
    if (!win.ok) {
      results.push({ ...base, run: false, reason: `不在自主时段（${behavior.autonomyWindow.join('、')}）` });
      continue;
    }
    const last = Number(lastRunAt[g.pet] ?? 0);
    if (last > 0 && now.getTime() - last < gapMs) {
      results.push({ ...base, run: false, reason: `距上次自主不足 ${Math.round(gapMs / 60_000)} 分钟` });
      continue;
    }
    const perDay = Math.max(1, Number(g.autonomy?.perDay) || 3);
    const used = usageOf(g.pet)?.browse ?? 0;
    // 用"今日浏览总量"当上限：手动点过的也算，避免"配额 3 次但手动点了 3 次还能自主 3 次"
    if (used >= perDay) {
      results.push({ ...base, run: false, reason: `今日已看 ${used} 次，达到自主上限 ${perDay}` });
      continue;
    }
    results.push({ ...base, run: true, reason: `可以自主浏览（今日第 ${used + 1} 次，上限 ${perDay}）` });
  }
  return results;
}

/**
 * 台账里"今天"的键，供 UI 显示。
 * @param {Date} [now] 时间点
 * @returns {string} 日期键
 */
export function todayKey(now = new Date()) {
  return dateKey(now);
}
