/**
 * 托管层测试：账号绑定、每日配额、自主判定。
 *
 * 这三样是"把一个小号交给宠物"的全部护栏，所以每道闸都要有独立用例：
 * 绑错号、配额用完、时段不对、额度满——都必须**明确拒绝并说清原因**，
 * 而不是悄悄降级成"再跑一次"。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decideAutonomy, inWindows } from './policy.js';
import { createStore } from './store.js';

const silent = { info() {}, warn() {}, error() {} };

/**
 * 造临时 store（四份文件都齐）。
 * @returns {Promise<{store: any, paths: any}>} store 与路径
 */
async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dyacct-host-'));
  const paths = {
    accountsFile: join(dir, 'accounts.json'),
    grantsFile: join(dir, 'grants.json'),
    auditFile: join(dir, 'audit.json'),
    usageFile: join(dir, 'usage.json'),
  };
  const store = createStore({ paths, log: silent });
  await store.load();
  return { store, paths };
}

test('配额：留空 = 不限，填了就卡住', async () => {
  const { store } = await freshStore();
  await store.setGrant('main', { browse: true }, 0, { quota: { browse: 2 } });
  assert.equal(store.quotaOf('main', 'browse'), 2);
  assert.equal(store.quotaOf('main', 'share'), 0, '没填的能力不限');

  assert.equal(store.checkQuota('main', 'browse').ok, true);
  await store.recordUse('main', 'browse');
  assert.equal(store.checkQuota('main', 'browse').ok, true, '1/2 还没满');
  await store.recordUse('main', 'browse');
  const full = store.checkQuota('main', 'browse');
  assert.equal(full.ok, false);
  assert.match(full.reason, /配额用完/);
  assert.equal(full.used, 2);
});

test('配额：跨重启不清零（用量落盘）', async () => {
  const { store, paths } = await freshStore();
  await store.setGrant('main', { browse: true }, 0, { quota: { browse: 5 } });
  await store.recordUse('main', 'browse');
  await store.recordUse('main', 'browse');

  const again = createStore({ paths, log: silent });
  await again.load();
  assert.deepEqual(again.usageOf('main').browse, 2, '重开进程后仍是 2');
  assert.equal(again.checkQuota('main', 'browse').limit, 5);
});

test('配额按宠物与能力分别计数', async () => {
  const { store } = await freshStore();
  await store.setGrant('main', { browse: true, dm: true }, 0, { quota: { browse: 1, dm: 3 } });
  await store.recordUse('main', 'browse');
  assert.equal(store.checkQuota('main', 'browse').ok, false);
  assert.equal(store.checkQuota('main', 'dm').ok, true, 'dm 是另一个桶');
  assert.equal(store.checkQuota('pet2', 'browse').ok, true, '别的宠物不受影响');
});

test('绑定：授牌记住托管账号，撤销后回到默认', async () => {
  const { store } = await freshStore();
  await store.setGrant('main', { browse: true }, 0, { accountOpenId: 'open-2' });
  assert.equal(store.bindOf('main'), 'open-2');
  await store.setGrant('main', { browse: true }, 0, {});
  assert.equal(store.bindOf('main'), '', '再保存一次没选账号 = 回到默认');
});

test('自主：六道闸依次拦住', () => {
  const now = new Date('2026-10-27T12:00:00'); // 周二中午
  const behavior = { autonomyEnabled: true, autonomyWindow: ['09:00-23:00'], autonomyIntervalMin: 120 };
  const alive = { pet: 'main', caps: { browse: true }, alive: true, autonomy: { enabled: true, perDay: 3 } };
  const usage = { browse: 0, share: 0, dm: 0 };
  const usageOf = () => usage;

  assert.equal(decideAutonomy({ ...behavior, autonomyEnabled: false }, [alive], usageOf, now)[0].run, false);
  assert.match(decideAutonomy({ ...behavior, autonomyEnabled: false }, [alive], usageOf, now)[0].reason, /总开关/);

  const expired = { ...alive, alive: false };
  assert.match(decideAutonomy(behavior, [expired], usageOf, now)[0].reason, /过期/);

  const noBrowse = { ...alive, caps: {} };
  assert.match(decideAutonomy(behavior, [noBrowse], usageOf, now)[0].reason, /浏览/);

  const noAuto = { ...alive, autonomy: { enabled: false, perDay: 3 } };
  assert.match(decideAutonomy(behavior, [noAuto], usageOf, now)[0].reason, /没开自主/);

  const late = new Date('2026-10-27T23:30:00');
  assert.match(decideAutonomy(behavior, [alive], usageOf, late)[0].reason, /自主时段/);

  const justRan = { main: now.getTime() - 30 * 60_000 };
  assert.match(decideAutonomy(behavior, [alive], usageOf, now, justRan)[0].reason, /不足/);

  const capped = { ...usage, browse: 3 };
  assert.match(decideAutonomy(behavior, [alive], () => capped, now)[0].reason, /达到自主上限/);

  const ok = decideAutonomy(behavior, [alive], usageOf, now)[0];
  assert.equal(ok.run, true);
  assert.match(ok.reason, /今日第 1 次/);
});

test('自主：手动用量也算进额度（不会"配额 3 次 + 自主 3 次"）', () => {
  const now = new Date('2026-10-27T12:00:00');
  const behavior = { autonomyEnabled: true, autonomyWindow: ['00:00-23:59'], autonomyIntervalMin: 10 };
  const grant = { pet: 'main', caps: { browse: true }, alive: true, autonomy: { enabled: true, perDay: 3 } };
  const r = decideAutonomy(behavior, [grant], () => ({ browse: 2, share: 0, dm: 0 }), now)[0];
  assert.equal(r.run, true, '2/3 还能再跑一次');
  const r2 = decideAutonomy(behavior, [grant], () => ({ browse: 3, share: 0, dm: 0 }), now)[0];
  assert.equal(r2.run, false);
});

test('时段：支持跨零点', () => {
  assert.equal(inWindows(['23:00-02:00'], new Date('2026-10-27T01:00:00')).ok, true);
  assert.equal(inWindows(['23:00-02:00'], new Date('2026-10-27T12:00:00')).ok, false);
  assert.equal(inWindows([], new Date('2026-10-27T12:00:00')).ok, true, '空 = 全天');
  assert.equal(inWindows(['bad'], new Date('2026-10-27T12:00:00')).ok, false, '非法时段不当作全天');
});

// ── 菜单事件解析：这道闸防止把错误信息当成"宠物点了菜单" ──
import { parseMenuEvents } from './pet-bridge.js';

test('菜单事件：真实形状 {ok,events} 才认，且只认自己注册的文案', () => {
  const allowed = ['抖音：看我最新作品', '抖音账号设置'];
  const okShape = { ok: true, events: { '抖音：看我最新作品': 'main', 抖音账号设置: null, 别人的项: 'main' } };
  const parsed = parseMenuEvents(okShape, allowed);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.hits, [{ label: '抖音：看我最新作品', pet: 'main' }], 'null 与未注册的项都要丢掉');
});

test('菜单事件：owner 未注册的错误体不会被当成点击（历史上的假审计就是它）', () => {
  const err = { ok: false, reason: 'unknown-owner', message: '这个 owner 没有注册，重新注册即可' };
  const parsed = parseMenuEvents(err, ['抖音：看我最新作品']);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.hits, []);
  assert.equal(parsed.reason, 'unknown-owner');
});

test('菜单事件：纯文本 404 / 缺 events / 超长 petId 一律不认', () => {
  assert.equal(parseMenuEvents('404 not found', ['x']).ok, false);
  assert.equal(parseMenuEvents({ ok: true }, ['x']).ok, false);
  assert.equal(parseMenuEvents({ ok: true, events: { x: 'a'.repeat(200) } }, ['x']).hits.length, 0);
});
