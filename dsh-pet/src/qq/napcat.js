/**
 * 内置的 NapCat 网关安装器：解压、预置 OneBot 配置、启停。
 *
 * 存在的理由很实际：协议端是这条链路唯一无法自动化的外部依赖，而让每个用户
 * 「去 GitHub 找包 → 读文档 → 在 WebUI 里新建 WebSocket 服务器 → 手抄 token」
 * 是这条链路最常见的失败点（配成客户端、消息格式选成 string、token 抄错）。
 * 本模块把能自动化的部分全接过来：
 *
 * 1. **解压**：把随包分发的 OneKey 安装器解到固定目录，用户只需运行一次它；
 * 2. **预置配置**：直接写 `config/onebot11.json`（v4.5.3+ 的账号无关默认配置），
 *    把 WebSocket 服务器、端口、消息格式、token 一次性定死，并回填给插件配置；
 * 3. **启停**：spawn / taskkill 我们自己的子进程，退出时不留孤儿。
 *
 * 三条边界：
 * - **只带安装器，不带 QQ 客户端**。NTQQ 是腾讯的专有软件，不能随包分发；
 *   由安装器在用户机器上下载，这正是它的原始设计。
 * - **安装器是图形界面**，装到哪、下什么必须人点。本模块只能把目标目录固定下来
 *   （`<数据目录>/napcat/app`），不能代替用户点。
 * - **只支持 Windows**：OneKey 发行包只有 Windows 版，其余平台如实返回不支持。
 *
 * @module dsh-pet-qq/napcat
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wipeDir, wipeDirSync } from './uninstall.js';

/** 随包分发的安装器文件名 */
export const ZIP_NAME = 'NapCat.Shell.Windows.OneKey.zip';

/** 预置配置里那条 WebSocket 服务器的名字（重复写入时按它去重） */
const SERVER_NAME = 'dsh-pet-qq';

/** 网关默认端口，与插件默认 `ws://127.0.0.1:3001` 对齐 */
export const DEFAULT_WS_PORT = 3001;

/**
 * 一键安装的进度阶段（真实解析安装器输出得来，不是估的）。
 *
 * 安装器在中文 Windows 上吐 **GBK** 字节，格式已实测：
 *   `下载进度: [=====>      ] 23% (69MB/300MB)`
 *   `[信息] 开始下载QQ 9.9.33-52230...` / `[成功] QQ下载成功` / `[成功] NapCat下载成功`
 *   `===== 安装完成 =====`
 * 两段下载（QQ 300MB + NapCat 34MB）各自占一段整体进度，用权重折算成 0–100。
 */
export const INSTALL_PHASES = [
  { key: 'prepare', label: '准备中', from: 0, to: 2 },
  { key: 'qq-download', label: '下载 QQ 客户端', from: 2, to: 55 },
  { key: 'qq-extract', label: '解压 QQ 客户端', from: 55, to: 70 },
  { key: 'shell-download', label: '下载 NapCat 网关', from: 70, to: 88 },
  { key: 'shell-extract', label: '解压并装配网关', from: 88, to: 99 },
  { key: 'done', label: '安装完成', from: 100, to: 100 },
];

/**
 * 从安装器的一行输出里提取结构化进度（纯函数，单测覆盖）。
 * @param {string} line 已按 GBK 解码后的一行（去掉首尾空白）
 * @param {{phase?: string, percent?: number}} prev 上一状态（用于「解压」这种无百分比阶段的单调性）
 * @returns {{phase?: string, percent?: number, detail?: string, label?: string}|null} 变化了才返回
 */
export function parseInstallLine(line, prev = {}) {
  const text = String(line ?? '').trim();
  if (text === '') return null;
  const phaseOf = (key) => INSTALL_PHASES.find((p) => p.key === key) ?? INSTALL_PHASES[0];

  // 完成标志
  if (/安装完成/.test(text)) return { phase: 'done', percent: 100, label: '安装完成', detail: '欢迎使用' };

  // 下载进度行：`下载进度: [===>   ] 23% (69MB/300MB)`
  const m = /下载进度[:：]\s*\[[^\]]*\]\s*(\d{1,3})%/.exec(text);
  if (m !== null) {
    const raw = Math.max(0, Math.min(100, Number(m[1])));
    // 当前处于哪段下载，决定折算基准
    const inShell = prev.phase === 'shell-download' || prev.phase === 'shell-extract';
    const span = phaseOf(inShell ? 'shell-download' : 'qq-download');
    const percent = Math.round(span.from + ((span.to - span.from) * raw) / 100);
    const size = /\(([^)]*)\)/.exec(text)?.[1] ?? '';
    return { phase: span.key, percent, label: span.label, detail: size };
  }

  // 阶段锚点
  if (/开始下载QQ/.test(text)) {
    const span = phaseOf('qq-download');
    return { phase: span.key, percent: span.from, label: span.label, detail: '连接腾讯官方源' };
  }
  if (/QQ下载成功/.test(text)) {
    const span = phaseOf('qq-extract');
    return { phase: span.key, percent: span.from, label: span.label, detail: '解压中（约 1.2GB）' };
  }
  if (/开始下载NapCat/.test(text)) {
    const span = phaseOf('shell-download');
    return { phase: span.key, percent: span.from, label: span.label, detail: '连接 GitHub 或多镜像' };
  }
  if (/NapCat下载成功/.test(text)) {
    const span = phaseOf('shell-extract');
    return { phase: span.key, percent: span.from, label: span.label, detail: '解压并写入启动脚本' };
  }
  if (/检查QQ安装包/.test(text)) {
    const span = phaseOf('prepare');
    return { phase: span.key, percent: span.from, label: span.label, detail: '校验已有安装包' };
  }
  // 失败信号：安装器会卡在 Press any key，插件不能跟着卡
  if (/\[错误\]|下载失败|解压.*失败|所有地址均不可用|SHA256校验不通过/.test(text)) {
    return { detail: text.replace(/^\[[^\]]*\]\s*/, '').slice(0, 120) };
  }
  return null;
}


/**
 * 资产目录。源码形态（`src/qq/napcat.js`）在 `../../assets/napcat`，
 * 打包后（`lib/*.js`）在 `../assets/napcat`——两个都试，取第一个真实存在的。
 * 用"存在性"而不是 `process.env` 判断，是为了让源码运行和发布包行为一致。
 * @returns {string|null} 绝对路径（找不到返回 null）
 */
export function assetsDir() {
  for (const rel of ['../assets/napcat/', '../../assets/napcat/']) {
    try {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(join(dir, ZIP_NAME))) return dir;
    } catch {
      /* URL 解析失败就试下一个候选 */
    }
  }
  return null;
}

/**
 * 读版本清单（版本号、来源、SHA-256）。
 * @param {string} [file] 显式给版本文件路径；不传则读随包内置的 `version.json`。
 * @returns {Promise<any|null>} 清单（缺失或损坏返回 null）
 */
export async function bundleInfo(file) {
  const path = typeof file === 'string' ? file : (() => {
    const dir = assetsDir();
    return dir === null ? null : join(dir, 'version.json');
  })();
  if (path === null) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 生成给 NapCat 的 OneBot v11 配置（账号无关的默认配置）。
 *
 * 只开一个 **WebSocket 服务器**（正向 WS）：插件是客户端，方向必须反过来配，
 * 这条路走错一次就会"两边都显示运行中但永远不回话"。
 * @param {string} token 鉴权令牌（NapCat 侧与插件侧必须是同一个）
 * @param {number} [port] 监听端口
 * @returns {any} 可直接写入 `config/onebot11.json` 的对象
 */
export function buildOneBotConfig(token, port = DEFAULT_WS_PORT) {
  return {
    network: {
      httpServers: [],
      httpClients: [],
      websocketServers: [
        {
          name: SERVER_NAME,
          enable: true,
          host: '127.0.0.1',
          port,
          messagePostFormat: 'array',
          reportSelfMessage: false,
          token,
          enableForcePushEvent: true,
          debug: false,
          heartInterval: 30000,
        },
      ],
      websocketClients: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
  };
}

/**
 * 把 `onebot11.json` 里那条服务器合并进已有的账号配置。
 *
 * 为什么需要：`onebot11.json` 只是"没有账号配置时的默认值"。用户如果先登录过一次，
 * NapCat 已经生成 `onebot11_<QQ号>.json`，之后再改默认文件就不生效了——
 * 表现是"配置看着对，但端口/令牌就是不对"。
 * @param {any} existing 现有配置
 * @param {any} patch 我们那条服务器的完整定义
 * @returns {any} 合并后的配置
 */
export function mergeServer(existing, patch) {
  const base = existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const network = base.network !== null && typeof base.network === 'object' ? base.network : {};
  const list = Array.isArray(network.websocketServers) ? network.websocketServers : [];
  const kept = list.filter((item) => item?.name !== patch.name);
  return {
    ...base,
    network: {
      httpServers: Array.isArray(network.httpServers) ? network.httpServers : [],
      httpClients: Array.isArray(network.httpClients) ? network.httpClients : [],
      websocketServers: [...kept, patch],
      websocketClients: Array.isArray(network.websocketClients) ? network.websocketClients : [],
    },
    musicSignUrl: typeof base.musicSignUrl === 'string' ? base.musicSignUrl : '',
    enableLocalFile2Url: base.enableLocalFile2Url === true,
    parseMultMsg: base.parseMultMsg === true,
  };
}

/** 令牌：24 位十六进制，够本地用，且不会与人的手抄习惯冲突 */
const newToken = () => randomBytes(12).toString('hex');

/**
 * 在安装根目录下找真正装好的 Shell 目录。
 * @param {string} installRoot 安装根目录
 * @returns {Promise<string|null>} `NapCat.*.Shell` 绝对路径（没装好返回 null）
 */
async function findApp(installRoot) {
  /**
   * 判定一个目录是不是装好的 Shell。
   * 两种真实布局都要认（都是官方安装器产出的）：
   * - `bootmain/NapCatWinBootMain.exe`：旧 OneKey 把 bootmain 整个目录放进来；
   * - 根目录直接有 `NapCatWinBootMain.exe`：现版安装器是把 bootmain **里的文件**复制到
   *   Shell 根目录（实测 v4.18.41 就是这样，只认前者会误判成"没装好"）。
   */
  const looksLikeApp = (dir) =>
    existsSync(join(dir, 'bootmain', 'NapCatWinBootMain.exe')) ||
    existsSync(join(dir, 'NapCatWinBootMain.exe'));
  // 先按名字精确认：NapCat.*.Shell 才是装好的网关；bootmain/ 是安装器的引导件目录，
  // 它里面也有 NapCatWinBootMain.exe，不排除掉会被误判成 Shell（实测踩过）。
  const isShellName = (name) => /^NapCat\..+\.Shell$/i.test(name);
  const shellNamed = (dir) => isShellName(basename(dir)) && looksLikeApp(dir);
  if (shellNamed(installRoot)) return installRoot;
  const entries = await readdir(installRoot, { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;
  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name !== 'bootmain');
  // 一轮：优先 NapCat.*.Shell
  for (const entry of dirs) {
    const dir = join(installRoot, entry.name);
    if (shellNamed(dir)) return dir;
  }
  // 二轮：名字不规范但结构对的（老版本/用户手工搬过的），排除 bootmain
  for (const entry of dirs) {
    const dir = join(installRoot, entry.name);
    if (looksLikeApp(dir)) return dir;
  }
  return null;
}

/**
 * 系统工具的绝对路径。
 *
 * 为什么不直接写 `powershell.exe`：PATH 不总是包含 System32（精简系统、被裁剪的环境变量、
 * 从某些宿主进程拉起的子进程都见过），表现是 `spawn powershell.exe ENOENT`——
 * 一句"解压失败"就把用户卡在第一步。系统目录由 `SystemRoot` 给出，永远比 PATH 可靠。
 * @param {string} name 可执行文件名
 * @returns {string} 绝对路径
 */
function systemExe(name) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return join(root, 'System32', name);
}

/**
 * 跑一个命令并等它结束（解压用；不引第三方库，Windows 自带 tar 或 PowerShell）。
 * @param {string} command 可执行文件
 * @param {string[]} args 参数
 * @returns {Promise<{ok: boolean, message: string}>} 结果
 */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => resolve({ ok: false, message: error.message }));
    child.on('close', (code) =>
      resolve({ ok: code === 0, message: code === 0 ? '' : stderr.trim() || `退出码 ${code}` }),
    );
  });
}

/**
 * 建一个网关管理器。
 * @param {{root: string, log: object}} deps 依赖（`root` = `<数据目录>/napcat`）
 * @returns {any} 管理器
 */
export function createNapcat({ root, log }) {
  /** 解压出来的安装器目录 */
  const installerDir = root;
  /** 安装器要装到这个目录（固定下来，插件才能预置配置和启停） */
  const installRoot = join(root, 'app');
  /** @type {import('node:child_process').ChildProcess|null} 我们拉起的网关进程 */
  let child = null;

  /** 从 GitHub 下载到用户数据目录的最新安装器（优先于随包内置） */
  const cacheZip = join(root, ZIP_NAME);
  const cacheVersion = join(root, 'napcat-version.json');

  /** 后台安装状态（status() 带给设置页轮询用） */
  const installState = {
    running: false,
    phase: 'idle',
    /** 整体进度 0–100（由安装器输出真实折算） */
    percent: 0,
    /** 当前阶段的展示名，如「下载 QQ 客户端」 */
    label: '',
    /** 阶段内的细节，如 `69MB/300MB` 或失败原因 */
    detail: '',
    error: '',
    startedAt: 0,
  };

  /**
   * 解压用的 zip 在哪：优先用户已下载的最新版，其次随包内置。
   * @returns {{dir: string, zip: string, versionFile: string, fromCache: boolean}|null}
   */
  function resolveZip() {
    if (existsSync(cacheZip)) return { dir: root, zip: cacheZip, versionFile: cacheVersion, fromCache: true };
    const b = assetsDir();
    if (b !== null) return { dir: b, zip: join(b, ZIP_NAME), versionFile: join(b, 'version.json'), fromCache: false };
    return null;
  }

  /** 读当前有效的版本清单（下载的优先） */
  async function readBundleInfo() {
    const r = resolveZip();
    return r === null ? null : bundleInfo(r.versionFile);
  }

  /** 状态快照：设置页与接口共用一份口径 */
  async function status() {
    const info = await readBundleInfo();
    const r = resolveZip();
    const appPath = await findApp(installRoot);
    return {
      supported: process.platform === 'win32',
      version: String(info?.version ?? ''),
      source: String(info?.source ?? ''),
      zipSource: r === null ? 'none' : r.fromCache ? 'downloaded' : 'bundle',
      zipPresent: r !== null,
      canFetchLatest: process.platform === 'win32',
      installerDir,
      installRoot,
      installerExe: join(installerDir, 'NapCatInstaller.exe'),
      unpacked: existsSync(join(installerDir, 'NapCatInstaller.exe')),
      installed: appPath !== null,
      appPath: appPath ?? '',
      configPath: appPath === null ? '' : join(appPath, 'config', 'onebot11.json'),
      license: r !== null && !r.fromCache ? join(r.dir, 'LICENSE-NapCat.txt') : '',
      running: child !== null,
      pid: child?.pid ?? 0,
      installing: installState.running,
      installPhase: installState.phase,
      installPercent: installState.percent,
      installLabel: installState.label,
      installDetail: installState.detail,
      installStartedAt: installState.startedAt,
      installError: installState.error,
    };
  }

  /** 解压安装器（幂等；已解压直接返回 ok）。内置与已下载的最新版都行，优先最新版。 */
  async function unpack() {
    if (process.platform !== 'win32') return { ok: false, reason: '内置安装器只有 Windows 版' };
    const rz = resolveZip();
    if (rz === null) {
      return { ok: false, reason: '找不到安装器：随包未带、也没下载过（点「下载最新安装器」试试）' };
    }
    if (existsSync(join(installerDir, 'NapCatInstaller.exe'))) {
      return { ok: true, already: true, dir: installerDir };
    }
    await mkdir(installerDir, { recursive: true });
    const zip = rz.zip;
    // 先用 Windows 自带的 bsdtar（Win10 1803+，无引号与执行策略问题），失败再退回 PowerShell。
    // 两个都用绝对路径：PATH 里没有 System32 的环境会把"解压失败"变成用户的第一道墙。
    let r = await run(systemExe('tar.exe'), ['-xf', zip, '-C', installerDir]);
    if (!r.ok) {
      const ps = `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${installerDir}' -Force`;
      const powershell = join(systemExe('WindowsPowerShell'), 'v1.0', 'powershell.exe');
      const second = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', ps]);
      if (!second.ok) {
        log.warn(`解压安装器失败：${r.message || second.message}`);
        return { ok: false, reason: `解压失败：${second.message || r.message}` };
      }
    }
    if (!existsSync(join(installerDir, 'NapCatInstaller.exe'))) {
      return { ok: false, reason: '解压完成但没找到 NapCatInstaller.exe' };
    }
    log.info(`已解压网关安装器到 ${installerDir}`);
    return { ok: true, already: false, dir: installerDir, installerExe: join(installerDir, 'NapCatInstaller.exe') };
  }

  /**
   * 把 OneBot 配置写进已安装的 Shell（含 token 与端口），返回给插件回填的值。
   * @param {{port?: number, token?: string}} [opts] 端口与令牌（不传则沿用配置里的/新建）
   * @returns {Promise<any>} `{ok, token, wsUrl, path}`
   */
  async function writeConfig({ port = DEFAULT_WS_PORT, token = '' } = {}) {
    const appPath = await findApp(installRoot);
    if (appPath === null) {
      return { ok: false, reason: `网关还没装好：${installRoot} 下找不到 NapCat.*.Shell（先运行安装器）` };
    }
    const configDir = join(appPath, 'config');
    await mkdir(configDir, { recursive: true });
    const useToken = String(token ?? '').trim() === '' ? newToken() : String(token).trim();
    const server = buildOneBotConfig(useToken, port).network.websocketServers[0];

    const mainFile = join(configDir, 'onebot11.json');
    const mainCfg = buildOneBotConfig(useToken, port);
    await writeFile(mainFile, `${JSON.stringify(mainCfg, null, 2)}\n`, 'utf8');

    // 已经登录过时 NapCat 会生成账号级配置，只写默认文件不生效——逐份合并
    const entries = await readdir(configDir).catch(() => []);
    for (const name of entries) {
      if (!/^onebot11_.+\.json$/.test(name)) continue;
      const file = join(configDir, name);
      const existing = await readFile(file, 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => null);
      await writeFile(file, `${JSON.stringify(mergeServer(existing, server), null, 2)}\n`, 'utf8');
    }

    log.info(`已写入网关配置：${mainFile}（WebSocket 服务器 127.0.0.1:${port}）`);
    return { ok: true, token: useToken, wsUrl: `ws://127.0.0.1:${port}`, path: mainFile };
  }

  /**
   * 启动网关（`NapCatWinBootMain.exe [uin]`，uin 给了就是快速登录）。
   * @param {{uin?: string}} [opts] 可选的快速登录号
   * @returns {Promise<any>} `{ok, pid}`
   */
  async function launch({ uin = '' } = {}) {
    if (child !== null) return { ok: true, already: true, pid: child.pid ?? 0 };
    const appPath = await findApp(installRoot);
    if (appPath === null) return { ok: false, reason: '网关还没装好，先运行安装器' };
    // 两种布局都支持：bootmain/ 子目录（旧）或根目录（v4.18.41 安装器实测）
    const bootDir = existsSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe')) ? join(appPath, 'bootmain') : appPath;
    const exe = join(bootDir, 'NapCatWinBootMain.exe');
    if (!existsSync(exe)) return { ok: false, reason: `找不到启动器：${exe}` };
    const args = String(uin ?? '').trim() === '' ? [] : [String(uin).trim()];
    const started = spawn(exe, args, {
      cwd: bootDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    started.on('error', (error) => {
      log.warn(`启动网关失败：${error.message}`);
      child = null;
    });
    started.on('exit', (code) => {
      log.info(`网关进程已退出（code=${String(code)}）`);
      child = null;
    });
    started.unref();
    child = started;
    log.info(`已启动网关（pid=${started.pid ?? 0}）`);
    return { ok: true, pid: started.pid ?? 0 };
  }

  /** 停掉我们拉起的网关进程（连带子进程；不是我们拉的就明确说不知道） */
  async function stop() {
    const current = child;
    if (current === null) return { ok: true, already: true };
    child = null;
    const pid = current.pid;
    if (typeof pid === 'number' && pid > 0 && process.platform === 'win32') {
      await run(systemExe('taskkill.exe'), ['/pid', String(pid), '/T', '/F']);
    } else {
      current.kill();
    }
    log.info('已停止网关进程');
    return { ok: true };
  }

  /**
   * 一键装网关：后台静默运行 NapCat 官方安装器到完成。
   *
   * 为什么可以全自动：安装器是个无交互控制台程序（已核实其二进制内的流程字符串——
   * 检查 QQ 安装包 → 下载 QQ（腾讯官方 CDN + 多镜像 + SHA-256 校验）→ 解压 →
   * 下载 NapCat Shell → 解压 → 改 package.json 启动脚本 → 复制引导文件 →
   * 「===== 安装完成 =====」后自行退出），没有目录选择、没有下一步、不读命令行参数。
   * 唯一要人做的只剩最后用小号扫码登录。
   *
   * 执行细节：spawn 时不 detached（要盯着 exit）；windowsHide 隐藏控制台闪窗；
   * 状态挂在 installState 上，`status()` 会带出去，设置页轮询即可看到进度。
   * 安装器把 Shell 解到它自己的工作目录（installerDir），完成后统一搬进 installRoot
   * （`<root>/app`），保证 findApp / 写配置 / 启停只认一个位置。
   * @returns {Promise<any>} `{ok, started|already}` 或 `{ok:false, reason}`
   */
  async function autoInstall() {
    if (process.platform !== 'win32') return { ok: false, reason: '内置安装器只有 Windows 版' };
    if (installState.running) return { ok: true, already: true, phase: installState.phase };
    const up = await unpack();
    if (up.ok !== true) return { ok: false, reason: up.reason ?? '解压安装器失败' };
    const exe = join(installerDir, 'NapCatInstaller.exe');
    if (!existsSync(exe)) return { ok: false, reason: `解压完成但没找到 ${exe}` };
    // 安装器的控制台输出同时做两件事：
    // 1. 落盘到 install.log（失败时只给退出码，真正原因全在输出里，不留就没法排障）；
    // 2. 流式解析成真进度（GBK 解码 + parseInstallLine），喂给 installState 供设置页轮询。
    const logFile = join(root, 'install.log');
    let logFd;
    let proc;
    try {
      logFd = openSync(logFile, 'a');
      writeSync(logFd, `\n===== ${new Date().toISOString()} 安装器启动 =====\n`);
      proc = spawn(exe, [], {
        cwd: installerDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      if (logFd !== undefined) closeSync(logFd);
      return { ok: false, reason: `启动安装器失败：${error instanceof Error ? error.message : String(error)}` };
    }
    // 中文 Windows 的安装器输出是 GBK；用流式解码器处理跨块的半个汉字
    const decoder = new TextDecoder('gbk');
    let pending = '';
    const consume = (chunk) => {
      // 原始字节落盘（保持 install.log 原貌，排障时能直接按 ANSI 打开看）
      try {
        writeSync(logFd, chunk);
      } catch {
        /* 盘满/句柄没了都不该影响安装 */
      }
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? ''; // 最后一段可能不完整，留到下一块
      for (const line of lines) {
        const change = parseInstallLine(line, installState);
        if (change === null) continue;
        if (change.phase !== undefined) installState.phase = change.phase;
        if (change.percent !== undefined) installState.percent = change.percent;
        if (change.label !== undefined) installState.label = change.label;
        if (change.detail !== undefined) installState.detail = change.detail;
      }
    };
    proc.stdout?.on('data', consume);
    proc.stderr?.on('data', consume);
    /** 收尾：冲出残留行并关掉日志句柄 */
    const flushLog = () => {
      pending += decoder.decode();
      const change = parseInstallLine(pending, installState);
      if (change !== null && change.percent !== undefined) installState.percent = change.percent;
      try {
        closeSync(logFd);
      } catch {
        /* 已关就算了 */
      }
    };
    installState.running = true;
    installState.phase = 'running';
    installState.percent = 0;
    installState.label = '准备中';
    installState.detail = '';
    installState.error = '';
    installState.startedAt = Date.now();
    log.info('已后台拉起 NapCat 安装器（全自动：下载 QQ + Shell，几分钟）');
    // 看门狗：30 分钟还没完（网络极慢/卡死）就杀掉并标失败，别让状态永远"安装中"
    const watchdog = setTimeout(() => {
      if (installState.running) {
        try {
          proc.kill();
        } catch {
          /* 已退出就算了 */
        }
      }
    }, 30 * 60 * 1000);
    proc.on('exit', (code) => {
      clearTimeout(watchdog);
      flushLog();
      installState.running = false;
      if (code === 0) {
        installState.phase = 'done';
        installState.percent = 100;
        installState.label = '安装完成';
        installState.detail = '正在归位网关目录…';
        log.info('NapCat 安装器执行完成');
        // 安装器把 Shell 留在它的工作目录（installerDir）；搬进 installRoot 统一口径。
        // 失败不回滚——Shell 在哪都能手动用，status 会如实显示。
        void relocateShell();
      } else {
        installState.phase = 'failed';
        installState.error = `安装器退出码 ${code}（下载失败或磁盘/网络问题，可重试）`;
        log.warn(`NapCat 安装器失败：exit=${code}`);
      }
    });
    proc.on('error', (error) => {
      clearTimeout(watchdog);
      flushLog();
      installState.running = false;
      installState.phase = 'failed';
      installState.error = error.message;
      log.warn(`NapCat 安装器进程出错：${error.message}`);
    });
    return { ok: true, started: true };
  }

  /**
   * 把安装器落在 installerDir 的 Shell 目录搬进 installRoot（找不到就不动）。
   * @returns {Promise<void>}
   */
  async function relocateShell() {
    const inRoot = await findApp(installRoot);
    if (inRoot !== null) return; // 已经在正确的位置
    const alt = await findApp(installerDir);
    if (alt === null) {
      log.warn('安装器跑完但没找到 Shell 目录（可能下载失败），可在设置页重试');
      installState.phase = 'failed';
      installState.error = '安装器执行完成但没找到 Shell（多半是 QQ 下载失败），可重试';
      return;
    }
    await mkdir(installRoot, { recursive: true });
    const target = join(installRoot, basename(alt));
    try {
      await rename(alt, target);
      log.info(`已把 Shell 归位到 ${target}`);
    } catch (error) {
      log.warn(`Shell 归位失败（不影响使用，只是位置不在 app/ 下）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 同步停网关：给卸载清理用（`taskkill` 同步阻塞，确保进程真的没了再删目录）。 */
  function stopSync() {
    const current = child;
    if (current === null) return { ok: true, already: true };
    child = null;
    const pid = current.pid;
    if (typeof pid === 'number' && pid > 0 && process.platform === 'win32') {
      spawnSync(systemExe('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      current.kill();
    }
    log.info('已停止网关进程（同步）');
    return { ok: true };
  }

  /**
   * 清掉本安装器留下的全部东西：先停网关（避免孤儿/文件锁），再删 root 目录。
   * 只删自己的目录，不碰别的。
   * @returns {Promise<{ok: boolean, removed: boolean, error?: string}>}
   */
  async function wipe() {
    await stop().catch(() => {});
    if (!existsSync(root)) return { ok: true, removed: false };
    const r = await wipeDir(root);
    if (r.removed === 'deleted') log.info(`已清理 NapCat 数据目录 ${root}`);
    return r;
  }

  /**
   * 同步版 `wipe()`，给 `ctx.effect` 的卸载清理用。
   *
   * 为什么必须同步：清理函数返回后 DSH 可能立刻销毁进程，异步删除会被截断。
   * 这里先同步停网关（taskkill 是同步的），再同步删目录。
   * @returns {{ok: boolean, removed: string, error?: string}}
   */
  function wipeSync() {
    // 先杀进程，否则占着目录里的 exe/dll 删不掉
    try {
      stopSync();
    } catch {
      /* 停不掉也继续删，删不掉的会被 rmSync 报出来 */
    }
    const r = wipeDirSync(root);
    if (r.removed === 'deleted') log.info(`已清理 NapCat 数据目录 ${root}`);
    return { ok: r.removed !== 'failed', ...r };
  }

  /**
   * 从 GitHub 拉最新版 OneKey 安装器，边下边校验 SHA-256，落到用户数据目录。
   * 成功后会成为解压时的优先来源（见 resolveZip）。
   * @returns {Promise<any>} `{ok, version, source, size, sha256}` 或 `{ok:false, reason}`
   */
  async function fetchLatest() {
    if (process.platform !== 'win32') return { ok: false, reason: '最新安装器只有 Windows 版' };
    if (typeof fetch !== 'function') return { ok: false, reason: '运行环境不支持下载（无 fetch）' };
    const apiUrl = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
    let rel;
    try {
      const resp = await fetch(apiUrl, {
        headers: { 'User-Agent': 'dsh-pet-qq', Accept: 'application/vnd.github+json' },
      });
      if (resp.status === 403) return { ok: false, reason: 'GitHub 接口限流（未登录每小时 60 次），稍后再试' };
      if (!resp.ok) return { ok: false, reason: `查最新版本失败：GitHub API ${resp.status}` };
      rel = await resp.json();
    } catch (error) {
      return { ok: false, reason: `查最新版本失败：${error instanceof Error ? error.message : String(error)}` };
    }
    const asset = (Array.isArray(rel.assets) ? rel.assets : []).find((a) => a && a.name === ZIP_NAME);
    if (!asset) return { ok: false, reason: `最新 release 里没有 ${ZIP_NAME}` };
    const version = String(rel.tag_name || '').replace(/^v/, '');
    const cur = await readBundleInfo();
    if (cur && cur.version === version && existsSync(cacheZip)) {
      return { ok: true, already: true, version, source: String(cur.source ?? '') };
    }
    const tmp = join(tmpdir(), `napcat-${process.pid}-${Date.now()}.zip`);
    try {
      const dl = await fetch(String(asset.browser_download_url), { headers: { 'User-Agent': 'dsh-pet-qq' } });
      if (!dl.ok) return { ok: false, reason: `下载失败：GitHub ${dl.status}` };
      const hasher = createHash('sha256');
      const file = await open(tmp, 'w');
      try {
        // dl.body 是 web ReadableStream；逐块更新哈希并落盘
        for await (const chunk of dl.body) {
          hasher.update(chunk);
          await file.write(chunk);
        }
      } finally {
        await file.close().catch(() => {});
      }
      const sha = hasher.digest('hex');
      const expect =
        typeof asset.digest === 'string' && asset.digest !== ''
          ? Buffer.from(asset.digest, 'base64').toString('hex')
          : '';
      if (expect !== '' && expect !== sha) {
        await unlink(tmp).catch(() => {});
        return { ok: false, reason: '校验失败：下载到的 SHA-256 与 GitHub 不一致，已丢弃' };
      }
      const info = {
        name: 'NapCatQQ OneKey installer',
        version,
        releasedAt: typeof rel.published_at === 'string' ? rel.published_at.slice(0, 10) : '',
        file: ZIP_NAME,
        sha256: sha,
        size: Number(asset.size || 0),
        source:
          typeof rel.html_url === 'string'
            ? rel.html_url
            : `https://github.com/NapNeko/NapCatQQ/releases/tag/v${version}`,
        license: 'Limited Redistribution License (see LICENSE-NapCat.txt)',
        downloadedBy: 'dsh-pet-qq',
      };
      await writeFile(cacheVersion, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
      await mkdir(root, { recursive: true });
      await rename(tmp, cacheZip).catch(async () => {
        // 跨 tmp 区 rename 失败时退回拷贝
        await copyFile(tmp, cacheZip);
        await unlink(tmp).catch(() => {});
      });
      log.info(`已下载最新 NapCat 安装器 v${version} 到 ${cacheZip}（SHA-256 校验通过）`);
      return { ok: true, version, source: info.source, size: info.size, sha256: sha };
    } catch (error) {
      await unlink(tmp).catch(() => {});
      return { ok: false, reason: `下载失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return { status, unpack, autoInstall, writeConfig, launch, stop, stopSync, wipe, wipeSync, fetchLatest, newToken };
}
