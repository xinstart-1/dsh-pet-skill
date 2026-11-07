/**
 * 通用工具：路径推导、JSON 读写、子进程、剪贴板、打开外链、日志。
 *
 * 本模块只用 node: 内置能力，不依赖 DSH 的任何运行时包——插件在 DSH 宿主里跑，
 * 也可以被单测直接 import（`node --test`），两条路必须都通。
 *
 * @module dsh-pet-douyin/util
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 用户数据根：与 DSH 的推导保持一致（`$DSH_HOME` → 默认 `~/.dsh`）。
 * dsh-pet 的 helper-process.ts 用的是同一行逻辑，这里刻意不 import 那个包，
 * 免得第三方扩展多出一条 peer 依赖。
 * @returns {string} DSH 用户数据根目录
 */
export function dshHome() {
  const env = process.env.DSH_HOME;
  return env !== undefined && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh');
}

/** 本插件在用户数据根下的目录名（与包名一致，便于排障时一眼对上）。 */
export const PLUGIN_ID = 'dsh-pet-douyin';

/**
 * 本插件的用户目录。
 * @param {string} [home] 覆盖 `$DSH_HOME`（单测用）
 * @returns {string} 绝对路径
 */
export function pluginDir(home) {
  return join(home ?? dshHome(), PLUGIN_ID);
}

/**
 * 展开路径里的 `~` 与 `%VAR%`，并去掉首尾空白。
 * Windows 用户习惯从资源管理器复制 `D:\videos`，不需要他们手动改成斜杠。
 * @param {string} input 原始路径
 * @returns {string} 展开后的路径（空输入返回空串）
 */
export function expandPath(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return '';
  let out = raw;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(homedir(), out.slice(1));
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m);
  return out;
}

/**
 * 读 JSON 文件；不存在或解析失败时返回兜底值（不抛）。
 * @param {string} file 绝对路径
 * @param {any} fallback 兜底值
 * @returns {Promise<any>} 解析结果或兜底值
 */
export async function readJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename，避免进程被杀时留下半份配置。
 * @param {string} file 目标绝对路径
 * @param {any} value 可 JSON 序列化的值
 * @returns {Promise<void>} 写入完成
 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/**
 * 文件名安全化：去掉路径分隔符、控制字符与 Windows 保留字符。
 * 发布包目录名要能从资源管理器直接双击进去，所以不能留 `:`、`?`、`*` 之类。
 * @param {string} input 原始字符串
 * @param {number} [max] 最长字符数
 * @returns {string} 安全化结果（可能为空串）
 */
export function slugify(input, max = 40) {
  const cleaned = String(input ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sliced = cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned;
  return sliced.replace(/[. ]+$/, '');
}

/**
 * 发布包目录用的时间戳：`YYYY-MM-DD_HHmm`。
 * 同时出现在目录名与排序里，必须是本地时间且零填充。
 * @param {Date} [d] 时间点，默认现在
 * @returns {string} 形如 `2026-10-26_0042`
 */
export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 本地日期键：`YYYY-MM-DD`（按本地时区，跨日统计靠它）。
 * @param {Date} [d] 时间点，默认现在
 * @returns {string} 日期键
 */
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 秒数格式化为 `mm:ss`（超过一小时给 `h:mm:ss`）。
 * @param {number} sec 秒
 * @returns {string} 时长文本
 */
export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '00:00';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/**
 * 跑一个外部命令并收口输出（不抛，一切异常都落在返回值里）。
 * 超时会 SIGKILL，避免 ffmpeg 卡死把宿主定时器拖住。
 * @param {string} cmd 可执行文件
 * @param {string[]} args 参数数组
 * @param {{input?: string, timeoutMs?: number, cwd?: string, maxBytes?: number, env?: NodeJS.ProcessEnv}} [opts] 选项
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut?: boolean, error?: Error}>} 执行结果
 */
export function run(cmd, args, opts = {}) {
  const { input, timeoutMs = 10 * 60_000, cwd, maxBytes = 1 << 20, env } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), error });
      return;
    }
    const out = [];
    const err = [];
    let bytes = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出：忽略 */
      }
      finish({ code: -2, stdout: Buffer.concat(out).toString(), stderr: 'timeout', timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (buf) => {
      bytes += buf.length;
      if (bytes <= maxBytes) out.push(buf);
    });
    child.stderr?.on('data', (buf) => {
      bytes += buf.length;
      if (bytes <= maxBytes) err.push(buf);
    });
    child.on('error', (error) => finish({ code: -1, stdout: '', stderr: String(error), error }));
    child.on('close', (code) =>
      finish({ code: code ?? -1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }),
    );
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* 子进程不读 stdin 时会 EPIPE：不是失败 */
      });
      child.stdin.end(input ?? '');
    }
  });
}

/**
 * 把文本放进系统剪贴板（尽力而为，失败只记日志）。
 *
 * 三个平台各一套：
 * - Windows：优先 PowerShell 的 `Set-Clipboard`，文本走 base64 传参避开控制台代码页乱码；
 *   没有 PowerShell 才退回 `clip`（中文可能乱码，但至少能粘）。
 * - macOS：`pbcopy`。
 * - Linux：`wl-copy` → `xclip` → `xsel`，谁在 PATH 里用谁。
 * @param {string} text 要复制的文本
 * @returns {Promise<{ok: boolean, via?: string, reason?: string}>} 结果
 */
export async function copyToClipboard(text) {
  const value = String(text ?? '');
  if (value === '') return { ok: false, reason: '文本为空' };
  if (process.platform === 'win32') {
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    const script =
      'Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' + `'${b64}'` + ')))';
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: 15_000,
    });
    if (ps.code === 0) return { ok: true, via: 'Set-Clipboard' };
    const clip = await run('clip.exe', [], { input: value, timeoutMs: 15_000 });
    if (clip.code === 0) return { ok: true, via: 'clip' };
    return { ok: false, reason: (ps.stderr || clip.stderr || 'clip 调用失败').trim().slice(0, 200) };
  }
  if (process.platform === 'darwin') {
    const r = await run('pbcopy', [], { input: value, timeoutMs: 15_000 });
    return r.code === 0 ? { ok: true, via: 'pbcopy' } : { ok: false, reason: r.stderr.trim().slice(0, 200) };
  }
  for (const [bin, args] of [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ]) {
    const r = await run(bin, args, { input: value, timeoutMs: 15_000 });
    if (r.code === 0) return { ok: true, via: bin };
  }
  return { ok: false, reason: '未找到 wl-copy / xclip / xsel' };
}

/**
 * 允许 `openUrl` 打开的协议。自定义 scheme 只放抖音 App 这一个——
 * 这里一旦放开，插件就变成了「能被诱导打开任意本地程序」的入口。
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'snssdk1128:']);

/**
 * 取协议，取不到返回空串。
 * @param {string} url 地址
 * @returns {string} 形如 `https:`
 */
function schemeOf(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/**
 * 本机有没有抖音客户端。
 *
 * 只在 Windows 上猜（查常见安装目录）；其他平台一律返回 true，交给系统决定。
 * 这个判断存在的理由：`start "" snssdk1128://` 在没装客户端时不报错——
 * spawn 成功 ≠ 打开了，所以只能靠"装没装"来选入口，否则永远在骗调用方。
 * @returns {Promise<boolean>} 是否装了
 */
export async function douyinAppInstalled() {
  if (process.platform !== 'win32') return true;
  const guesses = [
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Douyin'),
    join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Douyin'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Douyin'),
    join(homedir(), 'AppData', 'Local', 'Douyin'),
    join(homedir(), 'AppData', 'Roaming', 'Douyin'),
  ];
  for (const dir of guesses) {
    if (await isDir(dir)) return true;
  }
  return false;
}

/**
 * 用系统默认浏览器打开一个地址（detached，不等浏览器退出）。
 * @param {string} url http/https，或白名单内的 App scheme
 * @returns {Promise<{ok: boolean, reason?: string}>} 结果
 */
export async function openUrl(url) {
  const text = String(url ?? '').trim();
  // 协议白名单：http/https 之外只放行抖音 App 的 scheme。
  // 之前这里写的是 `/^https?:/`，于是 `snssdk1128://` 永远返回「只支持 http/https」——
  // 私信里的「唤起 App」是一整条死代码，实测才发现。
  if (!ALLOWED_SCHEMES.has(schemeOf(text))) {
    return { ok: false, reason: `不允许的协议（只放行 http / https / snssdk1128）` };
  }
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* 打不开就只是打不开：调用方另有兜底（页面里给可点的链接） */
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/**
 * 用系统文件管理器打开一个目录/文件。
 * @param {string} target 绝对路径
 * @returns {{ok: boolean, reason?: string}} 结果
 */
export function openPath(target) {
  const path = String(target ?? '').trim();
  if (path === '') return { ok: false, reason: '路径为空' };
  const [cmd, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [path]]
      : process.platform === 'darwin'
        ? ['open', [path]]
        : ['xdg-open', [path]];
  try {
    const child = spawn(cmd, args, { windowsHide: false, detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* explorer 打不开目录时会返回非零，这里只能静默 */
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/**
 * 文件是否存在且是普通文件。
 * @param {string} file 绝对路径
 * @returns {Promise<boolean>} 是否存在
 */
export async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * 目录是否存在。
 * @param {string} dir 绝对路径
 * @returns {Promise<boolean>} 是否存在
 */
export async function isDir(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 文件大小（字节）；不存在返回 0。
 * @param {string} file 绝对路径
 * @returns {Promise<number>} 字节数
 */
export async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * 环形日志：内存里保留最近若干条给设置页读，同时追加到文件供排障。
 * 桌面版 DSH 没有控制台，只写 stdout 等于把线索丢掉——文件是唯一留存的证据。
 * @param {{file: string, capacity?: number, onWrite?: (line: string) => void}} opts 选项
 * @returns {{info: Function, warn: Function, error: Function, list: () => Array<object>, file: string}} 日志器
 */
export function createLog({ file, capacity = 300 }) {
  const ring = [];
  let fileBroken = false;
  const write = (level, msg) => {
    const text = String(msg ?? '');
    const entry = { t: Date.now(), level, msg: text };
    ring.push(entry);
    if (ring.length > capacity) ring.shift();
    const line = `[${new Date(entry.t).toISOString()}] ${level.toUpperCase()} ${text}\n`;
    if (!fileBroken) {
      void appendFile(file, line, 'utf8').catch(() => {
        fileBroken = true; // 目录不可写时别每条都失败一次
      });
    }
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(`[dsh-pet-douyin] ${text}`);
  };
  return {
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
    list: () => ring.slice().reverse(),
    file,
  };
}
