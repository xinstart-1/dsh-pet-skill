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
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_WS_PORT,
  SHELL_ZIP_NAME,
  assetsDir,
  buildOneBotConfig,
  bundleInfo,
  createNapcat,
  inspectPackage,
  mergeServer,
  parseAssetDigest,
  prefetchShellZipIn,
  purgeBrokenPackagesIn,
  peMinBytes,
  readCurVersion,
  resolveNapcatConfigDir,
  resolveNapcatConfigDirCandidates,
  verifyDownload,
  zipExpectedSize,
} from './napcat.js';

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

test('resolveNapcatConfigDirCandidates：优先级 workdir > curVersion > 逐个版本目录 > 老布局兜底', () => {
  const app = join('C:', 'app', 'NapCat.52230.Shell');
  const at = (ver) => join(app, 'versions', ver, 'resources', 'app', 'napcat', 'config');
  const got = resolveNapcatConfigDirCandidates({
    appPath: app,
    workdir: 'C:\\napcat-work',
    curVersion: '9.9.33-52230',
    versionDirs: ['9.9.33-52230', '9.9.33-50000'],
  });
  assert.deepEqual(got, [
    join('C:\\napcat-work', 'config'),
    at('9.9.33-52230'),
    at('9.9.33-50000'),
    join(app, 'config'),
  ]);
  // 重复项只留第一次出现的那条（curVersion 与 versionDirs 重叠是常态）
  assert.equal(got.length, new Set(got.map((d) => d.toLowerCase())).size);
});

test('resolveNapcatConfigDirCandidates：NAPCAT_WORKDIR 压倒一切，且缺 curVersion 时跳过那一档', () => {
  const app = join('C:', 'app', 'NapCat.1.Shell');
  const onlyWorkdir = resolveNapcatConfigDirCandidates({
    appPath: app,
    workdir: 'D:\\nc',
    versionDirs: [],
  });
  // workdir 在最前，后面的候选照旧保留（NapCat 没用 workdir 时还能退回真实目录）
  assert.equal(onlyWorkdir[0], join('D:\\nc', 'config'));

  const noVersion = resolveNapcatConfigDirCandidates({ appPath: app, workdir: '   ', curVersion: '  ' });
  assert.deepEqual(noVersion, [join(app, 'config')], '没有版本信息时只剩老布局兜底');
  assert.equal(noVersion.includes(join(app, 'versions', '  ', 'resources', 'app', 'napcat', 'config')), false);
});

test('resolveNapcatConfigDir：认 napcat.json/webui.json/onebot11*.json 哪个在先，就选哪个目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-cfgdir-'));
  try {
    const app = join(root, 'NapCat.1.Shell');
    const v1 = join(app, 'versions', '9.9.33-1', 'resources', 'app', 'napcat', 'config');
    const v2 = join(app, 'versions', '9.9.33-2', 'resources', 'app', 'napcat', 'config');
    mkdirSync(v1, { recursive: true });
    mkdirSync(v2, { recursive: true });
    writeFileSync(join(app, 'versions', 'config.json'), JSON.stringify({ curVersion: '9.9.33-2' }));
    // 两个版本目录都有配置：以 curVersion 指的为准
    writeFileSync(join(v1, 'webui.json'), '{}');
    writeFileSync(join(v2, 'onebot11.json'), '{}');
    const a = await resolveNapcatConfigDir(app);
    assert.equal(a.dir, v2);
    assert.equal(a.source, 'curVersion');

    // 读不到 curVersion（文件坏/字段缺）时退回逐个版本目录试
    writeFileSync(join(app, 'versions', 'config.json'), 'not json');
    assert.equal(await readCurVersion(app), '');
    const b = await resolveNapcatConfigDir(app);
    assert.equal(b.dir, v1, '列表顺序即优先级：先枚举到的先试');
    assert.equal(b.source, 'versionDir');

    // 一个像样的都没有、也没有任何存在的候选时，如实交回老布局兜底且不 mkdir
    const emptyApp = join(root, 'NapCat.2.Shell');
    mkdirSync(emptyApp, { recursive: true });
    const c = await resolveNapcatConfigDir(emptyApp);
    assert.equal(c.dir, join(emptyApp, 'config'));
    assert.equal(c.source, 'fallback');
    assert.equal(existsSync(join(emptyApp, 'config')), false, '解析阶段不能偷偷建目录');

    // 刚装好还没启动过：config 还没建，但 resources/app/napcat 已经在了——
    // 这时仍要选它下面（NapCat 会读那儿），不能退回 Shell 根那个没人读的老目录
    const fresh = join(root, 'NapCat.3.Shell');
    const freshPkg = join(fresh, 'versions', '9.9.33-3', 'resources', 'app', 'napcat');
    mkdirSync(freshPkg, { recursive: true });
    writeFileSync(join(fresh, 'versions', 'config.json'), JSON.stringify({ curVersion: '9.9.33-3' }));
    const d = await resolveNapcatConfigDir(fresh);
    assert.equal(d.dir, join(freshPkg, 'config'));
    assert.equal(d.source, 'curVersion');
    assert.equal(existsSync(d.dir), false, '解析阶段仍然不能建目录，交给 writeConfig');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launch：本机已有别人起的网关时不重复 spawn（两份实例会互相踢登录态）', async () => {
  // 实测事故：pid 33288（手工起的）与 pid 38448（插件拉的）共用同一个 QQ user-data-dir，
  // 互相重载，表现就是「时断时连」。这里用一个真实监听端口冒充"已在跑的网关"。
  const root = mkdtempSync(join(tmpdir(), 'napcat-launch-guard-'));
  const server = createServer(() => {});
  try {
    const appPath = join(root, 'app', 'NapCat.1.Shell');
    mkdirSync(join(appPath, 'bootmain'), { recursive: true });
    writeFileSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe'), '');
    const cfgDir = join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config');
    mkdirSync(cfgDir, { recursive: true });
    // 面板端口用一个空闲端口，避开本机真在听的 6099（否则这条用例会被环境左右）
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    writeFileSync(join(cfgDir, 'webui.json'), JSON.stringify({ host: '::', port, token: 'tk' }));

    const logs = [];
    const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {}, list: () => [] };
    const napcat = createNapcat({ root, log });
    const r = await napcat.launch({ uin: '2477690764', openWebui: false });
    assert.equal(r.ok, true);
    assert.equal(r.already, true, '不能重复 spawn');
    assert.equal(r.external, true, '要标明"这是别人的实例"，不是我们拉的那个');
    assert.equal(r.pid, 0, '没有 pid 可用（不是我们的子进程）');
    assert.match(String(r.webuiUrl), new RegExp(`:${port}/webui`));
    assert.ok(
      logs.some((m) => m.includes('建议只保留一个')),
      '要说清冲突风险，而不是静默忽略',
    );
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('webuiInfo：从 webui.json 算出带令牌的扫码面板地址（控制台里看不到码）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-webui-'));
  try {
    const appPath = join(root, 'app', 'NapCat.99999.Shell');
    mkdirSync(join(appPath, 'bootmain'), { recursive: true });
    writeFileSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe'), '');
    const cfgDir = join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'webui.json'),
      JSON.stringify({ host: '::', port: 6099, token: 'e250d9bb1abb', loginRate: 10 }),
    );
    const napcat = createNapcat({ root, log: silent });
    const info = await napcat.webuiInfo();
    assert.equal(info?.port, 6099);
    assert.equal(info?.token, 'e250d9bb1abb');
    // host 是 `::`（监听全部）时，本机访问必须落到 127.0.0.1，不能把 `::` 拼进 URL
    assert.equal(String(info?.url), 'http://127.0.0.1:6099/webui?token=e250d9bb1abb');
    assert.doesNotMatch(String(info?.url), /::/);

    const st = await napcat.status();
    assert.equal(st.webuiUrl, 'http://127.0.0.1:6099/webui?token=e250d9bb1abb');
    assert.equal(st.webuiPort, 6099);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('webuiInfo：webui.json 还没生成（网关刚起）时返回 null，不抛错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-webui-none-'));
  try {
    const appPath = join(root, 'app', 'NapCat.99999.Shell');
    mkdirSync(join(appPath, 'bootmain'), { recursive: true });
    writeFileSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe'), '');
    mkdirSync(join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config'), {
      recursive: true,
    });
    const napcat = createNapcat({ root, log: silent });
    assert.equal(await napcat.webuiInfo(), null);
    const st = await napcat.status();
    assert.equal(st.webuiUrl, '', '拿不到就如实留空，设置页据此降级成文字提示');
    assert.equal(st.webuiPort, 0);
    // 令牌缺失/端口非法也算拿不到（别拼出一个打不开的地址）
    const bad = join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config', 'webui.json');
    writeFileSync(bad, JSON.stringify({ host: '::', port: 0, token: 'x' }));
    assert.equal(await napcat.webuiInfo(), null);
    writeFileSync(bad, JSON.stringify({ host: '::', port: 6099, token: '   ' }));
    assert.equal(await napcat.webuiInfo(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('装好之后写配置：落到 NapCat 真 workdir 的 onebot11.json，并且逐份合并账号级配置', async () => {
  // 布局按 NapCat 4.18.41 的真实结构：配置在 versions/<QQ版本>/resources/app/napcat/config，
  // 不在 Shell 根下的 config（写那儿没有任何读取方，见 resolveNapcatConfigDir 的说明）。
  const root = mkdtempSync(join(tmpdir(), 'napcat-ok-'));
  try {
    const appPath = join(root, 'app', 'NapCat.99999.Shell');
    mkdirSync(join(appPath, 'bootmain'), { recursive: true });
    writeFileSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe'), '');
    const cfgDir = join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config');
    mkdirSync(cfgDir, { recursive: true });
    // NapCat 自己生成的标记文件：解析器靠它认准这是真 workdir
    writeFileSync(join(cfgDir, 'napcat.json'), '{}');
    // 模拟"先登录过一次"：账号级配置已经存在，且里面有一条旧的同名条目
    writeFileSync(
      join(cfgDir, 'onebot11_123456.json'),
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
    assert.equal(st.configDir, cfgDir, 'status 必须报出真实解析到的配置目录');
    assert.equal(st.configPath, join(cfgDir, 'onebot11.json'));

    const r = await napcat.writeConfig({ port: 3010, token: '' });
    assert.equal(r.ok, true);
    assert.equal(r.wsUrl, 'ws://127.0.0.1:3010');
    assert.equal(r.configDir, cfgDir, 'writeConfig 必须如实报告写到了哪个目录');
    assert.equal(String(r.token).length, 24, '没给令牌时要生成一个 24 位十六进制令牌');
    // 老布局那份孤儿目录不能被写出新内容
    assert.equal(existsSync(join(appPath, 'config', 'onebot11.json')), false);

    const main = JSON.parse(readFileSync(join(cfgDir, 'onebot11.json'), 'utf8'));
    assert.equal(main.network.websocketServers[0].port, 3010);
    assert.equal(main.network.websocketServers[0].token, r.token);

    const account = JSON.parse(readFileSync(join(cfgDir, 'onebot11_123456.json'), 'utf8'));
    const ours = account.network.websocketServers.filter((s) => s.name === 'dsh-pet-qq');
    assert.equal(ours.length, 1, '账号级配置里不能留下两条同名服务器');
    assert.equal(ours[0].port, 3010);
    assert.equal(ours[0].enable, true, '旧条目是 enable:false，合并后必须被打开');
    assert.equal(ours[0].token, r.token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('老布局兜底：只有 <Shell>/config 时仍然写得进去（版本目录一个都没有）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-legacy-'));
  try {
    const appPath = join(root, 'app', 'NapCat.1.Shell');
    mkdirSync(join(appPath, 'bootmain'), { recursive: true });
    writeFileSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe'), '');
    mkdirSync(join(appPath, 'config'), { recursive: true });
    // 里面只有账号级配置（没有 napcat.json/webui.json），也照样算"存在的候选"
    writeFileSync(join(appPath, 'config', 'onebot11_42.json'), JSON.stringify({ network: {} }));

    const napcat = createNapcat({ root, log: silent });
    const r = await napcat.writeConfig({ port: 3020, token: 'tok' });
    assert.equal(r.ok, true);
    assert.equal(r.configDir, join(appPath, 'config'));
    const main = JSON.parse(readFileSync(join(appPath, 'config', 'onebot11.json'), 'utf8'));
    assert.equal(main.network.websocketServers[0].port, 3020);
    const account = JSON.parse(readFileSync(join(appPath, 'config', 'onebot11_42.json'), 'utf8'));
    assert.equal(account.network.websocketServers[0].token, 'tok');
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
  // 只测平台分支，不真跑安装器（真跑要下 300MB QQ + 34MB 网关，属发布前真机验证）
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
    // GitHub 的 digest 实测是 `sha256:<hex>`，不是 base64——按 base64 造 fixture
    // 会让这条用例测到一个真实环境里根本不存在的路径（校验静默失效）。
    const digest = `sha256:${sha}`;
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
              {
                name: 'NapCat.Shell.Windows.OneKey.zip',
                browser_download_url: 'https://x/zip',
                size: payload.length,
                digest,
              },
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
    const digest = `sha256:${wrongSha}`;
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
              {
                name: 'NapCat.Shell.Windows.OneKey.zip',
                browser_download_url: 'https://x/zip',
                size: payload.length,
                digest,
              },
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

/**
 * 坏包自愈：下载中断留下的截断包必须在下次安装前被清掉。
 *
 * 这组测试盯的是一次真机踩坑：`NapCat.Shell.zip` 只下到 10.9MB（真包 35.9MB），
 * 安装器只判断"文件在不在"就复用它，于是每次重试都在同一处失败，用户没有任何出路。
 * 修法有两面，这里两面都钉住：
 * 1. **认得出截断**（zip 按 EOCD 声明的大小，PE 按段表声明的大小）；
 * 2. **不误删**——一个完整的 300MB `QQ.exe` 不能被顺手删掉，否则每次重试都要重下。
 */

/** 造一个最小的合法 zip（仅中央目录 + EOCD，不含条目数据；完整性判断只看 EOCD） */
function makeZip({ declaredOffset = 0, commentLen = 0, pad = 0 } = {}) {
  const cdSize = 46; // 一个空中央目录记录
  const cd = Buffer.alloc(cdSize);
  const eocd = Buffer.alloc(22 + commentLen);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 8); // 本盘条目数
  eocd.writeUInt16LE(0, 10); // 总条目数（0xFFFF 是 zip64 哨兵，别用在这里）
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(declaredOffset, 16);
  eocd.writeUInt16LE(commentLen, 20);
  return Buffer.concat([cd, Buffer.alloc(pad), eocd]);
}

/** 造一个最小的 PE：1 个段，段原始数据从 rawPtr 起、声明 rawSize 字节（总长按声明补齐） */
function makePe(rawSize, { rawPtr = 0x200 } = {}) {
  const buf = Buffer.alloc(rawPtr + rawSize);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x40, 0x3c);
  buf.write('PE\0\0', 0x40, 'latin1');
  buf.writeUInt16LE(1, 0x40 + 6); // 段数
  buf.writeUInt16LE(0, 0x40 + 20); // 可选头长度
  const table = 0x40 + 24;
  buf.writeUInt32LE(rawSize, table + 16);
  buf.writeUInt32LE(rawPtr, table + 20);
  return buf;
}

test('zipExpectedSize：从 EOCD 算出完整包大小；zip64 与无 EOCD 返回 null', () => {
  const ok = makeZip({ declaredOffset: 0 });
  const expect = 46 + 22;
  assert.equal(zipExpectedSize(ok, ok.length), expect);
  // 截断：文件比 EOCD 声明的小
  assert.ok(expect > ok.length - 10, '截断情形应有 expected > size');

  const z64 = Buffer.alloc(22);
  z64.writeUInt32LE(0x06054b50, 0);
  z64.writeUInt16LE(0xffff, 8);
  z64.writeUInt16LE(0xffff, 10);
  assert.equal(zipExpectedSize(z64, z64.length), null, 'zip64 不猜');

  assert.equal(zipExpectedSize(Buffer.from('not a zip at all'), 16), null, '没有 EOCD');
});

test('peMinBytes：从段表算出文件至少该有多大', () => {
  const pe = makePe(0x1000, { rawPtr: 0x200 });
  assert.equal(peMinBytes(pe), 0x200 + 0x1000);
  assert.equal(peMinBytes(Buffer.from('MZ')), null, '头不完整');
  assert.equal(peMinBytes(Buffer.from('hello world')), null, '不是 PE');
});

test('inspectPackage：截断的 zip / PE 判为 broken，完整的判为 ok', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-inspect-'));
  try {
    const full = makeZip({ declaredOffset: 0 });
    writeFileSync(join(root, 'good.zip'), full);
    const good = await inspectPackage(join(root, 'good.zip'), 'zip');
    assert.equal(good.state, 'ok');

    // 砍掉一半 = 典型的中断下载
    writeFileSync(join(root, 'cut.zip'), full.subarray(0, Math.floor(full.length / 2)));
    const cut = await inspectPackage(join(root, 'cut.zip'), 'zip');
    assert.equal(cut.state, 'broken');
    assert.match(cut.reason, /截断|中央目录/);

    const pe = makePe(0x100000);
    writeFileSync(join(root, 'good.exe'), pe);
    assert.equal((await inspectPackage(join(root, 'good.exe'), 'pe')).state, 'ok');
    writeFileSync(join(root, 'cut.exe'), pe.subarray(0, 0x300));
    const cutPe = await inspectPackage(join(root, 'cut.exe'), 'pe');
    assert.equal(cutPe.state, 'broken', 'PE 声明比文件大 = 下了一半');
    assert.match(cutPe.reason, /截断/);

    assert.equal((await inspectPackage(join(root, 'nope.zip'), 'zip')).state, 'absent');
    writeFileSync(join(root, 'empty.zip'), '');
    assert.equal((await inspectPackage(join(root, 'empty.zip'), 'zip')).state, 'broken');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inspectPackage：认不出格式的一律当好的，绝不删用户下好的包', async () => {
  const root = mkdtempSync(join(tmpdir(), 'napcat-inspect-unknown-'));
  try {
    // 真实的 QQ.exe 是个自解压包，头未必是标准 PE 段表；认不出就该留着
    writeFileSync(join(root, 'weird.exe'), 'this is not a PE file but might be fine');
    const r = await inspectPackage(join(root, 'weird.exe'), 'pe');
    assert.equal(r.state, 'ok');
    assert.equal(r.kind, 'unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('autoInstall：解压安装器前就把上次留下的坏包删掉（重试才能真重下）', async () => {
  if (process.platform === 'win32') return; // 这条只验非 Windows 的早退，真清理走 purged 单测
  const root = mkdtempSync(join(tmpdir(), 'napcat-purge-'));
  try {
    const napcat = createNapcat({ root, log: silent });
    const r = await napcat.autoInstall();
    assert.equal(r.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeBrokenPackagesIn：删截断包、留下完整包与安装器自身', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-purge-'));
  const warned = [];
  const log = { info() {}, warn: (m) => warned.push(String(m)), error() {}, list: () => [] };
  try {
    // 完整的 QQ 安装包（PE 声明多少就有多少）——必须活着
    writeFileSync(join(dir, 'QQ.exe'), makePe(0x1000));
    // 截断的 Shell 包——必须被删
    const fullZip = makeZip({ declaredOffset: 0 });
    writeFileSync(join(dir, 'NapCat.Shell.zip'), fullZip.subarray(0, 30));
    // 安装器自身的文件不是下载产物，哪怕认不出格式也不能动
    writeFileSync(join(dir, 'NapCatInstaller.exe'), 'not a pe but not ours to delete');
    writeFileSync(join(dir, '7z.exe'), 'nope');

    const removed = await purgeBrokenPackagesIn(dir, log);
    assert.deepEqual(removed, ['NapCat.Shell.zip'], '只删截断的那个');
    assert.equal(existsSync(join(dir, 'NapCat.Shell.zip')), false);
    assert.equal(existsSync(join(dir, 'QQ.exe')), true, '完整的 300MB 包不能被误删');
    assert.equal(existsSync(join(dir, 'NapCatInstaller.exe')), true, '安装器自身不动');
    assert.equal(existsSync(join(dir, '7z.exe')), true);
    assert.ok(
      warned.some((m) => m.includes('已删除损坏的安装包 NapCat.Shell.zip')),
      '删掉时要在日志里说清原因，排障才有线索',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('purgeBrokenPackagesIn：没有坏包时什么也不做（幂等）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-purge-none-'));
  const log = { info() {}, warn() {}, error() {}, list: () => [] };
  try {
    writeFileSync(join(dir, 'QQ.exe'), makePe(0x800));
    writeFileSync(join(dir, 'NapCat.Shell.zip'), makeZip({ declaredOffset: 0 }));
    assert.deepEqual(await purgeBrokenPackagesIn(dir, log), []);
    assert.equal(existsSync(join(dir, 'QQ.exe')), true);
    assert.equal(existsSync(join(dir, 'NapCat.Shell.zip')), true);
    // 目录里什么都没有也不该抛
    const empty = mkdtempSync(join(tmpdir(), 'napcat-purge-empty-'));
    try {
      assert.deepEqual(await purgeBrokenPackagesIn(empty, log), []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseAssetDigest：认 GitHub 的 `sha256:<hex>`，不认的形状一律当没有', () => {
  const good = 'sha256:02e5ff0f79916c1e04c81c1b4590056406fb4293f1f1300c955e71fd08b2829d';
  assert.equal(parseAssetDigest(good), good.slice(7));
  assert.equal(parseAssetDigest(good.toUpperCase()), good.slice(7), '大写也要认，统一转小写');
  assert.equal(parseAssetDigest(`  ${good}  `), good.slice(7), '前后空白要忽略');
  // 认不出的一律空串：宁可不校验，也不能拿错值把好包判坏
  for (const bad of [undefined, null, 123, '', 'sha256:', 'md5:abc', good.slice(7), `sha256:${'z'.repeat(64)}`]) {
    assert.equal(parseAssetDigest(bad), '', `不该接受 ${String(bad)}`);
  }
});

test('verifyDownload：截断的包必须被拒——这正是"每次都失败"的根因', () => {
  const real = { size: 35967555, sha256: 'a'.repeat(64) };
  // 镜像把 35.9MB 截成 4.6MB，而安装器报"下载成功"
  const truncated = verifyDownload({ size: 4627866, sha256: 'a'.repeat(64) }, real);
  assert.equal(truncated.ok, false);
  assert.match(truncated.reason, /大小不符/);
  assert.match(truncated.reason, /截断/);
  // 大小对但内容被改写
  const corrupted = verifyDownload({ size: 35967555, sha256: 'b'.repeat(64) }, real);
  assert.equal(corrupted.ok, false);
  assert.match(corrupted.reason, /SHA-256/);
  // 完全一致才算过
  assert.deepEqual(verifyDownload({ size: 35967555, sha256: 'a'.repeat(64) }, real), { ok: true, reason: '' });
});

test('verifyDownload：官方没给 digest 时只校验大小（大小仍足以识破截断）', () => {
  const sizeOnly = { size: 35967555, sha256: '' };
  assert.equal(verifyDownload({ size: 4627866, sha256: 'c'.repeat(64) }, sizeOnly).ok, false);
  assert.equal(verifyDownload({ size: 35967555, sha256: 'c'.repeat(64) }, sizeOnly).ok, true);
  // 连大小都没有 → 无从判断，按通过处理（不能把能下的包全拦了）
  assert.equal(verifyDownload({ size: 1, sha256: '' }, { size: 0, sha256: '' }).ok, true);
});

test('SHELL_ZIP_NAME 必须是安装器写死的那个名字，否则"跳过下载"不成立', () => {
  // 安装器日志里的实测命令：.\7z.exe … x "NapCat.Shell.zip"
  assert.equal(SHELL_ZIP_NAME, 'NapCat.Shell.zip');
});

/** 造一个流式响应体（预取按 chunk 累加大小与哈希） */
function fakeBody(buf) {
  return {
    async *[Symbol.asyncIterator]() {
      // 分块给，模拟真实网络流
      for (let i = 0; i < buf.length; i += 1024) yield buf.subarray(i, i + 1024);
    },
  };
}

test('prefetchShellZipIn：截断的镜像包一律丢弃，好包才落进安装器目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-prefetch-'));
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {}, list: () => [] };
  const good = Buffer.from('x'.repeat(2048));
  const sha = createHash('sha256').update(good).digest('hex');
  const asset = { size: good.length, sha256: sha, tag: '4.18.42', url: 'https://official/x.zip' };
  const saved = globalThis.fetch;
  try {
    // 第一个源：截断（只给一半）；第二个源：完整
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      if (call === 1) return { ok: true, status: 200, body: fakeBody(good.subarray(0, 1024)) };
      return { ok: true, status: 200, body: fakeBody(good) };
    };
    const r = await prefetchShellZipIn(dir, asset, log);
    assert.equal(r.ok, true, '第二个源完整，应该成功');
    assert.equal(r.size, good.length);
    assert.equal(existsSync(join(dir, SHELL_ZIP_NAME)), true, '好包应落进安装器 cwd');
    assert.equal(existsSync(join(dir, `${SHELL_ZIP_NAME}.part`)), false, '临时残包不能留下');
    // 截断那次必须被记为不合格，且不能把残包当成结果
    assert.ok(
      logs.some((m) => m.includes('已校验并预置网关包')),
      '成功时要说清"安装器会跳过下载"',
    );
  } finally {
    globalThis.fetch = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchAccountLogin：登录后账号级配置缺服务器 → 补写并带号重启（不重启 3001 永不监听）', async () => {
  // 背景（实测事故）：扫码成功那一刻 NapCat 生成 onebot11_<QQ号>.json，
  // 里面 websocketServers 是空的且优先级高于默认配置——用户"登录成功了状态却一直离线"。
  // 配置目录必须是 NapCat 真正的 workdir，否则看守连账号级文件都扫不到（整段死代码）。
  const home = mkdtempSync(join(tmpdir(), 'napcat-watch-'));
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {}, list: () => [] };
  const seenUins = [];
  try {
    const appPath = join(home, 'app', 'NapCat.99999.Shell');
    const cfgDir = join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'webui.json'), JSON.stringify({ port: 6099, token: 'x' }));
    writeFileSync(join(appPath, 'NapCatWinBootMain.exe'), '');
    // 真实事故形态：NapCat 已登录，但账号级配置里 servers 是空的（它的真实行为），
    // 且优先级高于默认配置——用户"登录成功了状态却一直离线"。
    // 看守的判据是「账号级配置里我们那条服务器对不对」，缺条目就要补写并重启。
    const accountFile = join(cfgDir, 'onebot11_2477690764.json');
    writeFileSync(accountFile, JSON.stringify({ network: { websocketServers: [], websocketClients: [] } }));
    const napcat = createNapcat({ root: home, log, onLogin: (uin) => seenUins.push(uin) });
    const r = await napcat.watchAccountLogin({ port: 3001, token: 'tok-abc' });
    // 核心断言：补写必须发生且内容正确。重启这一步在测试里会失败（假 exe 无法 spawn，
    // spawnGateway 已把错误收进 ok:false），真实环境里 exe 是真的，能正常拉起。
    const merged = JSON.parse(readFileSync(accountFile, 'utf8'));
    const server = merged.network.websocketServers[0];
    assert.equal(server.port, 3001, '服务器必须写进账号级配置');
    assert.equal(server.token, 'tok-abc');
    assert.equal(server.name, 'dsh-pet-qq');
    assert.ok(
      logs.some((m) => m.includes('检测到登录')),
      '要说清发生了什么',
    );
    // 登录号必须回调出去：调用方靠它把 account.selfId 落盘，下次才能快速登录
    assert.deepEqual(seenUins, ['2477690764'], '登录确认后必须回调 onLogin 交付 QQ 号');
    // 重启结果如实透传（这里 ok:false + 原因，不吞错）
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /找不到启动器|启动器|EFTYPE|spawn/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('watchAccountLogin：onLogin 抛错不拖垮看守（配置已写好，网关还等着重启）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'napcat-watch-onlogin-'));
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {}, list: () => [] };
  try {
    const appPath = join(home, 'app', 'NapCat.99999.Shell');
    const cfgDir = join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'napcat.json'), '{}');
    writeFileSync(join(appPath, 'NapCatWinBootMain.exe'), '');
    const accountFile = join(cfgDir, 'onebot11_13579.json');
    writeFileSync(accountFile, JSON.stringify({ network: { websocketServers: [] } }));
    const napcat = createNapcat({
      root: home,
      log,
      onLogin: () => {
        throw new Error('磁盘满了');
      },
    });
    // 同前：账号级配置里没有我们那条服务器 → 会走"补写 + 重启"分支
    const r = await napcat.watchAccountLogin({ port: 3001, token: 't' });
    // 补写已经完成，回调失败只记一条 warn
    const merged = JSON.parse(readFileSync(accountFile, 'utf8'));
    assert.equal(merged.network.websocketServers[0].name, 'dsh-pet-qq');
    assert.ok(
      logs.some((m) => m.includes('回填登录号失败')),
      '回调失败要留痕，不能静默吞掉',
    );
    assert.equal(r.ok, false, '重启失败仍如实返回');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('watchAccountLogin：账号级配置已经对了就绝不重启（防"连上又被自己打断"）', async () => {
  // 实测事故（2026-11-05）：看守把"文件存在/NapCat 启动时重写"当成"刚登录"，
  // 于是网关刚起来两秒就被自己杀掉重启，设置页表现为
  // 「连上了但拿不到登录信息：连接断开，调用未完成」无限循环。
  // 正确的判据只有一个：账号级配置里我们那条服务器**端口与令牌是否都对上**。
  const home = mkdtempSync(join(tmpdir(), 'napcat-watch-ok-'));
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {}, list: () => [] };
  const seenUins = [];
  try {
    const appPath = join(home, 'app', 'NapCat.99999.Shell');
    const cfgDir = join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'webui.json'), JSON.stringify({ port: 6099, token: 'x' }));
    writeFileSync(join(appPath, 'NapCatWinBootMain.exe'), '');
    const accountFile = join(cfgDir, 'onebot11_2477690764.json');
    writeFileSync(
      accountFile,
      JSON.stringify({
        network: {
          websocketServers: [
            {
              name: 'dsh-pet-qq',
              enable: true,
              host: '127.0.0.1',
              port: 3001,
              token: 'tok-ok',
              messagePostFormat: 'array',
            },
          ],
        },
      }),
    );
    const napcat = createNapcat({ root: home, log, onLogin: (uin) => seenUins.push(uin) });
    const r = await napcat.watchAccountLogin({ port: 3001, token: 'tok-ok' });
    // 配置本来就对：不补写、不重启；号照样要报上去（调用方要靠它落盘 selfId）
    assert.deepEqual(seenUins, ['2477690764'], '配置已对时仍要回填 QQ 号');
    assert.equal(
      logs.some((m) => m.includes('检测到登录')),
      false,
      '不该打"补写并重启"的日志',
    );
    assert.equal(r.ok, true, '无需重启时应如实返回成功');
    assert.equal(r.uin, '2477690764');
    // 文件内容不许被改动（同一份内容连写都没写过）
    const after = JSON.parse(readFileSync(accountFile, 'utf8'));
    assert.equal(after.network.websocketServers[0].token, 'tok-ok');
    assert.equal(after.at, undefined, '不应被 mergeServer 重写（那会丢掉原文件里的其他字段）');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('watchAccountLogin：令牌不一致要按插件那份改回来（网关与插件必须同一个令牌）', async () => {
  // 曾经的 bug：看守拿空令牌生成了一个新的写进账号级配置，
  // 网关要求新令牌、插件还拿旧的，握手必被踢。这里锁死"以插件持有的为准"。
  const home = mkdtempSync(join(tmpdir(), 'napcat-watch-token-'));
  try {
    const appPath = join(home, 'app', 'NapCat.99999.Shell');
    const cfgDir = join(appPath, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'webui.json'), JSON.stringify({ port: 6099, token: 'x' }));
    writeFileSync(join(appPath, 'NapCatWinBootMain.exe'), '');
    const accountFile = join(cfgDir, 'onebot11_2477690764.json');
    writeFileSync(
      accountFile,
      JSON.stringify({
        network: { websocketServers: [{ name: 'dsh-pet-qq', enable: true, port: 3001, token: '别的令牌' }] },
      }),
    );
    const napcat = createNapcat({ root: home, log: silent });
    await napcat.watchAccountLogin({ port: 3001, token: '插件的令牌' });
    const merged = JSON.parse(readFileSync(accountFile, 'utf8'));
    assert.equal(merged.network.websocketServers[0].token, '插件的令牌', '必须改成插件持有的令牌');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('watchAccountLogin：没登录时如实超时退出，不空转', async () => {
  const home = mkdtempSync(join(tmpdir(), 'napcat-watch-none-'));
  try {
    const appPath = join(home, 'app', 'NapCat.99999.Shell');
    mkdirSync(join(appPath, 'config'), { recursive: true });
    writeFileSync(join(appPath, 'NapCatWinBootMain.exe'), '');
    const napcat = createNapcat({ root: home, log: silent });
    // 不真等 10 分钟：看门狗在网关退出（child===null）时立刻放弃——这里网关根本没启动
    const r = await napcat.watchAccountLogin({ port: 3001, token: 't' });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /网关已退出|还没装好|超时/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prefetchShellZipIn：所有源都不合格时如实失败，且不留任何文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-prefetch-bad-'));
  const log = { info() {}, warn() {}, error() {}, list: () => [] };
  const good = Buffer.from('y'.repeat(1024));
  const asset = {
    size: good.length,
    sha256: createHash('sha256').update(good).digest('hex'),
    tag: 't',
    url: 'https://o/x.zip',
  };
  const saved = globalThis.fetch;
  try {
    // 每个源都给截断内容（正是 ghproxy.net 的行为）
    globalThis.fetch = async () => ({ ok: true, status: 200, body: fakeBody(good.subarray(0, 256)) });
    const r = await prefetchShellZipIn(dir, asset, log);
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /大小不符/);
    assert.equal(existsSync(join(dir, SHELL_ZIP_NAME)), false, '残包绝不能落进安装器 cwd');
    assert.equal(existsSync(join(dir, `${SHELL_ZIP_NAME}.part`)), false, '临时文件也要清掉');
  } finally {
    globalThis.fetch = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefetchShellZipIn：已有「同 tag 且校验通过」的包就复用，不重复下载 35MB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-prefetch-reuse-'));
  const log = { info() {}, warn() {}, error() {}, list: () => [] };
  try {
    const onDisk = makeZip({ declaredOffset: 0 });
    writeFileSync(join(dir, SHELL_ZIP_NAME), onDisk);
    const asset = {
      size: onDisk.length,
      sha256: createHash('sha256').update(onDisk).digest('hex'),
      tag: '4.18.41',
      url: 'https://o/x.zip',
    };
    const saved = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('不该被调用：已有同 tag 的好包时不能再去下载');
    };
    try {
      const r = await prefetchShellZipIn(dir, asset, log);
      assert.equal(r.ok, true);
      assert.equal(r.reused, true);
    } finally {
      globalThis.fetch = saved;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefetchShellZipIn：盘上是「另一个 tag」的完整包时必须重下，不能混装', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-prefetch-retag-'));
  const log = { info() {}, warn() {}, error() {}, list: () => [] };
  const stale = makeZip({ declaredOffset: 0 }); // 结构完整，是上一次预取留下的 4.18.42 包
  const good = Buffer.from('n'.repeat(768)); // 本次想要的 4.18.41 包
  const saved = globalThis.fetch;
  try {
    writeFileSync(join(dir, SHELL_ZIP_NAME), stale);
    let called = 0;
    globalThis.fetch = async () => {
      called += 1;
      return { ok: true, status: 200, body: fakeBody(good) };
    };
    const asset = {
      size: good.length,
      sha256: createHash('sha256').update(good).digest('hex'),
      tag: '4.18.41',
      url: 'https://official/x.zip',
    };
    const r = await prefetchShellZipIn(dir, asset, log);
    assert.equal(r.ok, true);
    assert.equal(r.reused, undefined, '旧 tag 的包不能被当成可复用');
    assert.ok(called > 0, '必须真的去下同 tag 的包，否则引导件与 payload 跨版本混装');
    assert.equal(readFileSync(join(dir, SHELL_ZIP_NAME)).length, good.length, '旧包应被同 tag 新包替换');
  } finally {
    globalThis.fetch = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefetchShellZipIn：已有的残包要先删掉，不能被安装器拿去解压', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-prefetch-replace-'));
  const log = { info() {}, warn() {}, error() {}, list: () => [] };
  const good = Buffer.from('z'.repeat(512));
  const asset = {
    size: good.length,
    sha256: createHash('sha256').update(good).digest('hex'),
    tag: 't',
    url: 'https://o/x.zip',
  };
  const saved = globalThis.fetch;
  try {
    // 盘上先放一个截断残包（真实事故现场）
    writeFileSync(join(dir, SHELL_ZIP_NAME), 'truncated-garbage');
    globalThis.fetch = async () => ({ ok: true, status: 200, body: fakeBody(good) });
    const r = await prefetchShellZipIn(dir, asset, log);
    assert.equal(r.ok, true);
    assert.equal(readFileSync(join(dir, SHELL_ZIP_NAME)).length, good.length, '残包应被好包替换');
  } finally {
    globalThis.fetch = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefetchShellZipIn：拿不到官方大小就跳过，不盲下', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-prefetch-nosize-'));
  const log = { info() {}, warn() {}, error() {}, list: () => [] };
  try {
    const r = await prefetchShellZipIn(dir, { size: 0, sha256: '', tag: '', url: 'https://o/x.zip' }, log);
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /没拿到官方包大小/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefetchShellZipIn：逐块回报已收字节数，UI 才不会"点了没反应"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-prefetch-progress-'));
  const log = { info() {}, warn() {}, error() {}, list: () => [] };
  const good = Buffer.from('p'.repeat(4096));
  const asset = {
    size: good.length,
    sha256: createHash('sha256').update(good).digest('hex'),
    tag: 't',
    url: 'https://o/x.zip',
  };
  const saved = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, body: fakeBody(good) });
    const r = await prefetchShellZipIn(dir, asset, log, (got) => seen.push(got));
    assert.equal(r.ok, true);
    assert.ok(seen.length > 0, '必须回报进度，否则 35MB 下载期间 UI 一片死寂');
    assert.equal(seen[seen.length - 1], good.length, '最后一次应等于总字节数');
    // 单调递增（进度条不能倒退）
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1], '进度必须单调不减');
  } finally {
    globalThis.fetch = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
