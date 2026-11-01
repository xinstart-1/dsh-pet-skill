/**
 * OneBot v11 事件的解析与归一化（纯函数，全部可单测）。
 *
 * 为什么不直接用网关给的原始结构：不同实现（NapCat / LLBot / SnowLuma）
 * 在 `message` 上是"消息段数组"还是"CQ 码字符串"并不统一，`sender` 里的字段也各写各的。
 * 上层（策略、提示词、日志）只应该看见一种形状——归一化就在这一层做完，
 * 以后换网关不用改业务逻辑。
 *
 * 归一化后的形状：
 * ```
 * {
 *   id, kind: 'private'|'group', peerId, groupId, senderId, senderName,
 *   selfId, text, atMe, segments, time
 * }
 * ```
 * `peerId` 私聊是对方 QQ 号、群聊是群号——它就是"会话 id"，白名单、限速、上下文都按它算。
 *
 * @module dsh-pet-qq/message
 */

/**
 * 把 `message` 字段变成消息段数组。
 *
 * 字符串形态按 CQ 码解析：只认 `at` / `image` / `face` 三类（其余 CQ 码直接丢掉，
 * 保留原文只会让模型看到一串 `[CQ:...]` 噪声）。
 * @param {any} message 原始 message 字段
 * @returns {Array<{type: string, data: any}>} 消息段
 */
export function segmentsOf(message) {
  if (Array.isArray(message)) {
    return message
      .filter((seg) => seg !== null && typeof seg === 'object' && typeof seg.type === 'string')
      .map((seg) => ({ type: seg.type, data: seg.data ?? {} }));
  }
  const raw = String(message ?? '');
  if (raw === '') return [];

  /** @type {Array<{type: string, data: any}>} */
  const out = [];
  let rest = raw;
  const CQ = /\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  for (const m of rest.matchAll(CQ)) {
    if (m.index > last) out.push({ type: 'text', data: { text: rest.slice(last, m.index) } });
    const params = {};
    for (const pair of m[2].split(',')) {
      const [k, v] = pair.split('=');
      if (k !== undefined && k !== '' && v !== undefined) params[k] = v;
    }
    if (m[1] === 'at') out.push({ type: 'at', data: { qq: params.qq ?? '' } });
    else if (m[1] === 'image') out.push({ type: 'image', data: { file: params.file ?? '', url: params.url ?? '' } });
    else if (m[1] === 'face') out.push({ type: 'face', data: { id: params.id ?? '' } });
    last = m.index + m[0].length;
  }
  if (last < rest.length) out.push({ type: 'text', data: { text: rest.slice(last) } });
  return out;
}

/**
 * 消息段 → 给人看的一行文字。
 *
 * 图片/表情/语音不带进模型（拿不到内容，带个占位符反而让模型以为是文字），
 * 但**保留占位**，否则"发图不说话"就变成空消息、被当成没说话。
 * @param {Array<{type: string, data: any}>} segments 消息段
 * @returns {string} 文本
 */
export function plainText(segments) {
  return segments
    .map((seg) => {
      if (seg.type === 'text') return String(seg.data?.text ?? '');
      if (seg.type === 'at') return seg.data?.qq === 'all' ? '@全体成员' : `@${seg.data?.qq ?? ''}`;
      if (seg.type === 'image') return '[图片]';
      if (seg.type === 'face') return '[表情]';
      if (seg.type === 'record') return '[语音]';
      if (seg.type === 'video') return '[视频]';
      if (seg.type === 'file') return '[文件]';
      return '';
    })
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 这条消息里 @ 了谁。
 * @param {Array<{type: string, data: any}>} segments 消息段
 * @returns {string[]} QQ 号列表（含 `all`）
 */
export function atList(segments) {
  return segments.filter((seg) => seg.type === 'at').map((seg) => String(seg.data?.qq ?? ''));
}

/**
 * 这条消息有没有 @ 指定的人。
 * @param {Array<{type: string, data: any}>} segments 消息段
 * @param {string} id QQ 号
 * @returns {boolean} 是否 @ 了
 */
export function hasAt(segments, id) {
  const target = String(id ?? '').trim();
  if (target === '') return false;
  return atList(segments).includes(target);
}

/** 号码规整：OneBot 的 id 有时是数字有时是字符串，统一成字符串 */
const id = (v) => String(v ?? '').trim();

/**
 * 原始事件 → 归一化消息。不是消息事件返回 null（心跳、生命周期、通知都不进聊天链路）。
 * @param {any} raw 网关推来的事件
 * @returns {{id: string, kind: 'private'|'group', peerId: string, groupId: string, senderId: string, senderName: string, selfId: string, text: string, atMe: boolean, segments: Array<any>, time: number}|null} 归一化消息
 */
export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  if (raw.post_type !== 'message') return null;
  const kind = raw.message_type;
  if (kind !== 'private' && kind !== 'group') return null;

  const selfId = id(raw.self_id);
  const senderId = id(raw.user_id ?? raw.sender?.user_id);
  if (senderId === '') return null;

  const segments = segmentsOf(raw.message);
  const groupId = kind === 'group' ? id(raw.group_id) : '';
  const peerId = kind === 'group' ? groupId : senderId;
  if (peerId === '') return null;

  const senderName = String(raw.sender?.card ?? '').trim() || String(raw.sender?.nickname ?? '').trim() || senderId;

  return {
    id: `${kind}-${id(raw.message_id) || `${senderId}-${id(raw.time)}`}`,
    kind,
    peerId,
    groupId,
    senderId,
    senderName,
    selfId,
    text: plainText(segments),
    atMe: selfId !== '' && hasAt(segments, selfId),
    segments,
    time: Number(raw.time) > 0 ? Number(raw.time) * 1000 : Date.now(),
  };
}

/**
 * 群消息里"叫了名字"也算叫人。
 *
 * 群里不一定有人会 @，叫一声"大肥鱼"也要能接话。名字取自配置（宠物名），
 * 只做包含匹配、要求两个字以上——单字名字会命中所有正常聊天。
 * @param {string} text 消息正文
 * @param {string[]} names 名字列表
 * @returns {boolean} 是否被叫到
 */
export function mentionsName(text, names) {
  const body = String(text ?? '');
  if (body === '') return false;
  return (Array.isArray(names) ? names : []).some((n) => {
    const name = String(n ?? '').trim();
    return name.length >= 2 && body.includes(name);
  });
}
