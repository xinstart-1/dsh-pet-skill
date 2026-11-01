/**
 * 节奏：什么时候该准备下一条。
 *
 * 这是纯函数模块——`now` 由调用方注入，所以「周三 21:07 已达日上限」这种判定能写单测，
 * 而不需要等真到那个点。定时器只负责每 30 秒问一次。
 *
 * 五道闸按「先说清为什么不发」的顺序排：总开关 → 模式 → 星期 → 时段 → 日上限 → 冷却 → 到点。
 *
 * @module dsh-pet-douyin/schedule
 */
import { describeWeekdays } from './config.js';
import { dateKey } from './util.js';

/**
 * `HH:MM` → 当天第几分钟。
 * @param {string} hhmm 时间文本
 * @returns {number} 分钟数（非法返回 -1）
 */
export function minutesOf(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? '').trim());
  return m === null ? -1 : Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 时间点 → 当天第几分钟。
 * @param {Date} d 时间点
 * @returns {number} 分钟数
 */
export function dayMinutes(d) {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 星期数字（1=周一 … 7=周日）。
 * @param {Date} d 时间点
 * @returns {number} 1–7
 */
export function weekdayOf(d) {
  const w = d.getDay();
  return w === 0 ? 7 : w;
}

/**
 * 当前是否落在任一允许时段内。时段支持跨零点（`23:00-02:00`）。
 * @param {string[]} windows 时段列表
 * @param {number} nowMin 当天分钟数
 * @returns {{ok: boolean, window?: string}} 判定结果
 */
export function inWindows(windows, nowMin) {
  const list = Array.isArray(windows) ? windows.filter(Boolean) : [];
  if (list.length === 0) return { ok: true };
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
 * 把排期状态里属于「今天」的计数取出来（跨日自动归零）。
 * @param {{lastRunAt?: number, dayKey?: string, dayCount?: number, fired?: Record<string, boolean>}} sched 排期状态
 * @param {Date} now 当前时间
 * @returns {{dayKey: string, dayCount: number, lastRunAt: number, fired: Record<string, boolean>}} 今日视图
 */
export function todayView(sched, now) {
  const key = dateKey(now);
  const sameDay = sched.dayKey === key;
  return {
    dayKey: key,
    dayCount: sameDay ? (sched.dayCount ?? 0) : 0,
    lastRunAt: sched.lastRunAt ?? 0,
    fired: sameDay ? (sched.fired ?? {}) : {},
  };
}

/**
 * 判定现在该不该准备一条。
 * @param {object} config 成品配置
 * @param {{lastRunAt?: number, dayKey?: string, dayCount?: number, fired?: Record<string, boolean>}} sched 排期状态
 * @param {Date} now 当前时间
 * @returns {{run: boolean, reason: string, slot?: string}} 判定结果；`reason` 是给用户看的原话
 */
export function decideRun(config, sched, now) {
  const sc = config.schedule;
  const today = todayView(sched, now);
  if (!config.enabled) return { run: false, reason: '插件已关闭' };
  if (sc.mode === 'manual') return { run: false, reason: '手动模式（只有点菜单或敲命令才会准备）' };

  const weekday = weekdayOf(now);
  if (!sc.weekdays.includes(weekday)) {
    return { run: false, reason: `今天不在发布日（已选 ${describeWeekdays(sc.weekdays)}）` };
  }

  const nowMin = dayMinutes(now);
  const win = inWindows(sc.windows, nowMin);
  if (!win.ok) return { run: false, reason: `当前不在允许时段（${sc.windows.join('、')}）` };

  if (today.dayCount >= sc.maxPerDay) return { run: false, reason: `今日已准备 ${today.dayCount} 条，达到上限` };

  if (today.lastRunAt > 0) {
    const gapMin = (now.getTime() - today.lastRunAt) / 60_000;
    if (gapMin < sc.minGapMinutes) {
      const left = Math.ceil(sc.minGapMinutes - gapMin);
      return { run: false, reason: `距上次不足 ${sc.minGapMinutes} 分钟（还要等 ${left} 分钟）` };
    }
  }

  if (sc.mode === 'interval') {
    const dueAt = (today.lastRunAt || 0) + sc.intervalMinutes * 60_000;
    if (today.lastRunAt > 0 && now.getTime() < dueAt) {
      return { run: false, reason: `间隔模式：还差 ${Math.ceil((dueAt - now.getTime()) / 60_000)} 分钟` };
    }
    return { run: true, reason: `间隔模式：已到 ${sc.intervalMinutes} 分钟` };
  }

  if (sc.mode === 'daily') {
    // 只补最近一个已过点但没发过的时刻，避免停机一天后一次性把几个时刻全打出来
    const slots = sc.dailyTimes
      .map((t) => ({ t, min: minutesOf(t) }))
      .filter((s) => s.min >= 0 && s.min <= nowMin)
      .sort((a, b) => b.min - a.min);
    const pending = slots.find((s) => today.fired[`${today.dayKey}|${s.t}`] !== true);
    if (pending === undefined) return { run: false, reason: '每日模式的时刻都过了（或今天已经发过）' };
    return { run: true, reason: `每日模式：到 ${pending.t} 了`, slot: pending.t };
  }

  return { run: false, reason: '未知的排期模式' };
}

/**
 * 估算下一次自动准备的时间（只用于 UI 展示，标「约」）。
 * @param {object} config 成品配置
 * @param {{lastRunAt?: number, dayKey?: string, dayCount?: number, fired?: Record<string, boolean>}} sched 排期状态
 * @param {Date} now 当前时间
 * @returns {number|null} 毫秒时间戳；手动模式或今天已满返回 null
 */
export function estimateNextRun(config, sched, now) {
  const sc = config.schedule;
  if (!config.enabled || sc.mode === 'manual') return null;
  const today = todayView(sched, now);
  if (today.dayCount >= sc.maxPerDay) return null;

  if (sc.mode === 'interval') {
    if (today.lastRunAt === 0) return now.getTime();
    return Math.max(now.getTime(), today.lastRunAt + sc.intervalMinutes * 60_000);
  }

  // daily：今天还没过的最近一个时刻；都过完了看明天第一个
  const slots = sc.dailyTimes.map((t) => ({ t, min: minutesOf(t) })).filter((s) => s.min >= 0);
  const nowMin = dayMinutes(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const upcoming = slots
    .filter((s) => s.min > nowMin || today.fired[`${today.dayKey}|${s.t}`] !== true)
    .map((s) => {
      const when = new Date(now);
      when.setHours(Math.floor(s.min / 60), s.min % 60, 0, 0);
      if (when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1);
      return when.getTime();
    })
    .sort((a, b) => a - b);
  return upcoming[0] ?? null;
}

/**
 * 记录一次「已准备」，供下一次判定用。
 * @param {{lastRunAt?: number, dayKey?: string, dayCount?: number, fired?: Record<string, boolean>}} sched 排期状态
 * @param {Date} now 当前时间
 * @param {string} [slot] 命中的每日时刻（interval 模式不传）
 * @param {{count?: boolean}} [opts] `count=false` 只登记时刻，不计入日上限（先占坑、准备成功后再计数）
 * @returns {object} 新的排期状态
 */
export function markRun(sched, now, slot, opts = {}) {
  const today = todayView(sched, now);
  const fired = { ...today.fired };
  if (slot) fired[`${today.dayKey}|${slot}`] = true;
  return {
    lastRunAt: opts.count === false ? today.lastRunAt : now.getTime(),
    dayKey: today.dayKey,
    dayCount: opts.count === false ? today.dayCount : today.dayCount + 1,
    fired,
  };
}
