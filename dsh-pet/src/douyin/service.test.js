/**
 * 端到端：假抖音后端 → 扫码授权 → 授牌 → 浏览/分享/草稿 → HTTP 接口。
 *
 * 全部用注入的 `fetchImpl`，不连真抖音；`copy` 也换成桩，免得测试去动系统剪贴板。
 * 重点验证两条：**没授牌就是 403**、**token 过期会自己刷新**。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ROUTE_PREFIX, createRouter } from './router.js';
import { createService } from './service.js';

/** 静默日志 */
const silent = { info() {}, warn() {}, error() {}, list: () => [] };

/**
 * 假抖音：按路径返回固定数据，并记录调用顺序。
 * @returns {{fetchImpl: typeof fetch, calls: string[]}} 桩
 */
function mockDouyin() {
  /** @type {string[]} */
  const calls = [];
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  /** @type {any} */
  const fetchImpl = async (input, init) => {
    const u = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    switch (u.pathname) {
      case '/oauth/access_token/':
        return json({
          data: {
            access_token: 'act-1',
            open_id: 'open-1',
            expires_in: 7200,
            refresh_token: 'rft-1',
            refresh_expires_in: 86400,
            scope: 'user_info video.list',
            error_code: 0,
          },
          message: 'success',
        });
      case '/oauth/refresh_token/':
        return json({
          data: {
            access_token: 'act-2',
            open_id: 'open-1',
            expires_in: 7200,
            refresh_token: 'rft-2',
            refresh_expires_in: 86400,
            scope: 'user_info video.list',
            error_code: 0,
          },
        });
      case '/oauth/userinfo/':
        return json({
          data: {
            open_id: 'open-1',
            nickname: '测试号',
            avatar_larger: { url_list: ['https://cdn/a.jpg'] },
            follower_count: 12345,
          },
        });
      case '/api/douyin/v1/video/video_list/':
        return json({
          data: {
            list: [
              {
                item_id: 'v1',
                title: '第一条作品',
                cover: { url_list: ['https://cdn/c1.jpg'] },
                share_url: 'https://v.douyin.com/abc/',
                statistics: { play_count: 12000, digg_count: 340, comment_count: 12 },
              },
              { item_id: 'v2', title: '第二条', cover: 'https://cdn/c2.jpg', share_url: 'https://v.douyin.com/def/' },
            ],
            cursor: 0,
            has_more: false,
            error_code: 0,
          },
        });
      default:
        return json({ message: 'not found' }, 404);
    }
  };
  return { fetchImpl, calls };
}

/**
 * 造一个装好的服务（含 mock 抖音、桩剪贴板）。
 * @param {{actions: string[]}} clip 剪贴板桩记录
 * @returns {Promise<object>} 服务
 */
async function setup(clip) {
  const home = await mkdtemp(join(tmpdir(), 'dyacct-e2e-'));
  const { fetchImpl, calls } = mockDouyin();
  let port = 0;
  const service = createService({
    home,
    log: silent,
    getPort: () => port,
    fetchImpl,
    copy: async (text) => {
      clip.actions.push(String(text));
      return { ok: true, via: 'stub' };
    },
    now: () => Date.now(),
  });
  await service.init();
  await service.saveConfig({
    app: { clientKey: 'aw-test', clientSecret: 'secret-test' },
    behavior: { throttleMs: 0, cacheSec: 0, browseCount: 5 },
    share: { template: '{title}｜{url}', copyOnShare: true },
    dm: { greeting: '在的', tone: '随意', signature: '—— 桌宠代笔' },
  });
  return { service, calls, getPort: () => port, setPort: (p) => (port = p) };
}

test('未配置凭据时不给授权链接', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dyacct-empty-'));
  const service = createService({ home, log: silent, getPort: () => 0 });
  await service.init();
  const r = service.authorizeUrl();
  assert.equal(r.ok, false);
  assert.match(r.reason, /Client Key/);
});

test('扫码授权 → 授牌 → 三能力 → HTTP 接口', async (t) => {
  /** @type {{actions: string[]}} */
  const clip = { actions: [] };
  const env = await setup(clip);
  const { service, calls } = env;

  await t.test('授权链接带上 client_key 与 scope', () => {
    const r = service.authorizeUrl();
    assert.equal(r.ok, true);
    const u = new URL(/** @type {string} */ (r.url));
    assert.equal(u.searchParams.get('client_key'), 'aw-test');
    assert.match(String(u.searchParams.get('scope')), /video\.list/);
  });

  await t.test('粘贴整条回调地址换 token，并读到昵称', async () => {
    const r = await service.exchangeCode('https://a.com/cb?code=code-1&state=s');
    assert.equal(r.ok, true, r.reason);
    const acc = service.state().account;
    assert.equal(acc.nickname, '测试号');
    assert.equal(acc.followerCount, 12345);
    assert.equal(acc.scopeBrowse, true);
    assert.ok(calls.includes('POST /oauth/access_token/'));
    assert.ok(calls.includes('GET /oauth/userinfo/'));
  });

  await t.test('没授牌：浏览被拒绝且记审计', async () => {
    await assert.rejects(() => service.browse({ pet: 'main' }), /没有授牌/);
    const audit = service.state().audit;
    assert.ok(audit.some((a) => a.ok === false && a.cap === 'browse'));
  });

  await t.test('授牌后能列作品', async () => {
    await service.setGrant({ pet: 'main', caps: { browse: true, share: true, dm: true } });
    const r = await service.browse({ pet: 'main' });
    assert.equal(r.count, 2);
    assert.match(r.summary, /第一条作品/);
    assert.equal(r.items[0].cover, 'https://cdn/c1.jpg');
  });

  await t.test('撤回单项能力：share 立刻失效，browse 仍可用', async () => {
    await service.setGrant({ pet: 'main', caps: { browse: true, dm: true } });
    await assert.rejects(() => service.share({ pet: 'main', itemId: 'v1' }), /没有「分享」能力/);
    const ok = await service.browse({ pet: 'main' });
    assert.equal(ok.count, 2);
  });

  await t.test('分享卡：模板替换 + 复制 + 明确标注不是官方分享', async () => {
    await service.setGrant({ pet: 'main', caps: { browse: true, share: true, dm: true } });
    const r = await service.share({ pet: 'main', itemId: 'v1' });
    assert.equal(r.text, '第一条作品｜https://v.douyin.com/abc/');
    assert.equal(r.copied.ok, true);
    assert.match(/** @type {string} */ (r.note), /分享至抖音私信|权限/);
  });

  await t.test('私信：只出草稿，channel=draft，且带步骤', async () => {
    const r = await service.dm({ pet: 'main', topic: '想问你个事', to: '阿花' });
    assert.equal(r.channel, 'draft');
    assert.equal(r.text, '在的\n\n想问你个事\n\n—— 桌宠代笔');
    assert.equal(r.steps.length, 3);
    // 第 0 步是「从哪儿打开抖音」（会随 openApp / 装没装客户端而变），收件人必须在后面几步里
    assert.match(r.steps.join(' / '), /阿花/);
    assert.equal(r.opened, false, '没传 openApp 就不该打开任何东西');
    assert.equal(service.dmStatus().supported, false);
  });

  await t.test('token 过期会自动刷新（滚动保存 refresh_token）', async () => {
    const before = service.store.account();
    await service.store.patchAccount(before.openId, { accessExpiresAt: Date.now() - 1000 });
    const r = await service.browse({ pet: 'main', force: true });
    assert.equal(r.count, 2);
    const after = service.store.account();
    assert.equal(after.accessToken, 'act-2', '用的是刷新后的 token');
    assert.equal(after.refreshToken, 'rft-2', 'refresh_token 也换新了');
    assert.ok(calls.indexOf('POST /oauth/refresh_token/') > 0);
  });

  await t.test('HTTP：状态 200、无授牌 403、有授牌 200、设置页可访问', async () => {
    const handler = createRouter({ service, log: silent });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = /** @type {any} */ (server.address()).port;
    env.setPort(port);
    const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`;

    const state = await fetch(`${base}/api/state`).then((r) => r.json());
    assert.equal(state.account.nickname, '测试号');
    assert.equal(state.dm.supported, false);
    assert.ok(Array.isArray(state.pets));
    assert.equal(JSON.stringify(state).includes('secret-test'), false, '状态里不能出现 Client Secret');

    const denied = await fetch(`${base}/api/videos?pet=陌生人`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'no-grant');

    const allowed = await fetch(`${base}/api/videos?pet=main`).then((r) => r.json());
    assert.equal(allowed.count, 2);

    const page = await fetch(`${base}/`).then((r) => r.text());
    assert.ok(page.includes('宠物权限'));

    await new Promise((resolve) => server.close(resolve));
  });

  await service.stop();
});

test('授权失败时把抖音的错误原因透出来', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dyacct-err-'));
  const service = createService({
    home,
    log: silent,
    getPort: () => 0,
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: { error_code: 10008, description: '授权码已失效' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    copy: async () => ({ ok: true }),
  });
  await service.init();
  await service.saveConfig({ app: { clientKey: 'k', clientSecret: 's' }, behavior: { throttleMs: 0 } });
  const r = await service.exchangeCode('code-x');
  assert.equal(r.ok, false);
  assert.match(r.reason, /授权码已失效/);
  await service.stop();
});

test('JSON 体不被接受时自动改表单重试一次', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dyacct-form-'));
  /** @type {string[]} */
  const seen = [];
  const service = createService({
    home,
    log: silent,
    getPort: () => 0,
    fetchImpl: async (input, init) => {
      const u = new URL(String(input));
      const ct = String(/** @type {any} */ (init?.headers)?.['content-type'] ?? '');
      seen.push(`${u.pathname} ${ct}`);
      if (u.pathname === '/oauth/access_token/' && ct.includes('json')) {
        return new Response('bad request', { status: 400 });
      }
      return new Response(
        JSON.stringify({ data: { access_token: 'a', open_id: 'o', expires_in: 60, scope: 'user_info' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
    copy: async () => ({ ok: true }),
  });
  await service.init();
  await service.saveConfig({ app: { clientKey: 'k', clientSecret: 's' }, behavior: { throttleMs: 0 } });
  const r = await service.exchangeCode('c');
  assert.equal(r.ok, true, r.reason);
  assert.ok(
    seen.some((s) => s.includes('application/x-www-form-urlencoded')),
    '重试时改用了表单',
  );
  await service.stop();
});
