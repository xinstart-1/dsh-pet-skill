/**
 * 配置归一化：用户输入只有经过这里才可信，下游不再防御。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, normalizeConfig } from './config.js';

test('空输入 = 安全的默认值：关着、试运行、只连本机', () => {
  const c = normalizeConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.chat.dryRun, true);
  assert.equal(c.chat.allowlist.length, 0);
  assert.equal(c.gateway.wsUrl, DEFAULT_CONFIG.gateway.wsUrl);
});

test('地址校验：非 ws 协议回落默认值；HTTP 地址去掉尾斜杠', () => {
  assert.equal(
    normalizeConfig({ gateway: { wsUrl: 'http://127.0.0.1:3001' } }).gateway.wsUrl,
    DEFAULT_CONFIG.gateway.wsUrl,
  );
  assert.equal(normalizeConfig({ gateway: { wsUrl: 'wss://example.com/ws' } }).gateway.wsUrl, 'wss://example.com/ws');
  assert.equal(
    normalizeConfig({ gateway: { httpUrl: 'http://127.0.0.1:3001/' } }).gateway.httpUrl,
    'http://127.0.0.1:3001',
  );
});

test('号码列表：只留 4–12 位纯数字，去空去重保序', () => {
  const c = normalizeConfig({ chat: { allowlist: ['123456', ' 123456 ', 'abc', '12', '9876543210', 30003] } });
  assert.deepEqual(c.chat.allowlist, ['123456', '9876543210', '30003']);
});

test('数值夹紧：延迟不能为负、上限不能为 0、轮数不超 40', () => {
  const c = normalizeConfig({
    chat: { delayMs: [-5, 999999], maxPerHourPerPeer: 0, maxPerDay: 999999, historyTurns: 99 },
  });
  assert.deepEqual(c.chat.delayMs, [0, 60_000]);
  assert.equal(c.chat.maxPerHourPerPeer, 1);
  assert.equal(c.chat.maxPerDay, 5000);
  assert.equal(c.chat.historyTurns, 40);
});

test('静默时段：格式不对就当没设，不要拿坏值去算时间', () => {
  assert.equal(normalizeConfig({ chat: { quietHours: '晚上' } }).chat.quietHours, '');
  assert.equal(normalizeConfig({ chat: { quietHours: '23:30-08:00' } }).chat.quietHours, '23:30-08:00');
});

test('布尔开关：只有明确的 false 才关，缺字段一律按"开"（贴心的默认）', () => {
  const on = normalizeConfig({ chat: {} });
  assert.equal(on.chat.privateEnabled, true);
  assert.equal(on.chat.groupAtOnly, true);
  assert.equal(on.behavior.recordAudit, true);
  const off = normalizeConfig({ chat: { privateEnabled: false, groupAtOnly: false } });
  assert.equal(off.chat.privateEnabled, false);
  assert.equal(off.chat.groupAtOnly, false);
});
