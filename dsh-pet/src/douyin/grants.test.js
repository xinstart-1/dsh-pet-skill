/**
 * 授牌单测：这是整个插件的安全边界，必须把"没授牌 / 过期 / 能力不全"三种拒绝都钉住。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore, grantAlive, CAPS } from './store.js';

/** 静默日志 */
const silent = { info() {}, warn() {}, error() {} };

/**
 * 造一个临时 store。
 * @returns {Promise<object>} store
 */
async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), 'dyacct-store-'));
  const store = createStore({
    paths: { accountsFile: join(dir, 'a.json'), grantsFile: join(dir, 'g.json'), auditFile: join(dir, 'au.json') },
    log: silent,
  });
  await store.load();
  return store;
}

test('能力清单固定四项（加能力必须改这条测试）', () => {
  assert.deepEqual([...CAPS], ['browse', 'share', 'dm', 'publish']);
});

test('没授牌：任何能力都拒绝，且说明原因', async () => {
  const store = await fresh();
  for (const cap of CAPS) {
    const r = store.checkGrant('main', cap);
    assert.equal(r.ok, false);
    assert.match(r.reason, /没有授牌/);
  }
});

test('授牌后只放行勾选的能力', async () => {
  const store = await fresh();
  await store.setGrant('main', { browse: true, share: false, dm: true }, 0);
  assert.equal(store.checkGrant('main', 'browse').ok, true);
  assert.equal(store.checkGrant('main', 'dm').ok, true);
  assert.equal(store.checkGrant('main', 'share').ok, false);
  assert.match(store.checkGrant('main', 'share').reason, /没有「分享」能力/);
});

test('授牌按宠物隔离：给了 main 不等于给了 pet2', async () => {
  const store = await fresh();
  await store.setGrant('main', { browse: true }, 0);
  assert.equal(store.checkGrant('main', 'browse').ok, true);
  assert.equal(store.checkGrant('pet2', 'browse').ok, false);
});

test('过期授牌自动失效', async () => {
  const store = await fresh();
  const now = Date.now();
  await store.setGrant('main', { browse: true }, 1);
  assert.equal(store.checkGrant('main', 'browse', now).ok, true);
  assert.equal(store.checkGrant('main', 'browse', now + 2 * 3600_000).ok, false);
  assert.match(store.checkGrant('main', 'browse', now + 2 * 3600_000).reason, /过期/);
  assert.equal(store.listGrants(now + 2 * 3600_000)[0].alive, false);
});

test('空能力 = 撤销', async () => {
  const store = await fresh();
  await store.setGrant('main', { browse: true }, 0);
  const r = await store.setGrant('main', {}, 0);
  assert.deepEqual(r.caps, {});
  assert.equal(store.checkGrant('main', 'browse').ok, false);
});

test('撤销是幂等的', async () => {
  const store = await fresh();
  await store.setGrant('main', { browse: true }, 0);
  assert.equal(await store.revokeGrant('main'), true);
  assert.equal(await store.revokeGrant('main'), false);
});

test('非法能力名不会被写进授牌', async () => {
  const store = await fresh();
  const g = await store.setGrant('main', { browse: true, root: true, admin: true }, 0);
  assert.deepEqual(g.caps, { browse: true });
});

test('没带宠物 id 直接拒绝', async () => {
  const store = await fresh();
  assert.equal(store.checkGrant('', 'browse').ok, false);
  assert.equal(store.checkGrant(undefined, 'browse').ok, false);
});

test('账号解绑后授牌仍在（授牌属于宠物，不属于账号）', async () => {
  const store = await fresh();
  await store.upsertAccount({ openId: 'o1', accessToken: 'a', refreshToken: 'r', addedAt: Date.now() });
  await store.setGrant('main', { browse: true }, 0);
  await store.removeAccount('o1');
  assert.equal(store.account(), null);
  assert.equal(store.checkGrant('main', 'browse').ok, true);
});

test('账号列表不带明文 token', async () => {
  const store = await fresh();
  await store.upsertAccount({ openId: 'o1', accessToken: 'secret-token', refreshToken: 'r', nickname: '阿花' });
  const list = store.listAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].hasAccessToken, true);
  assert.equal(JSON.stringify(list).includes('secret-token'), false);
});

test('grantAlive：0 表示永久', () => {
  assert.equal(grantAlive({ expiresAt: 0 }, Date.now()), true);
  assert.equal(grantAlive({ expiresAt: Date.now() + 1000 }, Date.now()), true);
  assert.equal(grantAlive({ expiresAt: Date.now() - 1000 }, Date.now()), false);
});
