/**
 * 内置的 NapCat 网关安装器：解压、预置 OneBot 配置、启停。
 *
 * 存在的理由很实际：协议端是这条链路唯一无法自动化的外部依赖，而让每个用户
 * 「去 GitHub 找包 → 读文档 → 在 WebUI 里新建 WebSocket 服务器 → 手抄 token」
 * 是这条链路最常见的失败点（配成客户端、消息格式选成 string、token 抄错）。
 * 本模块把能自动化的部分全接过来：
 *
 * 1. **解压 + 运行**：把随包分发的 OneKey 安装器解到固定目录，再以该目录为 cwd
 *    后台拉起它跑完（见 `autoInstall`）——安装器本身无交互，能全自动；
 * 2. **预置配置**：直接写 NapCat 真正的 workdir
 *    （`versions/<QQ版本>/resources/app/napcat/config/`，见 `resolveNapcatConfigDir`），
 *    把 WebSocket 服务器、端口、消息格式、token 一次性定死，并回填给插件配置；
 * 3. **启停**：spawn / taskkill 我们自己的子进程，退出时不留孤儿；拉起前先探本机
 *    有没有别人起的网关，有就不重复 spawn（两份 NapCat 会互相踢登录态）；
 * 4. **坏包自愈**：安装器下载不续传、复用又不校验，所以这里补一道完整性预检
 *    （`purgeBrokenPackages`），把截断的包删掉逼它重下——见下面第三条边界；
 * 5. **登录号回填**：登录看守确认 QQ 号后经 `onLogin` 交回调用方落盘，
 *    下次启动才能带号走快速登录（接线在 `dsh-pet/src/qq/index.js`）。
 *
 * 三条边界：
 * - **只带安装器，不带 QQ 客户端**。NTQQ 是腾讯的专有软件，不能随包分发；
 *   由安装器在用户机器上下载，这正是它的原始设计。下载下来的是**便携副本**：
 *   安装器把 QQ 安装包（`QQ_9.9.x_..._x64_01.exe`，约 300MB）落在它自己的 cwd 并改名
 *   `QQ.exe`，再用 7z 解到 `NapCat.<build>.Shell/`（解出约 1.15GB），NapCat 只往这份
 *   副本里注入——**用户电脑上已经装着的 QQ 客户端它既不看也不动**。
 *   注意：这是「安装包文件还在不在」的复用，不是「本机有没有 QQ」的检测。重跑时若
 *   `QQ.exe`（或 `NapCat.Shell.zip`）还在 cwd，它就跳过下载直接解压，否则重新下 300MB。
 *   **代价是它不校验完整性**：下载中断留下的截断包会被它原样复用，导致每次重试都失败在
 *   同一处（实测 `NapCat.Shell.zip` 只下到 10.9MB）。所以本模块在每次安装前和失败后都做
 *   完整性预检，把**能证明截断**的包删掉，逼它重新下载。
 * - **安装器是无交互控制台程序**（PE32+ console，实测 v4.18.41）：不读命令行参数、
 *   不弹目录选择、不点下一步、「安装完成」后自行退出，装到哪只由 cwd 决定。所以本模块
 *   把 cwd 固定成 `<数据目录>/napcat`，跑完再把 `NapCat.*.Shell` 归位到 `app/`。
 * - **只支持 Windows**：OneKey 发行包只有 Windows 版，其余平台如实返回不支持。
 *
 * @module dsh-pet-qq/napcat
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, writeSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wipeDir, wipeDirSync } from './uninstall.js';

/** 随包分发的安装器文件名 */
export const ZIP_NAME = 'NapCat.Shell.Windows.OneKey.zip';

/**
 * 安装器自己要下载的网关包文件名。
 *
 * 它是安装器写死的名字（实测 install.log 里 `执行命令: .\7z.exe … x "NapCat.Shell.zip"`），
 * 所以我们预取时也必须叫这个名字，才能让它「文件已存在 → 跳过下载」。
 */
export const SHELL_ZIP_NAME = 'NapCat.Shell.zip';

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
    return { phase: span.key, percent: span.from, label: span.label, detail: '解压中（约 1.1GB）' };
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
  const path =
    typeof file === 'string'
      ? file
      : (() => {
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
 * 从 zip 末尾的「中央目录结束记录」（EOCD）推算这个包本该有多大。
 *
 * 为什么需要它：安装器自己下载的包**没有断点续传**，网络一抖就留下一个截断的 zip；
 * 而它下次启动只判断"文件在不在"，于是拿着截断包再解压一次、再失败一次
 * （实测：`NapCat.Shell.zip` 只落到 10.9MB，真包 35.9MB，7z 报 `Unexpected end of archive`）。
 * EOCD 里记着中央目录的偏移与长度，两者相加就是完整包的大小——对不上就是截断。
 *
 * @param {Buffer} tail 文件末尾的一段字节（含 EOCD，最多 22 + 65535）
 * @param {number} fileSize 文件实际大小
 * @returns {number|null} 完整包应有的字节数；找不到 EOCD 或是 zip64（不猜）返回 null
 */
export function zipExpectedSize(tail, fileSize) {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail[i] !== 0x50 || tail[i + 1] !== 0x4b || tail[i + 2] !== 0x05 || tail[i + 3] !== 0x06) continue;
    const total = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    const commentLen = tail.readUInt16LE(i + 20);
    // zip64 用 0xFFFF/0xFFFFFFFF 当哨兵，真实长度记在别的记录里；这里不猜，交给「未知」分支
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null;
    // 末尾这段可能比整个文件还长（小文件），偏移量按文件绝对位置算
    const eocdAt = fileSize - tail.length + i;
    if (eocdAt < 0) return null;
    return cdOffset + cdSize + 22 + commentLen;
  }
  return null;
}

/**
 * 从 PE 头推算这个可执行文件至少有多少字节（各段中「文件偏移 + 原始长度」的最大值）。
 *
 * 用途是识别**下到一半就中断**的 `QQ.exe`：它的 PE 头在最前面，截断后头还在，
 * 但段表声明的长度会超过实际文件大小。
 *
 * @param {Buffer} head 文件开头的一段字节（至少覆盖段表；8KB 够）
 * @returns {number|null} 最小完整字节数；不是 PE 或头不完整时返回 null
 */
export function peMinBytes(head) {
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return null;
  const peOff = head.readUInt32LE(0x3c);
  if (peOff + 24 > head.length) return null;
  if (head[peOff] !== 0x50 || head[peOff + 1] !== 0x45) return null;
  const sections = head.readUInt16LE(peOff + 6);
  const optSize = head.readUInt16LE(peOff + 20);
  const table = peOff + 24 + optSize;
  if (sections === 0 || table + sections * 40 > head.length) return null;
  let max = table;
  for (let i = 0; i < sections; i += 1) {
    const at = table + i * 40;
    const rawSize = head.readUInt32LE(at + 16);
    const rawPtr = head.readUInt32LE(at + 20);
    if (rawSize > 0) max = Math.max(max, rawPtr + rawSize);
  }
  return max;
}

/**
 * 判断一个安装包文件是否完整（只读文件末尾/开头，不解压、不比对哈希）。
 *
 * 三态：`absent`（不存在，不用管）、`ok`（看着完整，或认不出格式——**认不出就假定它是好的**）、
 * `broken`（能证明是截断的）。只删 `broken`，绝不因为"看不懂"就删掉用户好不容易下好的 300MB。
 *
 * @param {string} file 绝对路径
 * @param {'zip'|'pe'} expectKind 预期格式
 * @returns {Promise<{state: 'absent'|'ok'|'broken', kind: string, reason: string}>}
 */
export async function inspectPackage(file, expectKind) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { state: 'absent', kind: 'absent', reason: '' };
  }
  const size = st.size;
  if (size === 0) return { state: 'broken', kind: expectKind, reason: '空文件（0 字节）' };
  const fd = openSync(file, 'r');
  try {
    if (expectKind === 'zip') {
      const tailLen = Math.min(size, 65557);
      const tail = Buffer.alloc(tailLen);
      readSync(fd, tail, 0, tailLen, size - tailLen);
      const expect = zipExpectedSize(tail, size);
      if (expect === null) {
        // 没有 EOCD：要么是下载被截断，要么根本不是 zip（但那说明这文件本身就是坏的）
        return { state: 'broken', kind: 'zip', reason: '找不到 zip 中央目录（下载被截断）' };
      }
      if (expect > size) {
        return { state: 'broken', kind: 'zip', reason: `zip 声明 ${expect} 字节，实际只有 ${size}（下载被截断）` };
      }
      return { state: 'ok', kind: 'zip', reason: '' };
    }
    const headLen = Math.min(size, 8192);
    const head = Buffer.alloc(headLen);
    readSync(fd, head, 0, headLen, 0);
    const min = peMinBytes(head);
    if (min === null) return { state: 'ok', kind: 'unknown', reason: '不是可识别的 PE，按未知处理（不删）' };
    if (min > size) {
      return { state: 'broken', kind: 'pe', reason: `PE 段表要求至少 ${min} 字节，实际只有 ${size}（下载被截断）` };
    }
    return { state: 'ok', kind: 'pe', reason: '' };
  } finally {
    closeSync(fd);
  }
}

/**
 * 解析 GitHub release asset 的 `digest` 字段成十六进制 SHA-256（纯函数，单测覆盖）。
 *
 * 实测格式是 `sha256:<64 位 hex>`（例如 `sha256:02e5ff0f…`），**不是 base64**。
 * 认不出的形状一律返回空串——宁可不校验，也不能拿一个错的值去比、把好包误判成坏的。
 *
 * @param {unknown} digest GitHub 返回的 `asset.digest`
 * @returns {string} 64 位小写十六进制，或空串（表示"没有可信的期望值"）
 */
export function parseAssetDigest(digest) {
  const text = typeof digest === 'string' ? digest.trim().toLowerCase() : '';
  if (text === '') return '';
  const m = /^sha256:([0-9a-f]{64})$/.exec(text);
  return m === null ? '' : m[1];
}

/**
 * 判断一个下载结果够不够格当"好包"（纯函数，单测覆盖）。
 *
 * 为什么不能只看 sha256：GitHub 偶尔不给 `digest`，那时只剩大小可依。
 * 而大小恰好是这次事故的判据——镜像把 34MB 截成 4.6MB，安装器却报"下载成功"。
 *
 * @param {{size: number, sha256: string}} actual 实际下到的
 * @param {{size?: number, sha256?: string}} expect 期望的（缺省项不校验）
 * @returns {{ok: boolean, reason: string}}
 */
export function verifyDownload(actual, expect) {
  const wantSize = Number(expect?.size ?? 0);
  if (wantSize > 0 && Number(actual?.size ?? 0) !== wantSize) {
    return {
      ok: false,
      reason: `大小不符：期望 ${wantSize} 字节，实际 ${Number(actual?.size ?? 0)} 字节（下载被截断）`,
    };
  }
  const wantSha = String(expect?.sha256 ?? '').toLowerCase();
  if (wantSha !== '' && String(actual?.sha256 ?? '').toLowerCase() !== wantSha) {
    return { ok: false, reason: 'SHA-256 与官方不一致（内容损坏或被中间人改写）' };
  }
  return { ok: true, reason: '' };
}

/**
 * 网关配置目录里必须存在的文件之一：有它才说明这是 NapCat 自己在用的 workdir。
 * `napcat.json` / `webui.json` 由 NapCat 首次启动生成，`onebot11*.json` 由它或我们生成。
 */
const CONFIG_DIR_MARKERS = ['napcat.json', 'webui.json'];

/** 探测本机已有网关时扫的 WebUI 端口区间（NapCat 默认 6099，多开会顺延） */
export const WEBUI_PROBE_PORTS = Object.freeze(Array.from({ length: 12 }, (_, i) => 6099 + i));

/** 单个端口的探测上限：launch 是用户点按钮后的同步等待，不能被探测拖慢 */
const PROBE_TIMEOUT_MS = 300;

/**
 * 按优先级列出可能的 NapCat 配置目录（纯函数，不做任何 IO）。
 *
 * 为什么不能再用 `<Shell>/config`：NapCat 4.18.41 的配置目录由它自己的
 * `ConfigBase` 构造器决定 —— `n = binaryPath`（即 `napcat.mjs` 所在目录），
 * `this.configPath = xe.join(n, 'config')`，只有设了 `NAPCAT_WORKDIR` 才换地方。
 * 而 `binaryPath` 是 `versions/<QQ版本>/resources/app/napcat`，安装器解出来的
 * `NapCat.<build>.Shell/` 只是外壳。所以插件原来写的
 * `<Shell>/config/onebot11.json` 是一份永远不会被读的孤儿文件：用户看到配置写成功、
 * 网关却始终不监听 OneBot 端口。
 *
 * 优先级（命中即止）：`NAPCAT_WORKDIR` > 已知版本号 > 逐个版本目录 > 老布局兜底。
 *
 * @param {{appPath: string, workdir?: string, curVersion?: string, versionDirs?: string[]}} args 解析输入
 * @param {string} args.appPath `NapCat.<build>.Shell` 的绝对路径
 * @param {string} [args.workdir] `NAPCAT_WORKDIR` 的值；非空时它压倒一切（NapCat 源码里就是最高优先）
 * @param {string} [args.curVersion] `versions/config.json` 里的 `curVersion`，即当前生效的版本目录名
 * @param {string[]} [args.versionDirs] `versions/` 下的全部子目录名，用于没读到 `curVersion` 时逐个试
 * @returns {string[]} 候选 config 目录，按优先级排列；至少 1 项
 */
export function resolveNapcatConfigDirCandidates({ appPath, workdir, curVersion, versionDirs = [] }) {
  /** `resources/app/napcat` 是 `napcat.mjs` 所在目录，配置目录是它的 `config` 子目录 */
  const tail = ['resources', 'app', 'napcat', 'config'];
  const app = String(appPath ?? '').trim();
  const seen = new Set();
  const out = [];
  const push = (dir) => {
    // 大小写不敏感地判重：Windows 上 `C:\a` 与 `c:\a` 是同一个目录
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dir);
  };
  const forced = String(workdir ?? '').trim();
  if (forced !== '') push(join(forced, 'config'));
  if (app === '') return out.length > 0 ? out : [join('', 'config')];
  const known = String(curVersion ?? '').trim();
  if (known !== '') push(join(app, 'versions', known, ...tail));
  for (const name of Array.isArray(versionDirs) ? versionDirs : []) {
    const major = String(name ?? '').trim();
    if (major === '') continue;
    push(join(app, 'versions', major, ...tail));
  }
  // 老布局兜底：NapCat 早期版本/手工搬过的目录确实读过 Shell 根下的 config
  push(join(app, 'config'));
  return out;
}

/**
 * 读 `versions/config.json` 里的 `curVersion`（NapCat 自己写的那份"当前生效版本"）。
 *
 * 它不是插件维护的文件，所以读不到、不是 JSON、字段缺失都只返回空串：
 * 调用方据此跳过这一档候选，退回"逐个版本目录试"。
 *
 * @param {string} appPath `NapCat.<build>.Shell` 的绝对路径
 * @returns {Promise<string>} 版本目录名（实测形如 `9.9.33-52230`）；读不到返回空串
 */
export async function readCurVersion(appPath) {
  const file = join(String(appPath ?? ''), 'versions', 'config.json');
  const raw = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (raw === null || typeof raw !== 'object') return '';
  return String(raw.curVersion ?? '').trim();
}

/**
 * 判断一个目录"看起来是 NapCat 真在用的 workdir"（至少含一个它自己生成的配置）。
 *
 * @param {string} dir 候选 config 目录
 * @returns {Promise<boolean>} 目录存在且含 `napcat.json` / `webui.json` / `onebot11*.json` 之一
 */
async function looksLikeNapcatConfigDir(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  return entries.some((name) => CONFIG_DIR_MARKERS.includes(name.toLowerCase()) || /^onebot11.*\.json$/i.test(name));
}

/**
 * 判断候选目录的「NapCat 包目录」（`resources/app/napcat`）是否已存在。
 *
 * 用来覆盖**刚装好、还没启动过**的情形：那时 workdir 里一个配置都没有，
 * 但 `resources/app/napcat` 一定在（`napcat.mjs` 就在里面）。这时候正确答案仍是
 * 往它下面建 `config`，而不是退回 Shell 根那个没人读的老目录。
 *
 * @param {string} dir 候选 config 目录
 * @returns {boolean} 其父级 `napcat` 目录存在
 */
function napcatPackageExists(dir) {
  const pkg = dir.slice(0, dir.length - 'config'.length).replace(/[\\/]+$/, '');
  return basename(pkg).toLowerCase() === 'napcat' && existsSync(pkg);
}

/**
 * 解析本机真正生效的 NapCat 配置目录（写配置、看登录态、读 WebUI 令牌都只认它）。
 *
 * 判定分三步：先按 `resolveNapcatConfigDirCandidates` 的优先级找**第一个像样的**
 * 目录（含 NapCat 自己生成的配置）；其次找第一个存在的候选；再其次找第一个
 * "包目录已存在、config 只是还没建"的候选（刚装好还没启动过）；都不要才返回老布局
 * 兜底。这里不 mkdir，免得把"猜错了目录"伪装成"写成功了"。
 *
 * @param {string} appPath `NapCat.<build>.Shell` 的绝对路径
 * @returns {Promise<{dir: string, source: 'workdir'|'curVersion'|'versionDir'|'legacy'|'fallback', candidates: string[]}>}
 */
export async function resolveNapcatConfigDir(appPath) {
  const versionRoot = join(String(appPath ?? ''), 'versions');
  const versionDirs = await readdir(versionRoot, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch(() => []);
  const curVersion = await readCurVersion(appPath);
  const candidates = resolveNapcatConfigDirCandidates({
    appPath,
    workdir: process.env.NAPCAT_WORKDIR,
    curVersion,
    versionDirs,
  });
  const fallback = join(String(appPath ?? ''), 'config');
  const forced = String(process.env.NAPCAT_WORKDIR ?? '').trim();
  const forcedDir = forced === '' ? '' : join(forced, 'config');
  const versionRootOfCur = curVersion === '' ? '' : join(String(appPath ?? ''), 'versions', curVersion);
  const inside = (dir, root) => root !== '' && dir.toLowerCase().startsWith(root.toLowerCase());
  const label = (dir) => {
    if (inside(dir, forcedDir)) return 'workdir';
    if (inside(dir, versionRootOfCur)) return 'curVersion';
    if (dir.toLowerCase() !== fallback.toLowerCase()) return 'versionDir';
    return 'legacy';
  };
  for (const dir of candidates) {
    if (await looksLikeNapcatConfigDir(dir)) return { dir, source: label(dir), candidates };
  }
  for (const dir of candidates) {
    if (existsSync(dir)) return { dir, source: label(dir), candidates };
  }
  for (const dir of candidates) {
    if (napcatPackageExists(dir)) return { dir, source: label(dir), candidates };
  }
  // 一个候选都不存在：如实交回兜底路径，由 writeConfig 去建并把它上报给调用方
  return { dir: fallback, source: 'fallback', candidates };
}

/**
 * 在安装根目录下找真正装好的 Shell 目录。
 * @param {string} installRoot 安装根目录
 * @returns {Promise<string|null>} `NapCat.*.Shell` 绝对路径（没装好返回 null）
 */
async function findApp(installRoot) {
  const found = findAppSync(installRoot);
  if (found !== null) return found;
  // 同步判定不认的（老版本/用户手工搬过的不规范名字）再走异步枚举兜底
  return findAppLoose(installRoot);
}

/**
 * `findApp` 的宽松兜底：名字不规范但结构对的也算（历史上处理过用户手工搬目录的情况）。
 * @param {string} installRoot 安装根目录
 * @returns {Promise<string|null>} Shell 目录或 null
 */
async function findAppLoose(installRoot) {
  /**
   * 判定一个目录是不是装好的 Shell。
   * 两种真实布局都要认（都是官方安装器产出的）：
   * - `bootmain/NapCatWinBootMain.exe`：旧 OneKey 把 bootmain 整个目录放进来；
   * - 根目录直接有 `NapCatWinBootMain.exe`：现版安装器是把 bootmain **里的文件**复制到
   *   Shell 根目录（实测 v4.18.41 就是这样，只认前者会误判成"没装好"）。
   */
  const looksLikeApp = (dir) =>
    existsSync(join(dir, 'bootmain', 'NapCatWinBootMain.exe')) || existsSync(join(dir, 'NapCatWinBootMain.exe'));
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
 * `findApp` 的同步版：拉起网关、登录看守等不能等 IO 的路径用。
 * 只做「名字精确匹配 + 结构判定」，不做宽松枚举（宽松逻辑要走异步 readdir，没有同步价）。
 * @param {string} installRoot 安装根目录
 * @returns {string|null} `NapCat.*.Shell` 绝对路径（没装好返回 null）
 */
function findAppSync(installRoot) {
  const looksLikeApp = (dir) =>
    existsSync(join(dir, 'bootmain', 'NapCatWinBootMain.exe')) || existsSync(join(dir, 'NapCatWinBootMain.exe'));
  const isShellName = (name) => /^NapCat\..+\.Shell$/i.test(name);
  const shellNamed = (dir) => isShellName(basename(dir)) && looksLikeApp(dir);
  if (shellNamed(installRoot)) return installRoot;
  let names;
  try {
    names = readdirSync(installRoot);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name === 'bootmain') continue;
    const dir = join(installRoot, name);
    if (shellNamed(dir)) return dir;
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
 * 用系统默认浏览器打开一个 URL（Windows）。
 *
 * 为什么用 `rundll32 url.dll,FileProtocolHandler` 而不是 `cmd /c start`：
 * `start` 要靠 cmd 解析命令行，URL 里的 `&` `?` `%` 会被 cmd 吃掉或展开（`?token=abc&x`
 * 会被截成两条命令），而 token 恰好是十六进制串、还可能带 `+`/`=`。rundll32 直接收
 * 一个 argv，不经 shell，参数原样传给外壳。也顺带避开 "start 被当成窗口标题" 的老坑。
 *
 * 失败不抛：开浏览器只是便利，打不开时调用方还有 URL 可以复制。
 * @param {string} url 要打开的地址
 * @returns {Promise<boolean>} 是否成功唤起
 */
function openInBrowser(url) {
  if (process.platform !== 'win32' || typeof url !== 'string' || url === '') return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(systemExe('rundll32.exe'), ['url.dll,FileProtocolHandler', url], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * 清掉安装器工作目录里**能证明已损坏**的安装包，让它下次只能重新下载。
 *
 * 为什么需要：NapCat 安装器自己下载时不做断点续传，网络一抖就留下截断文件；
 * 而它下次启动只判断"文件在不在"就直接复用。结果是一个坏包让每次重试都失败，
 * 用户既看不出原因、也不知道要先删哪个文件（实测踩过：`NapCat.Shell.zip` 停在 10.9MB，
 * 真包 35.9MB，7z 报 `Unexpected end of archive`）。
 *
 * 三条守则：
 * - **只删能证明坏的**（zip 少了中央目录 / 声明大小对不上、PE 段表要求比文件大）；
 *   认不出格式、或大小对得上的，一律当作好的留着——删掉一个完整的 300MB 代价太大，
 *   那是重跑时跳过下载的唯一依据。
 * - **不删安装器自己**（`NapCatInstaller.exe`、`7z.exe`、`bootmain/`），那些不是下载产物。
 * - **删不掉也继续**：文件被占用时只记日志；下一次预检还会再试。
 *
 * @param {string} dir 安装器工作目录（= 安装器的 cwd）
 * @param {{warn: Function, info: Function}} log 日志
 * @returns {Promise<string[]>} 实际删掉的文件名（给状态栏提示用）
 */
export async function purgeBrokenPackagesIn(dir, log) {
  /** 安装器按 cwd 读的两个下载产物：QQ 安装包与 NapCat Shell 包 */
  const targets = [
    { name: 'QQ.exe', kind: /** @type {const} */ ('pe') },
    { name: 'NapCat.Shell.zip', kind: /** @type {const} */ ('zip') },
  ];
  /** @type {string[]} */
  const removed = [];
  for (const target of targets) {
    const file = join(dir, target.name);
    if (!existsSync(file)) continue;
    const verdict = await inspectPackage(file, target.kind);
    if (verdict.state !== 'broken') continue;
    try {
      await unlink(file);
      removed.push(target.name);
      log.warn(`已删除损坏的安装包 ${target.name}（${verdict.reason}），重试时会重新下载`);
    } catch (error) {
      log.warn(
        `损坏的安装包 ${target.name} 删不掉（${error instanceof Error ? error.message : String(error)}），可手动删除后重试`,
      );
    }
  }
  return removed;
}

/**
 * 自己把 NapCat Shell 包下好、校验过，放进安装器工作目录，让安装器**跳过它的下载**。
 *
 * 为什么必须这么干（实测踩过，不是理论风险）：安装器下载 `NapCat.Shell.zip` 时**不校验长度**。
 * 本机实测 `ghfast.top` 直接 403；`ghproxy.net` 把 34MB 截成 4.6MB，而安装器照样打印
 * `[成功] 文件下载完成: 4 MB` / `[成功] NapCat下载成功`，接着 7z 报 `Unexpected end of archive`、
 * `解压NapCat失败，错误码: 2`。用户看到的就是「每次点①都失败」。
 *
 * 安装器的复用规则救了我们：它只判断「cwd 里这个文件在不在」，在就跳过下载直接解压
 * （上游 Linux 脚本 `检测到当前目录下存在QQ安装包, 将使用本地安装包进行安装` 是同一套逻辑）。
 * 所以我们先把**校验通过**的包放进去，它就不会再去碰那些坏镜像。
 *
 * 三条守则：
 * - **校验不过就当没下过**：大小或 SHA-256 对不上立刻删掉临时文件，绝不落进工作目录，
 *   免得安装器把残包当好的、又卡在同一个地方。
 * - **拿不到官方期望值就只校验大小**：GitHub 偶尔不给 `digest`，大小仍足以识破截断。
 * - **失败不影响安装**：这一步只是"帮忙"，拿不到就让安装器按它自己的路子走——
 *   大不了回到原来的坏镜像路径，不能因为预取失败就整个装不了。
 *
 * @param {string} dir 安装器工作目录（= 安装器的 cwd）
 * @param {{size: number, sha256: string, tag: string, url: string}|null} asset 官方期望值
 * @param {{info: Function, warn: Function}} log 日志
 * @param {(received: number) => void} [onProgress] 每块回调已收字节数（给进度条用）
 * @returns {Promise<{ok: boolean, reused?: boolean, size?: number, reason?: string}>} 结果
 */
export async function prefetchShellZipIn(dir, asset, log, onProgress) {
  const target = join(dir, SHELL_ZIP_NAME);
  if (asset === null || asset === undefined || Number(asset.size ?? 0) <= 0) {
    return { ok: false, reason: '没拿到官方包大小，跳过预取' };
  }
  // 已经在 → 不重复下 35MB，但必须**同时**满足：
  // ① zip 结构完整；② 大小与 SHA-256 都等于本次预期的官方资产。
  // 只查①会踩这次的事故：上次预取留在盘上的 4.18.42 包结构完整，
  // 却与随包 4.18.41 引导件混装，QQ 起不来还弹「文件已损坏，请重新安装QQ。」。
  // 版本一换，旧包必须换成同 tag 的新包。
  if (existsSync(target)) {
    const verdict = await inspectPackage(target, 'zip');
    if (verdict.state === 'ok') {
      const st = await open(target, 'r')
        .then(async (f) => {
          try {
            const { size } = await f.stat();
            const hasher = createHash('sha256');
            const buf = Buffer.allocUnsafe(64 * 1024);
            let pos = 0;
            // 逐块读，不把 35MB 整包读进内存
            for (;;) {
              const { bytesRead } = await f.read(buf, 0, buf.length, pos);
              if (bytesRead === 0) break;
              hasher.update(buf.subarray(0, bytesRead));
              pos += bytesRead;
            }
            return { size, sha256: hasher.digest('hex') };
          } finally {
            await f.close().catch(() => {});
          }
        })
        .catch(() => null);
      if (st !== null && verifyDownload(st, asset).ok) return { ok: true, reused: true };
    }
    await unlink(target).catch(() => {});
  }
  if (typeof fetch !== 'function') return { ok: false, reason: '运行环境不支持下载（无 fetch）' };

  /**
   * 下载源顺序，按**本机实测**的可达性排（不是拍脑袋）：
   * 官方直连在这台机器上直接 `fetch failed`；`ghfast.top` 实测 HTTP 403；
   * `ghproxy.net` 与 `gh-proxy.com` 实测可下（后者 4.5 秒下完 35.9MB）。
   * **每个源都按同一套标准校验**，所以顺序只影响快慢、不影响正确性。
   */
  const base = String(asset.url ?? '');
  const sources = [
    base,
    `https://ghproxy.net/${base}`,
    `https://gh-proxy.com/${base}`,
    `https://ghfast.top/${base}`,
  ].filter((s) => s !== '');

  const tmp = join(dir, `${SHELL_ZIP_NAME}.part`);
  const reasons = [];
  for (const src of sources) {
    let host = src;
    try {
      host = new URL(src).host;
    } catch {
      /* 地址不合法时就用原串当标签 */
    }
    try {
      await unlink(tmp).catch(() => {});
      const resp = await fetch(src, { headers: { 'User-Agent': 'dsh-pet-qq' } });
      if (!resp.ok) {
        reasons.push(`${host} HTTP ${resp.status}`);
        continue;
      }
      const hasher = createHash('sha256');
      let size = 0;
      const file = await open(tmp, 'w');
      try {
        for await (const chunk of resp.body) {
          hasher.update(chunk);
          size += chunk.length;
          await file.write(chunk);
          // 进度只在"这一块之后"报，节流交给调用方（每块都刷一次 DOM 太浪费）
          onProgress?.(size);
        }
      } finally {
        await file.close().catch(() => {});
      }
      const verdict = verifyDownload({ size, sha256: hasher.digest('hex') }, asset);
      if (verdict.ok !== true) {
        // 关键：残包只删不留。留着它，安装器下次就会拿它去解压、再失败一次。
        await unlink(tmp).catch(() => {});
        reasons.push(`${host} ${verdict.reason}`);
        continue;
      }
      await rename(tmp, target).catch(async () => {
        await copyFile(tmp, target);
        await unlink(tmp).catch(() => {});
      });
      log.info(`已校验并预置网关包 ${SHELL_ZIP_NAME}（${size} 字节，${String(asset.tag ?? '')}），安装器会跳过下载`);
      return { ok: true, size };
    } catch (error) {
      reasons.push(`${host} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await unlink(tmp).catch(() => {});
  return { ok: false, reason: reasons.join('；') };
}

/**
 * 建一个网关管理器。
 * @param {{root: string, log: object, onLogin?: (uin: string) => void | Promise<void>}} deps 依赖
 *   （`root` = `<数据目录>/napcat`；`onLogin` 在登录看守确认 QQ 号后调用，
 *   调用方应把号落进 `account.selfId`，否则下次 launch 只能传空号、每次都要重新扫码）
 * @returns {any} 管理器
 */
export function createNapcat({ root, log, onLogin = null }) {
  /** 解压出来的安装器目录 */
  const installerDir = root;
  /** 安装器要装到这个目录（固定下来，插件才能预置配置和启停） */
  const installRoot = join(root, 'app');
  /** @type {import('node:child_process').ChildProcess|null} 我们拉起的网关进程 */
  let child = null;
  /** @type {{cancelled: boolean}|null} 登录看守（同一时间只允许一个在跑） */
  let loginWatcher = null;

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

  /**
   * 兜底 tag：读不到随包版本清单时按这个版本找 release。
   *
   * 为什么不能追 `latest`：`NapCatWinBootMain.exe` / `NapCatWinBootHook.dll` 来自随包
   * OneKey 安装器（固定 tag），payload 也必须取自**同一个 tag**。安装器只带引导件
   * （约 994KB），`NapCat.Shell.zip` 是安装时从 release 下载的；预取若取了更新的 tag，
   * 就会把「旧引导 + 新 payload」混装，QQ 启动时的 v2 自检失败，弹原生窗
   * 「文件已损坏，请重新安装QQ。」，网关随即退出（code=0），OneBot 3001 永不监听。
   * 见 https://github.com/NapNeko/NapCatQQ/issues/2145 （4.18.42 payload + 4.18.41 引导
   * 在 QQ 9.9.33-52230 上 `error code v2:-8`；换回 4.18.41 即正常）。
   */
  const FALLBACK_TAG = 'v4.18.41';

  /**
   * 从**与随包安装器同一个** NapCat release 里查 `NapCat.Shell.zip` 的大小、SHA-256 与地址。
   *
   * 校验的期望值必须来自官方元数据，不能靠"下完看它有多大"——那样残包永远合格。
   * 用 `releases/tags/<tag>` 而不是 `releases/latest`：tag 必须与随包安装器一致，
   * 否则引导件与 payload 跨版本混装（见 FALLBACK_TAG 的注释）。
   *
   * @returns {Promise<{size: number, sha256: string, tag: string, url: string}|null>} 拿不到就 null
   */
  async function shellAssetInfo() {
    if (typeof fetch !== 'function') return null;
    // 刻意读**随包**清单，不用 readBundleInfo()（它会优先读"下载的最新安装器"的标签）。
    // 那个标签是 release 的 tag_name，不是安装器二进制真正所属的 release：实测 v4.18.41
    // 与 v4.18.42 的 OneKey.zip 是同一个字节（同为 994134 / sha256 46c3ec15…），
    // 点「下载最新安装器」只会把标签刷成 4.18.42，装出来的却是同一份 4.18.41 引导件。
    // 拿那个标签去 pin 会把「旧引导 + 新 payload」的混装原样请回来。
    const info = await bundleInfo();
    const clean =
      String(info?.version ?? '')
        .trim()
        .replace(/^v/, '') || FALLBACK_TAG.replace(/^v/, '');
    const releaseTag = `v${clean}`;
    try {
      const resp = await fetch(`https://api.github.com/repos/NapNeko/NapCatQQ/releases/tags/${releaseTag}`, {
        headers: { 'User-Agent': 'dsh-pet-qq', Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) return null;
      const rel = await resp.json();
      const asset = (Array.isArray(rel?.assets) ? rel.assets : []).find(
        (a) => a !== null && typeof a === 'object' && a.name === SHELL_ZIP_NAME,
      );
      if (asset === undefined || typeof asset.browser_download_url !== 'string') return null;
      return {
        size: Number(asset.size ?? 0),
        sha256: parseAssetDigest(asset.digest),
        tag: clean,
        url: asset.browser_download_url,
      };
    } catch {
      return null;
    }
  }

  /**
   * 读网关自带 WebUI 的监听地址与令牌（扫码登录就在这里，控制台看不到码）。
   *
   * 为什么必须读它：`NapCatWinBootMain.exe` 起来后会打印一行
   * `[StdOut] 已重定向到命名管道: \\.\pipe\NapCat_<pid>`，**之后 stdout 全被接管**，
   * 二维码只经 WebUI（默认 `http://127.0.0.1:6099/webui`）呈现。用户盯着那个黑窗口
   * 永远等不到码，所以插件要自己把面板地址算出来。
   *
   * 令牌来源：`<Shell>/resources/app/napcat/config/webui.json` 里的 `token`。它是 NapCat
   * 首次启动时自动生成的；我们的面板 URL 用 `?token=` 传它——这正是 NapCat 自己
   * 打印 `WebUi User Panel Url` 用的同一种拼法（源码里的 URL 构造函数）。
   *
   * @returns {Promise<{port: number, token: string, url: string}|null>} 拿不到（没装/文件还没生成）返回 null
   */
  async function webuiInfo() {
    const appPath = await findApp(installRoot);
    if (appPath === null) return null;
    // webui.json 落在 NapCat 真正生效的 workdir 里（与 onebot11*.json 同一个目录），
    // 目录解析规则见 resolveNapcatConfigDir —— 猜错目录就拿不到面板地址。
    const { dir: configDir } = await resolveNapcatConfigDir(appPath);
    const candidate = join(configDir, 'webui.json');
    if (!existsSync(candidate)) return null;
    const cfgPath = candidate;
    const raw = await readFile(cfgPath, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (raw === null || typeof raw !== 'object') return null;
    const port = Number(raw.port ?? 0);
    const token = String(raw.token ?? '').trim();
    if (!(port > 0) || token === '') return null;
    // `host` 可能是 `::` / `0.0.0.0`（监听全部）——那种情况本地访问要用 127.0.0.1。
    const host = String(raw.host ?? '').trim();
    const dial = host === '' || host === '::' || host === '0.0.0.0' ? '127.0.0.1' : host;
    return { port, token, url: `http://${dial}:${port}/webui?token=${encodeURIComponent(token)}` };
  }

  /** 状态快照：设置页与接口共用一份口径 */
  async function status() {
    const info = await readBundleInfo();
    const r = resolveZip();
    const appPath = await findApp(installRoot);
    const webui = await webuiInfo();
    // 真实生效的配置目录（不是 `<Shell>/config` 那个孤儿目录），设置页要能看见它，
    // 出问题时用户才能一眼看出配置写到了哪、以及是不是猜错了目录。
    const resolved = appPath === null ? null : await resolveNapcatConfigDir(appPath);
    const configDir = resolved === null ? '' : resolved.dir;
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
      /** 实际解析出的 NapCat 配置目录；未安装时为空串 */
      configDir,
      configPath: configDir === '' ? '' : join(configDir, 'onebot11.json'),
      license: r !== null && !r.fromCache ? join(r.dir, 'LICENSE-NapCat.txt') : '',
      running: child !== null,
      pid: child?.pid ?? 0,
      /** 扫码面板地址（含令牌）；未装或 webui.json 还没生成时为空串 */
      webuiUrl: webui === null ? '' : webui.url,
      webuiPort: webui === null ? 0 : webui.port,
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
   *
   * 写入位置由 `resolveNapcatConfigDir` 决定（NapCat 自己的 workdir），**不是**
   * `<Shell>/config`：后者在 4.18.41 上没有任何读取方，写进去等于没写。
   * 返回里带上 `configDir`，调用方与日志都能核对到底写到了哪。
   *
   * @param {{port?: number, token?: string}} [opts] 端口与令牌（不传则沿用配置里的/新建）
   * @returns {Promise<any>} `{ok, token, wsUrl, path, configDir}`
   */
  async function writeConfig({ port = DEFAULT_WS_PORT, token = '' } = {}) {
    const appPath = await findApp(installRoot);
    if (appPath === null) {
      return { ok: false, reason: `网关还没装好：${installRoot} 下找不到 NapCat.*.Shell（先运行安装器）` };
    }
    const { dir: configDir, source } = await resolveNapcatConfigDir(appPath);
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

    // 把选中的目录一并说出来：目录猜错时这是唯一能自查的线索
    log.info(`已写入网关配置：${mainFile}（WebSocket 服务器 127.0.0.1:${port}，目录来源 ${source}）`);
    return {
      ok: true,
      token: useToken,
      wsUrl: `ws://127.0.0.1:${port}`,
      path: mainFile,
      configDir,
      configSource: source,
    };
  }

  /**
   * 登录看守：等账号级 `onebot11_<QQ号>.json` 出现，出现即补写服务器配置并带号重启。
   *
   * 为什么需要：登录成功那一刻 NapCat 生成的账号级配置里 **`websocketServers` 是空的**，
   * 而它的优先级高于我们预写的默认 `onebot11.json` —— 不处理，OneBot 端口永远不监听，
   * 用户看到的就是"明明扫码成功了，状态还是离线"（实测踩过：登了 2477690764，
   * `onebot11_2477690764.json` 里 servers 空，3001 不监听，插件重连了一整夜）。
   *
   * 为什么重启而不是热改：NapCat 只在启动时读这份配置，没有热重载接口。
   * 重启用 `NapCatWinBootMain.exe <QQ号>` 走缓存会话快速登录，几秒回在线，不用再扫码。
   *
   * 看守上限 10 分钟：超时多半是用户没扫码（网关窗口/WebUI 等着呢），不再空转。
   *
   * 确认登录后还会调 `onLogin(uin)`：账号级配置只存在于磁盘上，插件配置里的
   * `account.selfId` 必须由调用方落盘，否则下次 `launch({uin})` 传的仍是空串，
   * 每次都退化成扫码登录（本机日志里明明有「可用于快速登录的 QQ」）。
   * @param {{port?: number, token?: string}} [opts] 端口与令牌（沿用插件配置里的）
   * @returns {Promise<{ok: boolean, uin?: string, reason?: string}>}
   */
  async function watchAccountLogin({ port = DEFAULT_WS_PORT, token = '' } = {}) {
    if (loginWatcher !== null) return { ok: false, reason: '已有看守在跑' };
    const appPath = await findApp(installRoot);
    if (appPath === null) return { ok: false, reason: '网关还没装好' };
    // 扫描的必须是 NapCat 真正读写的目录，否则账号级配置永远扫不到、整段看守是死代码
    const { dir: configDir } = await resolveNapcatConfigDir(appPath);
    loginWatcher = { cancelled: false };
    const mine = loginWatcher;
    const deadline = Date.now() + 10 * 60 * 1000;
    /** 已经处理过的号：同一个号只补写+重启一次，避免看门狗把自己绕成重启循环 */
    const handled = new Set();
    try {
      while (Date.now() < deadline) {
        if (mine.cancelled) return { ok: false, reason: '已被手动停止' };
        await new Promise((done) => setTimeout(done, 2000));
        // 登录成功的**可靠**判据不是「文件在不在」（登录过一次就永久在），
        // 也不是「mtime 变没变」（NapCat 每次启动都会重写它，必然变）。
        // 真正需要修的状态只有一种：账号级配置里**我们那条服务器不对**——
        // 缺了、或者端口/令牌与插件手上那份不一致。这才值得停下网关、补写、再拉起。
        // 已经对上了就什么都不做（否则就是"刚连上又被自己重启"的无限循环）。
        const uins = (await readdir(configDir).catch(() => []))
          .map((name) => /^onebot11_(\d+)\.json$/.exec(name)?.[1] ?? '')
          .filter((n) => n !== '' && !handled.has(n));
        for (const uin of uins) {
          if (mine.cancelled) return { ok: false, reason: '已被手动停止' };
          const accountFile = join(configDir, `onebot11_${uin}.json`);
          const existing = await readFile(accountFile, 'utf8')
            .then((text) => JSON.parse(text))
            .catch(() => null);
          if (serverConfigMatches(existing, { port, token }) === true) {
            // 网关侧已经是插件要的样子：不需要重启，把号报上去就够了
            handled.add(uin);
            if (typeof onLogin === 'function') await callOnLogin(uin);
            // 网关侧已经是对的：看守的任务到此就完成了，直接返回，不要再往下
            // 走到「child === null 就报网关已退出」——那会把一个正常的成功态报成失败。
            return { ok: true, uin, already: true };
          }
          // 登录了但服务器配置缺/错：把服务器合并进账号级文件（NapCat 只在启动时读它）
          const useToken = String(token ?? '').trim();
          const server = buildOneBotConfig(useToken === '' ? newToken() : useToken, port).network.websocketServers[0];
          await writeFile(accountFile, `${JSON.stringify(mergeServer(existing, server), null, 2)}\n`, 'utf8');
          handled.add(uin);
          log.info(`检测到登录（${uin}）：账号级配置缺 WebSocket 服务器，已补写并重启网关使其生效`);
          // 先回填号再重启：重启要几百毫秒，此时设置页可能已经被刷新，落盘越早越好
          if (typeof onLogin === 'function') await callOnLogin(uin);
          // 重启（快速登录，免再扫码）：先杀再拉，间隔 1 秒让端口释放
          await stop();
          await new Promise((done) => setTimeout(done, 1000));
          const again = spawnGateway(uin);
          return again.ok === true ? { ok: true, uin } : again;
        }
        // 没登录才看进程还在不在：网关退出了就别再空等（用户可能手动关了窗口）
        if (child === null) return { ok: false, reason: '网关已退出，不再等登录' };
      }
      return { ok: false, reason: '等登录超时（10 分钟没等到账号级配置），可能还没扫码' };
    } finally {
      if (loginWatcher === mine) loginWatcher = null;
    }
  }

  /**
   * 回调 onLogin，失败只留痕——配置已经写好、网关还等着重启，不能因为落盘失败就中断。
   * @param {string} uin QQ 号
   * @returns {Promise<void>} 完成
   */
  async function callOnLogin(uin) {
    if (typeof onLogin !== 'function') return;
    try {
      await onLogin(uin);
    } catch (error) {
      log.warn(`回填登录号失败（不影响本次登录）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 账号级配置里那条服务器，是否已经是插件要的样子（端口 + 令牌都对上）。
   *
   * 这是登录看守唯一该据以"动手"的判据：缺条目、端口不符、令牌不符 → 要补写重启；
   * 全对上 → 说明网关侧已经能听 3001，再重启只是把自己打断。
   *
   * 比较的是**令牌是否相等**而不是"有没有令牌"：曾经的 bug 就是看守拿空令牌去
   * 生成新的，网关与插件从此各持一个，握手必被踢（表现为连上即断、无限重连）。
   *
   * @param {any} existing 账号级配置的 JSON（可能为 null）
   * @param {{port: number, token: string}} want 期望的端口与令牌
   * @returns {boolean} 是否已一致
   */
  function serverConfigMatches(existing, { port, token }) {
    const list = existing?.network?.websocketServers;
    if (!Array.isArray(list)) return false;
    const ours = list.find((item) => item?.name === SERVER_NAME);
    if (ours === undefined) return false;
    if (Number(ours.port) !== Number(port)) return false;
    if (ours.enable !== true) return false;
    const want = String(token ?? '').trim();
    // 插件没配令牌（空串）= 不校验令牌这一项，但端口与开关仍要对
    if (want === '') return true;
    return String(ours.token ?? '') === want;
  }

  /**
   * 网关起来后把扫码面板推到用户面前。
   *
   * 为什么必须主动开：`NapCatWinBootMain.exe` 打印 `[StdOut] 已重定向到命名管道` 之后
   * stdout 就被接管了，二维码只经 WebUI 呈现——那个黑窗口里永远等不到码。让用户自己
   * 猜端口、抄 token 是不现实的，所以启动后直接开浏览器。
   *
   * WebUI 是网关进程内起的，会晚于 spawn 一两秒；这里轮询等它把 `webui.json` 写出来
   * （最多约 12 秒），拿到地址就开。拿不到不报错——面板地址仍在 status 里，用户能手动点。
   *
   * @returns {Promise<string>} 成功打开的面板地址；没开成返回空串
   */
  async function openWebuiWhenReady() {
    for (let i = 0; i < 24; i += 1) {
      if (child === null) return ''; // 网关已经退出了，没必要再等
      const info = await webuiInfo();
      if (info !== null) {
        const opened = await openInBrowser(info.url);
        log.info(opened ? `已自动打开扫码登录页：${info.url}` : `扫码登录页（请手动打开）：${info.url}`);
        return opened ? info.url : '';
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    log.warn('网关已启动，但没等到 WebUI 就绪（webui.json 未生成），可在设置页手动打开扫码页');
    return '';
  }

  /**
   * 探测某个本机端口上有没有人在听 TCP（网关的 WebUI / OneBot 口都是本机 HTTP/WS）。
   *
   * 只有"连上了"才算在听：连不上、超时、被拒都一律当没在听。单口上限
   * {@link PROBE_TIMEOUT_MS}，因为 launch 是用户点按钮后的同步等待。
   *
   * @param {number} port 端口号
   * @returns {Promise<boolean>} 是否有监听者
   */
  function probePort(port) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (hit) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(hit);
      };
      const socket = connect({ host: '127.0.0.1', port });
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }

  /**
   * 找出本机已有的 NapCat 网关（不是我们拉的那个）。
   *
   * 为什么要这道守卫：两个网关实例共用同一个 QQ `--user-data-dir` 时会互相踢下线、
   * 互相重载，用户看到的是「时断时连」。本机实测就同时跑过两份（一份手工启动、
   * 一份插件拉起），两个 WebUI 端口 6099/6100 同时在听。
   *
   * 判定顺序：先看我们自己的 `webui.json` 声明的端口，再顺扫
   * {@link WEBUI_PROBE_PORTS}。全部并发探、各自独立超时，整体不会超过一个超时周期。
   *
   * @returns {Promise<{port: number, url: string}|null>} 找到就返回端口与面板地址
   */
  async function findRunningGateway() {
    const info = await webuiInfo();
    /** @type {number[]} */
    const ports = [];
    if (info !== null && info.port > 0) ports.push(info.port);
    for (const port of WEBUI_PROBE_PORTS) if (!ports.includes(port)) ports.push(port);
    const hits = await Promise.all(ports.map((port) => probePort(port).then((hit) => (hit ? port : 0))));
    const live = hits.filter((port) => port > 0);
    if (live.length === 0) return null;
    // 优先报我们配置里那个端口，它是用户最可能正在用的面板
    const port = info !== null && live.includes(info.port) ? info.port : live[0];
    const base = info !== null && info.port === port ? info.url : `http://127.0.0.1:${port}/webui`;
    return { port, url: base };
  }

  /**
   * 启动网关（`NapCatWinBootMain.exe [uin]`，uin 给了就是快速登录）。
   *
   * `port` / `token` 必须由调用方从插件配置里带过来：它们会被原样传给后台的登录看守，
   * 看守据此写账号级配置。漏传的后果见 `watchAccountLogin` 调用处那段注释——看守会
   * 自己造一个新令牌，网关与插件从此各拿一个，握手必被踢。
   *
   * @param {{uin?: string, openWebui?: boolean, port?: number, token?: string}} [opts] 参数
   * @returns {Promise<any>} `{ok, pid, webuiUrl, already?, external?}`
   */
  async function launch({ uin = '', openWebui = true, port = DEFAULT_WS_PORT, token = '' } = {}) {
    if (child !== null) {
      const known = await webuiInfo();
      return { ok: true, already: true, pid: child.pid ?? 0, webuiUrl: known === null ? '' : known.url };
    }
    // 先判安装：没装好就如实说，不要因为"本机另有网关在跑"就报成功——
    // 那份不是我们管的，插件没法写它的配置、也没法停它。
    if (findBootDirSync() === null) return { ok: false, reason: '网关还没装好，先运行安装器' };
    // 起之前先看本机是不是已经有一个不是我们拉的网关：两份实例共用一个
    // `--user-data-dir` 会互相踢登录态，表现就是「时断时连」。发现就不要再 spawn。
    const external = await findRunningGateway();
    if (external !== null) {
      log.warn(
        `本机已有一个不是本插件拉起的网关实例（WebUI 127.0.0.1:${external.port}），` +
          '可能造成端口/登录态冲突，建议只保留一个；本次不再重复启动',
      );
      return { ok: true, already: true, external: true, pid: 0, webuiUrl: external.url };
    }
    const r = spawnGateway(uin);
    if (r.ok !== true) return r;
    // 登录那一刻 NapCat 会生成账号级 onebot11_<QQ号>.json，**其中服务器列表是空的**，
    // 且优先级高于我们预写的默认配置——不补写，3001 永远不监听（实测踩过）。
    // 这里挂个后台看守，登录一发生就补写并带号重启（重启走缓存会话，秒回在线）。
    //
    // **令牌必须原样传下去**：看守是"补写服务器配置"的执行者，它写的令牌就是
    // 网关之后要求连接方出示的令牌。曾经这里无参调用，导致看守拿到默认空串、
    // 走 `newToken()` 生成了一个**新**令牌写进账号级配置，而插件仍拿配置里的旧令牌
    // 去连——网关开着、端口也在听，却每次握手成功即被踢，日志表现为
    // 「连上了但拿不到登录信息：连接断开，调用未完成」无限循环（实测踩过 30 分钟）。
    void watchAccountLogin({ port, token });
    // 后台等面板就绪再开浏览器，不阻塞 launch 的返回（设置页要立刻拿到 pid）
    if (openWebui !== true) return { ok: true, pid: r.pid, webuiUrl: '' };
    const webuiUrl = await openWebuiWhenReady();
    return { ok: true, pid: r.pid, webuiUrl };
  }

  /** 真正拉起网关进程（首次启动与「登录后重启」共用） */
  function spawnGateway(uin = '') {
    const bootDir = findBootDirSync();
    if (bootDir === null) return { ok: false, reason: '网关还没装好，先运行安装器' };
    const exe = join(bootDir, 'NapCatWinBootMain.exe');
    if (!existsSync(exe)) return { ok: false, reason: `找不到启动器：${exe}` };
    const args = String(uin ?? '').trim() === '' ? [] : [String(uin).trim()];
    /** @type {import('node:child_process').ChildProcess} */
    let started;
    try {
      started = spawn(exe, args, {
        cwd: bootDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (error) {
      // Windows 上对空文件/非可执行文件 spawn 会同步抛 EFTYPE/EACCES——这里如实带回，
      // 不能让异常逃出去炸掉调用方（看守、路由都走这条路径）
      return { ok: false, reason: `启动失败：${error instanceof Error ? error.message : String(error)}` };
    }
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
    log.info(`已启动网关（pid=${started.pid ?? 0}${uin ? '，快速登录 ' + uin : ''}）`);
    return { ok: true, pid: started.pid ?? 0 };
  }

  /** 找网关启动器所在目录（bootmain/ 子目录或 Shell 根目录，两种官方布局都认） */
  function findBootDirSync() {
    const appPath = findAppSync(installRoot);
    if (appPath === null) return null;
    if (existsSync(join(appPath, 'bootmain', 'NapCatWinBootMain.exe'))) return join(appPath, 'bootmain');
    return appPath;
  }

  /** 停掉我们拉起的网关进程（连带子进程；不是我们拉的就明确说不知道） */
  async function stop() {
    // 手动停止 = 用户不想让它跑，取消登录看守（否则看守里的「重启」会把它再拉起来）
    if (loginWatcher !== null) {
      loginWatcher.cancelled = true;
      loginWatcher = null;
    }
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
   * 为什么可以全自动：安装器是个无交互控制台程序（实测 v4.18.41：`PE32+ console`，
   * 不读命令行参数、不弹目录选择、不问下一步），流程是
   * 检查 QQ 安装包 → 下载 QQ（腾讯官方 CDN + 多镜像 + SHA-256 校验）→ 解压 →
   * 下载 NapCat Shell → 解压 → 改 package.json 启动脚本 → 复制引导文件 →
   * 「===== 安装完成 =====」后自行退出。装到哪只由 cwd 决定，所以这里把 cwd 钉在
   * installerDir。唯一要人做的只剩最后用小号扫码登录。
   *
   * 「检查 QQ 安装包」检查的是**它自己 cwd 里那个 `QQ.exe` 安装包**，不是本机装没装 QQ：
   * 文件还在就跳过 300MB 下载直接解压（本模块跑完不删它，所以重跑会快很多）；不在就重下。
   * 用户系统里那份 QQ 客户端自始至终不参与，也不被改动。
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
    // 一进来就置「安装中」，不能等 spawn 之后才置——预取要下 35MB，那段时间如果
    // running 还是 false，UI 上按钮不会变、进度条停在 0，用户看到的就是「点了没反应」；
    // 更糟的是这时再点一次会并发再起一轮预取。
    installState.running = true;
    installState.phase = 'running';
    installState.percent = 0;
    installState.label = '准备中';
    installState.detail = '';
    installState.error = '';
    installState.startedAt = Date.now();
    const failEarly = (reason) => {
      installState.running = false;
      installState.phase = 'failed';
      installState.label = '安装失败';
      installState.percent = 0;
      installState.error = reason;
      return { ok: false, reason };
    };
    const up = await unpack();
    if (up.ok !== true) return failEarly(up.reason ?? '解压安装器失败');
    const exe = join(installerDir, 'NapCatInstaller.exe');
    if (!existsSync(exe)) return failEarly(`解压完成但没找到 ${exe}`);
    // 跑之前先清掉上次留下的坏包。安装器自己只判断"文件在不在"，不校验完整性，
    // 所以一个下载到一半的 QQ.exe / NapCat.Shell.zip 会让它每次都卡在同一个地方失败——
    // 用户看到的是"点了重试还是失败"，且无从知道要先手动删文件。
    // 只删能证明截断的（认不出格式的一律留着），免得把好好的 300MB 也删了。
    const purged = await purgeBrokenPackages();
    if (purged.length > 0) log.info(`开跑前已清掉损坏的安装包：${purged.join('、')}（会重新下载）`);
    // 再往前一步：安装器自己下载网关包时**不校验长度**，镜像一截断它就报"下载成功"
    // 然后解压失败（实测 34MB 只下到 4.6MB，用户看到的就是"每次都失败"）。
    // 所以先把校验过的包放进它的 cwd，让它走"文件已存在 → 跳过下载"这条路。
    // 拿不到也不算失败：这一步只是帮忙，退回安装器自己的下载路径即可。
    const asset = await shellAssetInfo();
    if (asset !== null) {
      installState.label = '下载网关包';
      installState.detail = `0MB/${Math.round(asset.size / 1024 / 1024)}MB（插件自己下，带校验）`;
      // 预取期间用 0–70 的进度条：安装器那两段下载从这里接着走，
      // 否则用户会觉得"点了没反应"（35MB 在慢网下要几十秒）。
      const pre = await prefetchShellZip(asset, (got) => {
        const pct = asset.size > 0 ? Math.min(70, Math.round((got / asset.size) * 70)) : 0;
        installState.percent = pct;
        installState.detail = `${Math.round(got / 1024 / 1024)}MB/${Math.round(asset.size / 1024 / 1024)}MB（插件自己下，带校验）`;
      });
      if (pre.ok !== true) {
        log.warn(`预取网关包没成（${pre.reason}），改由安装器自己下载`);
        installState.label = '准备中';
        installState.detail = '';
        installState.percent = 0;
      } else if (pre.reused === true) {
        installState.detail = '已有校验通过的网关包，直接复用';
      }
    } else {
      log.warn('没查到官方网关包元数据，跳过预取，由安装器自己下载');
    }
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
      return failEarly(`启动安装器失败：${error instanceof Error ? error.message : String(error)}`);
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
    // 状态已在函数入口置好（预取阶段就要给用户看到进度），这里只补细节
    installState.label = '准备中';
    installState.detail = '';
    installState.percent = 0;
    log.info('已后台拉起 NapCat 安装器（全自动：下载 QQ + Shell，几分钟）');
    // 看门狗：30 分钟还没完（网络极慢/卡死）就杀掉并标失败，别让状态永远"安装中"
    const watchdog = setTimeout(
      () => {
        if (installState.running) {
          try {
            proc.kill();
          } catch {
            /* 已退出就算了 */
          }
        }
      },
      30 * 60 * 1000,
    );
    proc.on('exit', (code) => {
      clearTimeout(watchdog);
      flushLog();
      installState.running = false;
      // 失败有两种面孔：进程给了非零退出码，或者它自己出错后停在 "Press any key"
      // 被我们杀掉/卡住（实测解压失败就是后者，退出码可能是 0）。
      // 所以除了看 code，还要看"是不是真装出来了"。
      void (async () => {
        const shellFound = (await findApp(installRoot)) !== null || (await findApp(installerDir)) !== null;
        if (code === 0 && shellFound) {
          installState.phase = 'done';
          installState.percent = 100;
          installState.label = '安装完成';
          installState.detail = '正在归位网关目录…';
          log.info('NapCat 安装器执行完成');
          // 安装器把 Shell 留在它的工作目录（installerDir）；搬进 installRoot 统一口径。
          // 失败不回滚——Shell 在哪都能手动用，status 会如实显示。
          await relocateShell();
          return;
        }
        installState.phase = 'failed';
        installState.percent = 0;
        installState.label = '安装失败';
        const why = code === 0 ? '安装器提前结束，没装出网关' : `安装器退出码 ${code}`;
        installState.error = `${why}（下载失败或磁盘/网络问题，可重试）`;
        log.warn(`NapCat 安装器失败：exit=${code} shellFound=${String(shellFound)}`);
        // 失败后立刻清掉这次跑坏的包，下一次「重试」才能真正重新下载，而不是拿着
        // 同一个截断文件再失败一次。删不掉也不该让失败状态变成异常。
        const purged = await purgeBrokenPackages();
        if (purged.length > 0) {
          installState.detail = `已自动清掉损坏的安装包（${purged.join('、')}），点「① 一键安装」重试会自动重新下载`;
        }
      })();
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
   * 清掉安装器工作目录里的坏包（实现见模块级的 {@link purgeBrokenPackages}）。
   * @returns {Promise<string[]>} 实际删掉的文件名（给状态栏提示用）
   */
  async function purgeBrokenPackages() {
    return purgeBrokenPackagesIn(installerDir, log);
  }

  /**
   * 预取网关包到安装器工作目录（实现与理由见模块级的 {@link prefetchShellZipIn}）。
   * @param {{size: number, sha256: string, tag: string, url: string}|null} asset 官方期望值
   * @returns {Promise<{ok: boolean, reused?: boolean, size?: number, reason?: string}>} 结果
   */
  async function prefetchShellZip(asset, onProgress) {
    return prefetchShellZipIn(installerDir, asset, log, onProgress);
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
      log.warn(
        `Shell 归位失败（不影响使用，只是位置不在 app/ 下）：${error instanceof Error ? error.message : String(error)}`,
      );
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
      // GitHub 的 digest 是 `sha256:<hex>`（实测），不是 base64。
      // 以前按 base64 解会得到一个长度不对的串，等于**校验永远对不上或永远不生效**——
      // 那正是残包能一路混进来的原因之一。认不出的形状就当没有期望值，只靠大小兜底。
      const expect = parseAssetDigest(asset.digest);
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

  return {
    status,
    unpack,
    autoInstall,
    writeConfig,
    launch,
    openWebuiWhenReady,
    webuiInfo,
    watchAccountLogin,
    stop,
    stopSync,
    wipe,
    wipeSync,
    fetchLatest,
    newToken,
  };
}
