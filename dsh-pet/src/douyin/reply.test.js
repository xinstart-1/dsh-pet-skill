/**
 * 回复链路纯逻辑：入站差分。
 * 自动回复翻旧账 / 无限自激，是这个函数要挡的事——钉死在这。
 * （回复正文只走大模型，没有模板可测；见 llm.test.js 与 service.js 的 composeReply。）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { newIncoming } from './reply.js';

test('差分：只挑这轮新出现的，保序，跳过空串', () => {
  assert.deepEqual(newIncoming(['a', 'b'], ['b', 'c', '', 'd', 'a']), ['c', 'd']);
  assert.deepEqual(newIncoming([], ['x', 'x', 'x']), ['x'], '同一条消息同一轮只算一次');
  assert.deepEqual(newIncoming(['a'], []), []);
});

test('差分：seen 里没有的东西全算新（首次快照由调用方负责，这里只管差）', () => {
  assert.deepEqual(newIncoming(undefined ?? [], ['m1', 'm2']), ['m1', 'm2']);
});
