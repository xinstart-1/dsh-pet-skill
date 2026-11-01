/**
 * 托管端到端：配额在能力层真的拦得住、宠物真的用"绑给它的那个号"。
 *
 * 单测已经证明 store 那层算得对；这里要证明**接线没接漏**——
 * 配额拒绝必须变成 `code: 'quota'` 与 HTTP 429，绑定账号必须体现在
 * 请求头里的 access-token 上（而不是"内存里改了一下"）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ROUTE_PREFIX, createRouter } from './router.js';
import { createService } from './service.js';

const silent = { info() {}, warn() {}, error() {}, list: () => [] };

/**
 * 假抖音：记录每次 video_list 用的 access-token。
 * @returns {{fetchImpl: typeof fetch, tokens: string[]}} 桩
 */
function mockDouyin() {
  /** @type {string[]} */
  const tokens = [];
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  /** @type {any} */
  const fetchImpl = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === '/oauth/access_token/') {
      return json({ data: { access_token: 'act-first', open_id: 'open-1', expires_in: 7200, refresh_token: 'r1', refresh_expires_in: 86400, scope: 'user_info video.list' } });
    }
    if (u.pathname === '/oauth/userinfo/') {
      return json({ data: { open_id: 'open-1', nickname: '大号', avatar_larger: { url_list: [] } } });
    }
    if (u.pathname === '/api/douyin/v1/video/video_list/') {
      tokens.push(String(init?.headers?.['access-token'] ?? ''));
      return json({ data: { list: [{ item_id: 'v1', title: '一条作品', share_url: 'https://v.douyin.com/x/', statistics: { play_count: 1 } }], has_more: false } });
    }
    return json({ message: 'not found' }, 404);
  };
  return { fetchImpl, tokens };
}

/**
 * 装服务并绑好第一个号。
 * @returns {Promise<{service: any, tokens: string[], setPort: (p: number) => void}>} 环境
 */
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dyacct-quota-'));
  const { fetchImpl, tokens } = mockDouyin();
  let port = 0;
  const service = createService({
    home,
    log: silent,
    getPort: () => port,
    fetchImpl,
    copy: async () => ({ ok: true, via: 'stub' }),
  });
  await service.init();
  await service.saveConfig({ app: { clientKey: 'k', clientSecret: 's' }, behavior: { throttleMs: 0, cacheSec: 0 } });
  await service.exchangeCode('code-1');
  return { service, tokens, setPort: (p) => (port = p) };
}

test('配额在能力层生效：第 2 次直接被拒，且标成 quota', async () => {
  const { service } = await setup();
  await service.setGrant({ pet: 'main', caps: { browse: true }, quota: { browse: 1 } });

  const first = await service.browse({ pet: 'main', force: true });
  assert.equal(first.count, 1);
  assert.equal(service.store.usageOf('main').browse, 1);

  await assert.rejects(() => service.browse({ pet: 'main', force: true }), (error) => {
    assert.equal(/** @type {any} */ (error).code, 'quota');
    assert.match(error.message, /配额用完/);
    return true;
  });
  assert.equal(service.store.usageOf('main').browse, 1, '被拒的那次不该计数');
});

test('失败不消耗配额：抖音报错时用量不变', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dyacct-quota-fail-'));
  let calls = 0;
  const service = createService({
    home,
    log: silent,
    getPort: () => 0,
    fetchImpl: async (input) => {
      const u = new URL(String(input));
      if (u.pathname === '/oauth/access_token/') {
        return new Response(JSON.stringify({ data: { access_token: 'a', open_id: 'o', expires_in: 7200, scope: 'user_info video.list' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.pathname === '/oauth/userinfo/') {
        return new Response(JSON.stringify({ data: { open_id: 'o', nickname: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      calls += 1;
      return new Response(JSON.stringify({ data: { error_code: 2190007, description: '接口调用超限' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    copy: async () => ({ ok: true }),
  });
  await service.init();
  await service.saveConfig({ app: { clientKey: 'k', clientSecret: 's' }, behavior: { throttleMs: 0 } });
  await service.exchangeCode('c');
  await service.setGrant({ pet: 'main', caps: { browse: true }, quota: { browse: 2 } });

  await assert.rejects(() => service.browse({ pet: 'main', force: true }), /接口调用超限/);
  assert.equal(calls, 1);
  assert.equal(service.store.usageOf('main').browse, 0, '失败不该吃掉额度');
  await service.stop();
});

test('绑定的账号真的被用上（看请求头里的 token）', async () => {
  const { service, tokens } = await setup();
  // 手动塞第二个号：它有独立 token
  await service.store.upsertAccount({
    openId: 'open-2',
    accessToken: 'act-second',
    refreshToken: 'r2',
    accessExpiresAt: Date.now() + 3600_000,
    refreshExpiresAt: Date.now() + 86400_000,
    scope: 'user_info video.list',
    nickname: '小号',
    addedAt: Date.now(),
  });

  await service.setCurrent('open-1'); // 新绑的号会被设为默认，这里手动切回大号
  await service.setGrant({ pet: 'main', caps: { browse: true } });
  await service.browse({ pet: 'main', force: true });
  assert.equal(tokens.at(-1), 'act-first', '没绑定 = 用默认账号');

  await service.setGrant({ pet: 'main', caps: { browse: true }, accountOpenId: 'open-2' });
  await service.browse({ pet: 'main', force: true });
  assert.equal(tokens.at(-1), 'act-second', '绑定后必须换成小号的 token');

  // 绑定的号被解绑 → 明确报错，而不是悄悄退回大号
  await service.unlink('open-2');
  await assert.rejects(() => service.browse({ pet: 'main', force: true }), /已解绑/);
});

test('HTTP：配额用完返回 429', async () => {
  const { service, setPort } = await setup();
  await service.setGrant({ pet: 'main', caps: { browse: true }, quota: { browse: 1 } });

  const handler = createRouter({ service, log: silent });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {any} */ (server.address()).port;
  setPort(port);
  const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`;

  const first = await fetch(`${base}/api/videos?pet=main&force=1`);
  assert.equal(first.status, 200);

  const second = await fetch(`${base}/api/videos?pet=main&force=1`);
  assert.equal(second.status, 429);
  const body = await second.json();
  assert.equal(body.code, 'quota');
  assert.match(body.reason, /配额用完/);

  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.equal(state.grants[0].usage.browse, 1, 'state 里能看到用量');
  assert.equal(state.grants[0].quota.browse, 1);

  await new Promise((resolve) => server.close(resolve));
  await service.stop();
});

test('HTTP /api/grants 必须透传托管字段（只改 service 忘了路由会静默清空）', async () => {
  const { service, setPort } = await setup();
  await service.store.upsertAccount({
    openId: 'open-2',
    accessToken: 'act-second',
    accessExpiresAt: Date.now() + 3600_000,
    scope: 'user_info video.list',
    nickname: '小号',
    addedAt: Date.now(),
  });

  const handler = createRouter({ service, log: silent });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {any} */ (server.address()).port;
  setPort(port);
  const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`;

  const res = await fetch(`${base}/api/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pet: 'main',
      caps: { browse: true },
      quota: { browse: 2 },
      accountOpenId: 'open-2',
      autonomy: { enabled: true, perDay: 4 },
      ttlHours: 0,
    }),
  });
  assert.equal(res.status, 200);
  const grant = (await res.json()).grant;
  assert.equal(grant.accountOpenId, 'open-2', '托管账号没传过去');
  assert.equal(grant.quota.browse, 2, '配额没传过去');
  assert.equal(grant.autonomy.enabled, true);
  assert.equal(grant.autonomy.perDay, 4);

  await new Promise((resolve) => server.close(resolve));
  await service.stop();
});

test('发布包也是一项能力：没授牌拒绝，授了才出包，且受配额约束', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'dyacct-publish-'));
  const inbox = join(home, 'inbox');
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, '宠物素材.mp4'), Buffer.alloc(700 * 1024, 3));

  const service = createService({ home, log: silent, getPort: () => 0, copy: async () => ({ ok: true }) });
  await service.init();
  await service.saveConfig({
    enabled: true,
    source: { dir: inbox, minSizeMB: 0.1, recursive: false, excludeKeywords: ['temp'] },
    transcode: { mode: 'none' },
    pack: { outDir: join(home, 'packs'), copyCaption: false, openUploadPage: false },
    pet: { bubble: false, workStatus: false },
  });

  await assert.rejects(() => service.publish({ pet: 'main' }), /没有授牌/);

  await service.setGrant({ pet: 'main', caps: { publish: true }, quota: { publish: 1 } });
  const r = await service.publish({ pet: 'main' });
  assert.equal(r.ok, true);
  assert.ok(r.pack.dir.includes('packs'), '发布包落在配置的目录里');
  assert.equal(service.store.usageOf('main').publish, 1, '用量记在 publish 桶里');

  await assert.rejects(() => service.publish({ pet: 'main' }), /配额用完/);
  await service.stop();
});
