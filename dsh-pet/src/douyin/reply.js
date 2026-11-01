/**
 * 回复链路的纯逻辑部分：入站消息差分。
 *
 * 为什么单独一个模块：自动回复最怕**把自己的回复当成新消息**（无限自激）。
 * 差分只认"这轮看到、上轮没看到"的文本，而方向过滤（`isFromMe`）在 DOM 层做，
 * 这里只管"哪些是新来的"。
 *
 * 这里**没有回复模板**：正文一律由大模型现写（见 `llm.js` 与 `service.js` 的 `composeReply`）。
 * 模板腔的固定句子对方一眼就看得出是机器人，所以生成不出来就不发。
 *
 * @module dsh-pet-douyin/reply
 */

/**
 * 求本轮新出现的入站文本（保序）。
 * @param {Iterable<string>} seen 已经见过的文本
 * @param {string[]} incoming 本轮读到的入站文本（旧→新）
 * @returns {string[]} 新出现的文本（旧→新）
 */
export function newIncoming(seen, incoming) {
  const known = new Set(seen);
  const out = [];
  for (const t of incoming) {
    const s = String(t ?? '');
    if (s === '' || known.has(s)) continue;
    known.add(s);
    out.push(s);
  }
  return out;
}
