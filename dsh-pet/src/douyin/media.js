/**
 * 媒体：目录扫描、ffmpeg/ffprobe 探测、竖版转码、封面截帧。
 *
 * 一条硬约束：**没有 ffmpeg 也要能用**。抖音发布页接受 mp4/mov，
 * 所以缺 ffmpeg 时降级为「原样使用源文件」，只在发布包里写明没转码——
 * 插件不该因为一个可选工具缺失就整条链路失败。
 *
 * @module dsh-pet-douyin/media
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { isFile, run } from './util.js';

/** 一次扫描最多看多少个目录项（防止误指到 C:\ 把宿主拖死） */
const MAX_SCAN_ENTRIES = 20_000;

/**
 * 扫描目录，按配置规则挑出「可以发」的视频。
 *
 * 只做「够不够格」的静态判断（扩展名/体积/关键词/是否发过），**不读视频头**——
 * 探测时长要起进程，只对最终选中的那一条做，扫描要快。
 * @param {object} source 配置里的 `source` 段
 * @param {(key: string) => boolean} hasSeen 去重判定
 * @returns {Promise<{items: Array<{path: string, name: string, ext: string, size: number, mtimeMs: number, dir: string}>, skipped: Record<string, number>, total: number, dirExists: boolean, error?: string}>} 扫描结果
 */
export async function listVideos(source, hasSeen) {
  const skipped = { ext: 0, size: 0, keyword: 0, seen: 0 };
  const dir = String(source.dir ?? '').trim();
  if (dir === '') return { items: [], skipped, total: 0, dirExists: false, error: '还没有设置待发目录' };

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: source.recursive === true });
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return {
      items: [],
      skipped,
      total: 0,
      dirExists: false,
      error: code === 'ENOENT' ? `目录不存在：${dir}` : `读不了目录：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const exts = new Set(source.extensions.map((e) => e.toLowerCase()));
  const includes = source.includeKeywords.map((k) => k.toLowerCase());
  const excludes = source.excludeKeywords.map((k) => k.toLowerCase());
  const minBytes = source.minSizeMB * 1024 * 1024;
  const items = [];
  let seenCount = 0;

  for (const entry of entries) {
    if (seenCount >= MAX_SCAN_ENTRIES) break;
    seenCount += 1;
    if (!entry.isFile()) continue;
    const name = entry.name;
    const ext = extname(name).toLowerCase();
    if (!exts.has(ext)) {
      skipped.ext += 1;
      continue;
    }
    const lower = name.toLowerCase();
    if (excludes.some((k) => lower.includes(k))) {
      skipped.keyword += 1;
      continue;
    }
    if (includes.length > 0 && !includes.some((k) => lower.includes(k))) {
      skipped.keyword += 1;
      continue;
    }
    // Node 22 的递归 readdir 会给 parentPath；非递归时退回源目录
    const parent = /** @type {{parentPath?: string}} */ (entry).parentPath ?? dir;
    const full = join(parent, name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.size < minBytes) {
      skipped.size += 1;
      continue;
    }
    const key = `${full}|${info.size}|${Math.floor(info.mtimeMs / 1000)}`;
    if (hasSeen(key)) {
      skipped.seen += 1;
      continue;
    }
    items.push({
      path: full,
      name: basename(name, extname(name)),
      ext,
      size: info.size,
      mtimeMs: info.mtimeMs,
      dir: basename(parent) || dir,
    });
  }

  const order = source.order;
  if (order === 'newest') items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  else if (order === 'random') items.sort(() => Math.random() - 0.5);
  else items.sort((a, b) => a.mtimeMs - b.mtimeMs);

  return { items, skipped, total: seenCount, dirExists: true };
}

/**
 * 定位 ffmpeg。按优先级：显式配置 → PATH。
 * 配置里给目录就找目录下的可执行文件，给文件就直接用；ffprobe 从同目录推。
 * @param {string} configured 配置里的 `transcode.ffmpegPath`
 * @returns {Promise<{ok: boolean, ffmpeg: string, ffprobe: string, version?: string, reason?: string}>} 定位结果
 */
export async function detectFfmpeg(configured) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  /** @type {string[]} */
  const candidates = [];
  const raw = String(configured ?? '').trim();
  if (raw !== '') {
    const lower = raw.toLowerCase();
    candidates.push(lower.endsWith(exe) || lower.endsWith('ffmpeg') ? raw : join(raw, `ffmpeg${exe}`));
  }
  candidates.push(`ffmpeg${exe}`);

  for (const candidate of candidates) {
    const probe = await run(candidate, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
    if (probe.code !== 0) continue;
    const version = /ffmpeg version (\S+)/.exec(probe.stdout)?.[1] ?? 'unknown';
    const ffprobe = join(dirname(candidate), `ffprobe${exe}`);
    const probeOk = (await run(ffprobe, ['-hide_banner', '-version'], { timeoutMs: 15_000 })).code === 0;
    return {
      ok: true,
      ffmpeg: candidate,
      ffprobe: probeOk ? ffprobe : '',
      version,
    };
  }
  return {
    ok: false,
    ffmpeg: '',
    ffprobe: '',
    reason: raw === '' ? 'PATH 里没有 ffmpeg' : `找不到可执行的 ffmpeg：${raw}`,
  };
}

/**
 * 读视频的时长与分辨率。ffprobe 不在时退回解析 `ffmpeg -i` 的 stderr。
 * @param {{ffmpeg: string, ffprobe: string}} bin 探测结果
 * @param {string} file 视频文件
 * @returns {Promise<{durationSec: number, width: number, height: number} | null>} 元数据；读不出返回 null
 */
export async function probeMedia(bin, file) {
  if (bin.ffprobe !== '') {
    const r = await run(
      bin.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
      { timeoutMs: 30_000 },
    );
    if (r.code === 0) {
      try {
        const j = JSON.parse(r.stdout);
        const stream = Array.isArray(j.streams) ? j.streams[0] : undefined;
        const durationSec = Number(j.format?.duration ?? stream?.duration ?? 0);
        const width = Number(stream?.width ?? 0);
        const height = Number(stream?.height ?? 0);
        if (Number.isFinite(durationSec)) return { durationSec, width, height };
      } catch {
        /* 落到 stderr 解析 */
      }
    }
  }
  if (bin.ffmpeg === '') return null;
  const r = await run(bin.ffmpeg, ['-hide_banner', '-i', file], { timeoutMs: 30_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const dur = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  const size = /,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(text);
  if (dur === null) return null;
  const durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  return {
    durationSec,
    width: size === null ? 0 : Number(size[1]),
    height: size === null ? 0 : Number(size[2]),
  };
}

/**
 * 拼 ffmpeg 的滤镜链。
 * - `pad`：等比缩到能放进画框，剩下的补黑边（不裁画面，适合口播/教学）
 * - `crop`：等比放大到填满画框，居中裁掉溢出（满屏观感，适合横屏转竖屏）
 * @param {object} transcode 配置里的 `transcode` 段
 * @returns {string} `-vf` 参数
 */
export function buildFilter(transcode) {
  const { width: w, height: h } = transcode;
  return transcode.fit === 'crop'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/**
 * 转成抖音友好的 mp4（H.264 + AAC + faststart）。
 * @param {{ffmpeg: string}} bin 探测结果
 * @param {object} transcode 配置里的 `transcode` 段
 * @param {string} input 源文件
 * @param {string} output 目标 mp4
 * @returns {Promise<{ok: boolean, reason?: string}>} 结果
 */
export async function transcode(bin, transcode, input, output) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', buildFilter(transcode)];
  args.push('-map', '0:v:0');
  if (transcode.audio === 'keep') args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  const kbps = Math.max(1000, Math.round(transcode.maxBitrateMbps * 1000));
  args.push(
    '-r',
    String(transcode.fps),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-maxrate',
    `${kbps}k`,
    '-bufsize',
    `${kbps * 2}k`,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  );
  const r = await run(bin.ffmpeg, args, { timeoutMs: 30 * 60_000 });
  if (r.code === 0 && (await isFile(output))) return { ok: true };
  return {
    ok: false,
    reason: (r.timedOut ? '转码超时（30 分钟）' : r.stderr.trim().split('\n').slice(-3).join(' ')) || `ffmpeg 退出码 ${r.code}`,
  };
}

/**
 * 截一帧当封面候选（抖音发布页也能自己选封面，这张只是省事）。
 * 失败不致命，返回 undefined 即可。
 * @param {{ffmpeg: string}} bin 探测结果
 * @param {string} input 视频文件
 * @param {string} output 封面 jpg
 * @param {number} [atSec] 截取位置（秒）
 * @returns {Promise<boolean>} 是否成功
 */
export async function grabCover(bin, input, output, atSec = 1) {
  const r = await run(
    bin.ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(atSec), '-i', input, '-frames:v', '1', '-q:v', '3', output],
    { timeoutMs: 60_000 },
  );
  return r.code === 0 && (await isFile(output));
}
