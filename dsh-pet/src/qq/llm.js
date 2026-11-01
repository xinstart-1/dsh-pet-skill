/**
 * 回复正文生成：**只有一条路——宿主 LLM**（免 Key、用 harness 默认模型）。
 *
 * 这里不重复实现一遍调用（`ctx.llm.stream` 的坑已经踩透了，见 `douyin/llm.js` 文件头）：
 * 直接复用那套适配器，只换 `sessionId`，让 QQ 的请求在宿主日志里能和抖音分开看。
 *
 * 与抖音一致的口径：**没有模板兜底**。生成失败 / 空正文 → 上层不发，只记账。
 * 一句模板腔的"在的，什么事？"发出去，比不回更难看。
 *
 * @module dsh-pet-qq/llm
 */
import { createHostLlm as createBase } from '../douyin/llm.js';

/**
 * 包一层宿主 LLM（sessionId 换成 QQ 的）。
 * @param {{ctx: any}} deps Cordis ctx（需已 inject llm / agentDefaultModel）
 * @returns {{generate: Function, modelLabel: Function}|null} 适配器
 */
export function createHostLlm({ ctx }) {
  return createBase({ ctx, sessionId: 'dsh-pet-qq' });
}

/**
 * 拼这一轮的用户消息（纯函数）。
 *
 * 为什么把"对方是谁"再说一遍（system 里已经有一段）：模型对**离得近**的信息更敏感，
 * 而群聊里最容易出现"对着 A 说的话回给了 B"。这不是人设，只是一句指代。
 * @param {any} event 归一化消息
 * @returns {string} user 正文
 */
export function buildUserPrompt(event) {
  const text = String(event?.text ?? '').trim();
  const body = text === '' ? '（对方只发了一个附件，没有说话）' : text;
  const who = event?.kind === 'group' ? `群里的「${event.senderName}」` : `「${event.senderName}」`;
  return `${who}刚说：${body}\n\n直接给出要发出去的正文（不要前缀、不要引号）。`;
}
