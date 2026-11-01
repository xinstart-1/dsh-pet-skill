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
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 随包分发的安装器文件名 */
export const ZIP_NAME = 'NapCat.Shell.Windows.OneKey.zip';

/** 预置配置里那条 WebSocket 服务器的名字（重复写入时按它去重） */
const SERVER_NAME = 'dsh-pet-qq';

/** 网关默认端口，与插件默认 `ws://127.0.0.1:3001` 对齐 */
export const DEFAULT_WS_PORT = 3001;

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
 * 读随包分发的版本清单（版本号、来源、SHA-256）。
 * @returns {Promise<any|null>} 清单（缺失或损坏返回 null）
 */
export async function bundleInfo() {
  const dir = assetsDir();
  if (dir === null) return null;
  try {
    return JSON.parse(await readFile(join(dir, 'version.json'), 'utf8'));
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
  /** 判定一个目录是不是装好的 Shell */
  const looksLikeApp = (dir) => existsSync(join(dir, 'bootmain', 'NapCatWinBootMain.exe'));
  if (looksLikeApp(installRoot)) return installRoot;
  const entries = await readdir(installRoot, { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
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

  /** 状态快照：设置页与接口共用一份口径 */
  async function status() {
    const info = await bundleInfo();
    const dir = assetsDir();
    const appPath = await findApp(installRoot);
    return {
      supported: process.platform === 'win32',
      version: String(info?.version ?? ''),
      source: String(info?.source ?? ''),
      zipPresent: dir !== null,
      installerDir,
      installRoot,
      installerExe: join(installerDir, 'NapCatInstaller.exe'),
      unpacked: existsSync(join(installerDir, 'NapCatInstaller.exe')),
      installed: appPath !== null,
      appPath: appPath ?? '',
      configPath: appPath === null ? '' : join(appPath, 'config', 'onebot11.json'),
      license: dir === null ? '' : join(dir, 'LICENSE-NapCat.txt'),
      running: child !== null,
      pid: child?.pid ?? 0,
    };
  }

  /** 解压随包的安装器（幂等；已解压直接返回 ok） */
  async function unpack() {
    if (process.platform !== 'win32') return { ok: false, reason: '内置安装器只有 Windows 版' };
    const dir = assetsDir();
    if (dir === null) return { ok: false, reason: '包内缺少安装器（安装可能不完整）' };
    if (existsSync(join(installerDir, 'NapCatInstaller.exe'))) {
      return { ok: true, already: true, dir: installerDir };
    }
    await mkdir(installerDir, { recursive: true });
    const zip = join(dir, ZIP_NAME);
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
    const exe = join(appPath, 'bootmain', 'NapCatWinBootMain.exe');
    if (!existsSync(exe)) return { ok: false, reason: `找不到启动器：${exe}` };
    const args = String(uin ?? '').trim() === '' ? [] : [String(uin).trim()];
    const started = spawn(exe, args, {
      cwd: join(appPath, 'bootmain'),
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

  return { status, unpack, writeConfig, launch, stop, newToken };
}
