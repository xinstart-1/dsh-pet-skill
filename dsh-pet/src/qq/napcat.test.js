/**
 * 内置网关安装器的行为约束。
 *
 * 这组测试盯的是三件会让用户卡住的事：
 * 1. 生成的 OneBot 配置**方向必须对**（WebSocket「服务器」，不是「客户端」）；
 * 2. 已经登录过的账号也有账号级配置，**必须一并合并**，否则"配置看着对但不生效"；
 * 3. 没装好时**如实报错**，不能写出一份自以为成功的配置。
 *
 * 不测：解压（要跑 PowerShell）与启动（要真进程）——那两条在发布前的真机验证里做，
 * 单测里假装它们成功只会给人虚假的安全感。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_WS_PORT, assetsDir, buildOneBotConfig, bundleInfo, createNapcat, mergeServer } from './napcat.js';

const silent = { info() {}, warn() {}, error() {}, list: () => [] };

test('随包资产齐全：安装器与版本清单都在，版本号与文档一致', async () => {
  const dir = assetsDir();
  assert.ok(dir !== null, '找不到 assets/napcat（打包漏了资产）');
  const info = await bundleInfo();
  assert.equal(info?.version, '4.18.41');
  assert.equal(info?.file, 'NapCat.Shell.Windows.OneKey.zip');
  assert.match(String(info?.sha256), /^[0-9a-f]{64}$/, 'SHA-256 必须是 64 位小写十六进制');
});

test('生成的配置是正向 WebSocket「服务器」：插件是客户端，方向不能反', () => {
  const cfg = buildOneBotConfig('tok-123', 3001);
  assert.deepEqual(cfg.network.websocketClients, [], '不能建反向 WS（那是让网关来连插件）');
  assert.equal(cfg.network.websocketServers.length, 1);
  const server = cfg.network.websocketServers[0];
  assert.equal(server.enable, true);
  assert.equal(server.port, 3001);
  assert.equal(server.token, 'tok-123');
  assert.equal(server.host, '127.0.0.1', '只监听本机');
  assert.equal(server.messagePostFormat, 'array', '插件按消息段数组解析，string 会解析失败');
  assert.equal(server.reportSelfMessage, false, '上报自己的消息会造成"自己回自己"的假象');
  assert.equal(DEFAULT_WS_PORT, 3001, '默认端口要与插件默认 wsUrl 对齐');
});

test('账号级配置合并：同名条目被替换，别人的条目原样保留', () => {
  const existing = {
    network: {
      httpServers: [{ name: 'http', port: 3000, enable: true }],
      websocketServers: [
        { name: '别人的', port: 4000, enable: true },
        { name: 'dsh-pet-qq', port: 9999, token: '旧令牌' },
      ],
    },
    musicSignUrl: 'https://example.com/sign',
  };
  const patch = buildOneBotConfig('新令牌', 3001).network.websocketServers[0];
  const merged = mergeServer(existing, patch);
  const servers = merged.network.websocketServers;
  assert.equal(servers.length, 2, '同名条目应替换而不是追加');
  assert.equal(servers.find((s) => s.name === '别人的')?.port, 4000);
  const ours = servers.find((s) => s.name === 'dsh-pet-qq');
  assert.equal(ours?.port, 3001);
  assert.equal(ours?.token, '新令牌');
  assert.equal(merged.network.httpServers.length, 1, 'HTTP 服务器不能被我们清掉');
  assert.equal(merged.musicSignUrl, 'https://example.com/sign');
});

test('合并对空/损坏的既有配置也不抛错（用户可能手改坏了）', () => {
  const patch = buildOneBotConfig('t', 3001).network.websocketServers[0];
  for (const bad of [null, undefined, {}, { network: null }, { network: { websocketServers: 'x' } }]) {
    const merged = mergeServer(bad, patch);
    assert.equal(merged.network.websocketServers.length, 1);
    assert.equal(merged.network.websocketServers[0].name, 'dsh-pet-qq');
  }
});

test('没装好时如实失败：不给一份"看起来成功"的配置', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-none-'));
  try {
    const napcat = createNapcat({ root, log: silent });
    const st = await napcat.status();
    assert.equal(st.installed, false);
    assert.equal(st.unpacked, false, '空目录不该被当成已解压');
    assert.equal(st.configPath, '');

    const r = await napcat.writeConfig({ port: 3001 });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /还没装好/);

    const launched = await napcat.launch();
    assert.equal(launched.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('装好之后写配置：落到 onebot11.json，并且逐份合并账号级配置', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-ok-'));
  try {
    const appPath = join(root, 'app', 'NapCat.99999.Shell');
    mkdirSync(join(appPath, 'bootmain'), { recursive: true });
    writeFileSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe'), '');
    // 模拟"先登录过一次"：账号级配置已经存在，且里面有一条旧的同名条目
    mkdirSync(join(appPath, 'config'), { recursive: true });
    writeFileSync(
      join(appPath, 'config', 'onebot11_123456.json'),
      JSON.stringify({
        network: {
          websocketServers: [{ name: 'dsh-pet-qq', enable: false, port: 9999, token: '旧令牌' }],
        },
      }),
    );

    const napcat = createNapcat({ root, log: silent });
    const st = await napcat.status();
    assert.equal(st.installed, true);
    assert.equal(st.appPath, appPath);

    const r = await napcat.writeConfig({ port: 3010, token: '' });
    assert.equal(r.ok, true);
    assert.equal(r.wsUrl, 'ws://127.0.0.1:3010');
    assert.equal(String(r.token).length, 24, '没给令牌时要生成一个 24 位十六进制令牌');

    const main = JSON.parse(readFileSync(join(appPath, 'config', 'onebot11.json'), 'utf8'));
    assert.equal(main.network.websocketServers[0].port, 3010);
    assert.equal(main.network.websocketServers[0].token, r.token);

    const account = JSON.parse(readFileSync(join(appPath, 'config', 'onebot11_123456.json'), 'utf8'));
    const ours = account.network.websocketServers.filter((s) => s.name === 'dsh-pet-qq');
    assert.equal(ours.length, 1, '账号级配置里不能留下两条同名服务器');
    assert.equal(ours[0].port, 3010);
    assert.equal(ours[0].enable, true, '旧条目是 enable:false，合并后必须被打开');
    assert.equal(ours[0].token, r.token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('已有令牌会被沿用（重新写配置不该把用户手里的令牌换掉）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-token-'));
  try {
    const appPath = join(root, 'app', 'NapCat.1.Shell');
    mkdirSync(join(appPath, 'bootmain'), { recursive: true });
    writeFileSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe'), '');
    const napcat = createNapcat({ root, log: silent });
    const a = await napcat.writeConfig({ port: 3001, token: 'keep-me' });
    const b = await napcat.writeConfig({ port: 3001, token: 'keep-me' });
    assert.equal(a.token, 'keep-me');
    assert.equal(b.token, 'keep-me');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stop 在没有进程时是幂等的（卸载时会被调用）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-stop-'));
  try {
    const napcat = createNapcat({ root, log: silent });
    assert.deepEqual(await napcat.stop(), { ok: true, already: true });
    assert.deepEqual(await napcat.stop(), { ok: true, already: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wipeSync：只删 napcat 目录（网关与登录态），不碰 QQ 配置与日志', async () => {
  // 这条盯的是「插件页直接删插件」的清理边界：ctx.effect 无法区分禁用/移除，
  // 所以只能清可重下的网关目录，用户配置必须留下。
  const home = mkdtempSync(join(tmpdir(), 'napcat-wipesync-'));
  const qqDir = join(home, 'dsh-pet-qq');
  const root = join(qqDir, 'napcat');
  try {
    const appDir = join(root, 'app', 'NapCat.1.Shell');
    mkdirSync(join(appDir, 'config'), { recursive: true });
    mkdirSync(join(appDir, 'bootmain'), { recursive: true });
    writeFileSync(join(qqDir, 'config.json'), '{"masterId":"123"}');
    writeFileSync(join(qqDir, 'qq.log'), 'log');
    writeFileSync(join(appDir, 'config', 'onebot11_123.json'), '{"login":"session"}');
    writeFileSync(join(appDir, 'bootmain', 'NapCatWinBootMain.exe'), 'exe');

    const napcat = createNapcat({ root, log: silent });
    const r = napcat.wipeSync();
    assert.equal(r.ok, true);
    assert.equal(r.removed, 'deleted');
    assert.equal(existsSync(root), false, 'napcat 目录（含登录态）应被删掉');
    assert.equal(existsSync(join(qqDir, 'config.json')), true, 'QQ 配置必须保留');
    assert.equal(existsSync(join(qqDir, 'qq.log')), true, '日志保留（排障用）');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('wipeSync：目录不存在时是幂等的，不抛错', () => {
  const home = mkdtempSync(join(tmpdir(), 'napcat-wipesync-none-'));
  try {
    const napcat = createNapcat({ root: join(home, 'napcat'), log: silent });
    const r = napcat.wipeSync();
    assert.equal(r.ok, true);
    assert.equal(r.removed, 'absent');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('autoInstall：非 Windows 平台如实拒绝', async () => {
  // 只测平台分支，不真跑安装器（真跑要下 1.2GB QQ，属发布前真机验证）
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'napcat-auto-'));
  try {
    const napcat = createNapcat({ root: home, log: silent });
    const r = await napcat.autoInstall();
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /Windows/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('status()：带出安装状态字段（installing/installPhase/installError）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'napcat-status-'));
  try {
    const napcat = createNapcat({ root: home, log: silent });
    const st = await napcat.status();
    assert.equal(st.installing, false);
    assert.equal(st.installPhase, 'idle');
    assert.equal(st.installError, '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * 把一个二进制串伪造成本地 Node ReadableStream，给 mock fetch 的 body 用。
 * @param {Buffer} buf 数据
 * @returns {ReadableStream<Uint8Array>}
 */
function fakeStream(buf) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= buf.length) return controller.close();
      const end = Math.min(i + 64, buf.length);
      controller.enqueue(new Uint8Array(buf.subarray(i, end)));
      i = end;
    },
  });
}

test('fetchLatest：正常下载并通过 SHA-256 校验，落到数据目录成为优先来源', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-fetch-'));
  // 必须声明在 try 之外：finally 里要用它恢复，写在 try 内会变成作用域外的 ReferenceError
  const savedFetch = globalThis.fetch;
  try {
    const payload = Buffer.from('fake-onekey-zip-bytes-v9');
    const sha = createHash('sha256').update(payload).digest('hex');
    const digest = Buffer.from(sha, 'hex').toString('base64');
    globalThis.fetch = async (url) => {
      if (String(url).includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v9.9.9',
            html_url: 'https://github.com/NapNeko/NapCatQQ/releases/tag/v9.9.9',
            published_at: '2026-11-01T00:00:00Z',
            assets: [
              { name: 'NapCat.Shell.Windows.OneKey.zip', browser_download_url: 'https://x/zip', size: payload.length, digest },
            ],
          }),
        };
      }
      return { ok: true, status: 200, body: fakeStream(payload) };
    };
    const napcat = createNapcat({ root, log: silent });
    const r = await napcat.fetchLatest();
    assert.equal(r.ok, true, '应下载成功');
    assert.equal(r.version, '9.9.9');
    assert.equal(existsSync(join(root, 'NapCat.Shell.Windows.OneKey.zip')), true, 'zip 应落盘到数据目录');
    assert.equal(existsSync(join(root, 'napcat-version.json')), true, '版本清单应落盘');
    const st = await napcat.status();
    assert.equal(st.zipSource, 'downloaded', '下载的应优先于随包内置');
    assert.equal(st.version, '9.9.9');
  } finally {
    // 必须在这里恢复 mock：否则后续用例会拿到被污染的 fetch
    globalThis.fetch = savedFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fetchLatest：SHA-256 不符时丢弃，返回失败且不留盘', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-fetch-bad-'));
  try {
    const payload = Buffer.from('tampered-bytes');
    const wrongSha = '00'.repeat(32);
    const digest = Buffer.from(wrongSha, 'hex').toString('base64');
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v9.9.8',
            html_url: 'https://x',
            published_at: '2026-11-01T00:00:00Z',
            assets: [
              { name: 'NapCat.Shell.Windows.OneKey.zip', browser_download_url: 'https://x/zip', size: payload.length, digest },
            ],
          }),
        };
      }
      return { ok: true, status: 200, body: fakeStream(payload) };
    };
    const napcat = createNapcat({ root, log: silent });
    const r = await napcat.fetchLatest();
    assert.equal(r.ok, false, '校验失败应返回 ok:false');
    assert.match(String(r.reason), /校验失败/);
    assert.equal(existsSync(join(root, 'NapCat.Shell.Windows.OneKey.zip')), false, '坏包不应落盘');
    globalThis.fetch = savedFetch;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fetchLatest：GitHub API 限流（403）时如实返回，不抛异常', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-fetch-rl-'));
  try {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const napcat = createNapcat({ root, log: silent });
    const r = await napcat.fetchLatest();
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /限流/);
    globalThis.fetch = savedFetch;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
