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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
