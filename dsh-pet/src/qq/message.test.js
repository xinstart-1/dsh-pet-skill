/**
 * 消息解析：不同网关给的形状不一样（数组 / CQ 码字符串），归一化必须只有一种结果。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { atList, hasAt, mentionsName, normalizeEvent, plainText, segmentsOf } from './message.js';

test('消息段：数组原样透传，字符串按 CQ 码解析', () => {
  const arr = segmentsOf([
    { type: 'text', data: { text: 'hi' } },
    { type: 'image', data: { file: 'a.jpg' } },
  ]);
  assert.equal(arr.length, 2);
  assert.equal(arr[1].type, 'image');

  const segs = segmentsOf('你好[CQ:at,qq=10001] 看图[CQ:image,file=x.jpg][CQ:face,id=1]');
  assert.deepEqual(
    segs.map((s) => s.type),
    ['text', 'at', 'text', 'image', 'face'],
  );
  assert.equal(segs[0].data.text, '你好');
  assert.equal(segs[1].data.qq, '10001');
});

test('消息段：不认识的 CQ 码丢掉，不留噪声给模型', () => {
  const segs = segmentsOf('a[CQ:shake]b[CQ:json,data={}]c');
  assert.equal(plainText(segs), 'abc');
});

test('纯文本：图片/表情/语音留占位，@ 保留号码；零宽字符不影响判定', () => {
  const segs = segmentsOf([
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: {} },
    { type: 'record', data: {} },
    { type: 'at', data: { qq: '10001' } },
  ]);
  assert.equal(plainText(segs), '看这个[图片][语音]@10001');
  assert.deepEqual(atList(segs), ['10001']);
  assert.equal(hasAt(segs, '10001'), true);
  assert.equal(hasAt(segs, '99999'), false);
});

test('归一化群消息：会话 id 是群号，@ 自己算 atMe', () => {
  const ev = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    user_id: 20002,
    group_id: 30003,
    message_id: 55,
    time: 1_700_000_000,
    sender: { card: '小明', nickname: 'nick' },
    message: [
      { type: 'text', data: { text: '在吗' } },
      { type: 'at', data: { qq: '10001' } },
    ],
  });
  assert.equal(ev.kind, 'group');
  assert.equal(ev.peerId, '30003');
  assert.equal(ev.groupId, '30003');
  assert.equal(ev.senderId, '20002');
  assert.equal(ev.senderName, '小明');
  assert.equal(ev.atMe, true);
  assert.equal(ev.id, 'group-55');
  assert.equal(ev.text, '在吗@10001');
});

test('归一化私聊：CQ 字符串形态也能用，卡片名为空退回昵称', () => {
  const ev = normalizeEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: '10001',
    user_id: '20002',
    message_id: '7',
    time: 1_700_000_000,
    sender: { card: '', nickname: '小红' },
    message: '在吗[CQ:at,qq=10001]',
  });
  assert.equal(ev.kind, 'private');
  assert.equal(ev.peerId, '20002');
  assert.equal(ev.groupId, '');
  assert.equal(ev.senderName, '小红');
  assert.equal(ev.atMe, true);
  assert.equal(ev.id, 'private-7');
});

test('非消息事件一律 null（心跳、通知、自己发的都不进聊天链路）', () => {
  assert.equal(normalizeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), null);
  assert.equal(normalizeEvent({ post_type: 'notice', notice_type: 'group_increase' }), null);
  assert.equal(normalizeEvent({ post_type: 'message', message_type: 'guild' }), null);
  assert.equal(normalizeEvent(null), null);
});

test('群里叫名字：两个字以上才算，单字不算', () => {
  assert.equal(mentionsName('大肥鱼在不在', ['大肥鱼']), true);
  assert.equal(mentionsName('大肥鱼在不在', ['鱼']), false);
  assert.equal(mentionsName('大肥鱼在不在', []), false);
});
