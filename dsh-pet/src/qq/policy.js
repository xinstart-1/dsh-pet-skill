/**
 * 回不回、为什么回：**纯函数**，整个 QQ 链路唯一的判断闸门。
 *
 * 把它单独拿出来（而不是散在 service 里）的理由很实际：一条消息回错了人，代价是"别人
 * 看到你没说过的话"，比任何崩溃都难收场。所以这里的每条规则都要能被单测钉住。
 *
 * 判断顺序是刻意的：开关 → 自己 → 黑名单 → 静默时段 → 白名单/身份 → 频率。
 * 前四条与"是谁"无关，先挡掉最便宜的；频率放最后，因为只有真要回的时候才该查账。
 *
 * @module dsh-pet-qq/policy
 */

/** 不回：带原因（原因会写进日志与审计，排障全靠它） */
const no = (reason) => ({ reply: false, reason, why: '' });

/**
 * 现在是不是静默时段。支持跨零点（`23:30-08:00`）。
 * @param {string} range 形如 `23:30-08:00`
 * @param {Date} [date] 当前时间
 * @returns {boolean} 在静默时段返回 true
 */
export function inQuietHours(range, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(range ?? '').trim());
  if (m === null) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * 决定要不要回这条消息。
 * @param {{event: any, config: any, selfId?: string, usage?: {hour: number, day: number, lastAt: number}, mention?: boolean, now?: number}} args 参数
 *   `mention` = 被 @ 或被叫了名字（群聊用；atMe 由消息解析给出）
 * @returns {{reply: boolean, reason: string, why: 'master'|'allowlist'|'group'|''}} 结论
 */
export function decide({ event, config, selfId = '', usage = null, mention = false, now = Date.now() }) {
  const c = config?.chat ?? {};
  const list = Array.isArray(c.allowlist) ? c.allowlist : [];
  const blocked = Array.isArray(c.blocklist) ? c.blocklist : [];

  if (config?.enabled !== true) return no('总开关关着');
  if (event === null || typeof event !== 'object') return no('没有消息');

  const self = String(selfId || event.selfId || '').trim();
  if (self !== '' && event.senderId === self) return no('自己发的');

  const ids = [event.senderId, event.peerId, event.groupId].filter((v) => typeof v === 'string' && v !== '');
  if (ids.some((id) => blocked.includes(id))) return no('在黑名单里');

  if (String(c.quietHours ?? '') !== '' && inQuietHours(c.quietHours, new Date(now))) {
    return no(`静默时段 ${c.quietHours}`);
  }

  const master = String(config?.account?.masterId ?? '').trim();
  const isMaster = master !== '' && event.senderId === master;

  /** 命中身份的理由，后段频率检查通过后才变成结论（两条分支一定会赋值） */
  let why;

  if (event.kind === 'private') {
    if (c.privateEnabled !== true) return no('私聊自动回复关着');
    if (isMaster && c.masterAlwaysReply !== false) why = 'master';
    else if (list.includes(event.senderId)) why = 'allowlist';
    else return no(isMaster ? '主人私聊自动回复已关' : '私聊不在白名单');
  } else if (event.kind === 'group') {
    // 群聊要求两件事：群号在白名单里（明确"这个群我可以说话"），且有人叫了它。
    // 只靠"被 @"不够安全——被拉进一个陌生群时，@ 一下就能让它开口。
    if (!list.includes(event.groupId)) return no('群不在白名单');
    // `mention` 由上层算（@ 或叫了名字）；只传事件时退回 `atMe`，两条路都算数
    const called = mention === true || event.atMe === true;
    if (!called && c.groupAtOnly !== false) return no('群里没人叫我');
    why = 'group';
  } else {
    return no(`不认识的消息类型 ${String(event.kind)}`);
  }

  const u = usage ?? { hour: 0, day: 0, lastAt: 0 };
  const perHour = Number(c.maxPerHourPerPeer) || 20;
  const perDay = Number(c.maxPerDay) || 200;
  const gapSec = Number(c.minGapSec) || 0;
  if (u.day >= perDay) return no(`今日总量到顶（${perDay} 条）`);
  if (u.hour >= perHour) return no(`这个会话每小时到顶（${perHour} 条）`);
  if (gapSec > 0 && u.lastAt > 0 && now - u.lastAt < gapSec * 1000) {
    return no(`距上次回复不到 ${gapSec} 秒`);
  }

  return { reply: true, reason: '', why };
}
