/**
 * 闸门：这是唯一决定"要不要发出去"的地方，每条规则都钉死。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from './config.js';
import { decide, inQuietHours } from './policy.js';

/** 一条私聊消息 */
const priv = (senderId = '20002', text = '在吗') => ({
  kind: 'private',
  peerId: senderId,
  groupId: '',
  senderId,
  senderName: '小明',
  selfId: '10001',
  text,
  atMe: false,
});

/** 一条群消息 */
const group = (groupId = '30003', senderId = '20002', atMe = false) => ({
  kind: 'group',
  peerId: groupId,
  groupId,
  senderId,
  senderName: '小明',
  selfId: '10001',
  text: '在吗',
  atMe,
});

/** 造一份"已开、可回"的配置，再按需覆盖 */
const cfg = (patch = {}) =>
  normalizeConfig({
    enabled: true,
    account: { selfId: '10001', masterId: '90001' },
    chat: { dryRun: false, allowlist: ['20002', '30003'], ...patch },
  });

const ok = (verdict) => assert.equal(verdict.reply, true, verdict.reason);

test('总开关关着：什么都不回', () => {
  const v = decide({ event: priv(), config: normalizeConfig({ ...cfg(), enabled: false }) });
  assert.equal(v.reply, false);
  assert.match(v.reason, /总开关/);
});

test('自己发的消息：永远不回（防自激）', () => {
  const v = decide({ event: priv('10001'), config: cfg() });
  assert.equal(v.reply, false);
  assert.match(v.reason, /自己/);
});

test('私聊：主人在 masterId 里，无条件回', () => {
  ok(decide({ event: priv('90001'), config: cfg({ allowlist: [] }) }));
  const v = decide({
    event: priv('90001'),
    config: cfg({ allowlist: [], masterAlwaysReply: false, privateEnabled: true }),
  });
  assert.equal(v.reply, false);
});

test('私聊：白名单里的回，不在的不回', () => {
  ok(decide({ event: priv('20002'), config: cfg() }));
  const v = decide({ event: priv('55555'), config: cfg() });
  assert.equal(v.reply, false);
  assert.match(v.reason, /白名单/);
});

test('私聊自动回复关掉：主人也不回', () => {
  const v = decide({ event: priv('90001'), config: cfg({ privateEnabled: false }) });
  assert.equal(v.reply, false);
});

test('群聊：群号不在白名单 → 不回（哪怕 @ 了它）', () => {
  const v = decide({ event: group('99999', '20002', true), config: cfg() });
  assert.equal(v.reply, false);
  assert.match(v.reason, /群不在白名单/);
});

test('群聊：群在白名单但没人叫它 → 不回；叫了才回', () => {
  const noCall = decide({ event: group('30003', '20002', false), config: cfg() });
  assert.equal(noCall.reply, false);
  assert.match(noCall.reason, /没人叫我/);
  ok(decide({ event: group('30003', '20002', true), config: cfg() }));
});

test('黑名单压过白名单', () => {
  const v = decide({ event: priv('20002'), config: cfg({ blocklist: ['20002'] }) });
  assert.equal(v.reply, false);
  assert.match(v.reason, /黑名单/);
});

test('静默时段：跨零点也要算对，主人私聊同样挡', () => {
  const at2350 = new Date(2026, 0, 1, 23, 50).getTime();
  const at1200 = new Date(2026, 0, 1, 12, 0).getTime();
  const config = cfg({ quietHours: '23:30-08:00' });
  assert.equal(inQuietHours('23:30-08:00', new Date(at2350)), true);
  assert.equal(inQuietHours('23:30-08:00', new Date(at1200)), false);
  assert.equal(decide({ event: priv('90001'), config, now: at2350 }).reply, false);
  assert.equal(decide({ event: priv('90001'), config, now: at1200 }).reply, true);
});

test('频率：每小时、每天、最小间隔三道都要挡', () => {
  const config = cfg({ maxPerHourPerPeer: 3, maxPerDay: 5, minGapSec: 10 });
  const now = Date.now();
  assert.equal(decide({ event: priv(), config, usage: { hour: 3, day: 3, lastAt: 0 }, now }).reply, false);
  assert.equal(decide({ event: priv(), config, usage: { hour: 0, day: 5, lastAt: 0 }, now }).reply, false);
  assert.equal(decide({ event: priv(), config, usage: { hour: 1, day: 1, lastAt: now - 3000 }, now }).reply, false);
  assert.equal(decide({ event: priv(), config, usage: { hour: 1, day: 1, lastAt: now - 11_000 }, now }).reply, true);
});

test('空文本也回（只发了图/语音）——判断依据是消息段不是文本', () => {
  ok(decide({ event: { ...priv(), text: '' }, config: cfg() }));
});
