/**
 * 身份声明与拆条：一个决定"以什么口气对谁说话"，一个决定"分几条发出去"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSender, parsePeople, peerLabel, scenePrompt } from './people.js';
import { splitReply } from './util.js';

const ev = (patch = {}) => ({
  kind: 'private',
  peerId: '20002',
  groupId: '',
  senderId: '20002',
  senderName: '小明',
  selfId: '10001',
  text: '在吗',
  ...patch,
});

test('熟人名单：只认纯数字号码，坏行丢掉', () => {
  const list = parsePeople(['10001 | 同事 | 爱聊游戏', '小明 | 朋友', '', '10001 | 重复']);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: '10001', relation: '同事', note: '爱聊游戏' });
});

test('身份：主人优先，其次熟人关系，最后陌生人', () => {
  const master = describeSender({ event: ev({ senderId: '90001' }), masterId: '90001' });
  assert.match(master, /主人/);

  const known = describeSender({ event: ev(), masterId: '90001', lines: ['20002 | 同事'] });
  assert.match(known, /同事/);
  assert.match(known, /不是你主人/);

  const stranger = describeSender({ event: ev(), masterId: '90001' });
  assert.match(stranger, /陌生/);
  assert.match(stranger, /不透露主人/);
});

test('身份：名单与主人都没配 → 不注入（老用户语气不变）', () => {
  assert.equal(describeSender({ event: ev(), masterId: '', lines: [] }), '');
});

test('场景约束分私聊/群聊，都不自称 AI', () => {
  assert.match(scenePrompt('private'), /私聊/);
  assert.match(scenePrompt('group'), /群/);
  assert.match(scenePrompt('group'), /不自称 AI/);
});

test('会话名：群聊带群号，私聊带号码', () => {
  assert.equal(peerLabel(ev()), '私聊 · 小明(20002)');
  assert.equal(peerLabel(ev({ kind: 'group', groupId: '30003', peerId: '30003' })), '群 30003 · 小明(20002)');
});

test('拆条：短句不拆', () => {
  assert.deepEqual(splitReply('在的，什么事'), ['在的，什么事']);
  assert.deepEqual(splitReply('   '), []);
});

test('拆条：长句按句号拆开，内容一点不丢，最多三条', () => {
  const text =
    '今天下午我去了一趟超市买了很多东西，排队排了快二十分钟才结完账。然后回家做了饭，炒了两个菜还煮了一锅汤。' +
    '吃完饭又看了会儿书，看到一半困得不行。晚上准备早点睡，明天还要早起出门赶车。';
  // 默认参数下要超过 120 字才拆；这里把阈值调小，专门验拆条逻辑本身
  const parts = splitReply(text, { minLen: 20, maxLen: 30 });
  assert.ok(parts.length > 1, '应该拆开');
  assert.ok(parts.length <= 3, '最多三条');
  assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), '内容不能少');
});

test('拆条：单句超长时不硬切（宁可一条长消息，也不要半句话）', () => {
  const long = '啊'.repeat(300);
  assert.deepEqual(splitReply(long), [long]);
});
