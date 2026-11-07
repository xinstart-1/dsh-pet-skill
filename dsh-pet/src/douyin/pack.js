/**
 * 发布包：挑一条片 → 转成竖版 → 写文案 → 落成一个人能直接用的文件夹。
 *
 * 为什么是「文件夹」而不是一段 JSON：半自动发布是人机接力，交接物必须能双击打开、
 * 双击播放、全选复制。所以一个包就是
 *
 * ```
 * packs/2026-10-26_0042__海边日落/
 * ├─ video.mp4      ← 上传这个
 * ├─ 文案.txt       ← 全选复制这个（内容已自动进剪贴板）
 * ├─ 说明.txt       ← 给人看的核对清单
 * ├─ 封面.jpg       ← 可选，发布页里能直接选
 * └─ meta.json      ← 给程序看的一份
 * ```
 *
 * @module dsh-pet-douyin/pack
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { composeCaption } from './caption.js';
import { dedupeKey } from './ledger.js';
import { detectFfmpeg, grabCover, listVideos, probeMedia, transcode } from './media.js';
import { copyToClipboard, dateKey, fmtDuration, isFile, openUrl, slugify, stamp } from './util.js';

/** 抖音单条视频时长上限（秒）：官方 15 分钟，配置默认 900 留了余量 */
export const DOUYIN_MAX_SEC = 900;

/**
 * 生成一个不会撞车的包目录名。
 * @param {string} packsDir 包根目录
 * @param {string} name 视频名（用于人眼识别）
 * @param {Date} now 时间点
 * @returns {Promise<string>} 目录名
 */
async function uniquePackId(packsDir, name, now) {
  const base = `${stamp(now)}__${slugify(name, 30) || 'video'}`;
  let id = base;
  for (let i = 2; i < 100; i += 1) {
    const exists = await stat(join(packsDir, id))
      .then(() => true)
      .catch(() => false);
    if (!exists) return id;
    id = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 说明.txt 的内容：一份照着做就不会错的核对清单。
 *
 * 这里不能有半句假话——比如没开自动复制就别写「已复制到剪贴板」，
 * 没有封面就别让人去选「封面.jpg」。半自动交接最怕的就是信任崩了。
 * @param {{pack: object, config: object, clipboard: {ok: boolean, reason?: string}, hasCover: boolean}} ctx 上下文
 * @returns {string} 文本
 */
function buildReadme(ctx) {
  const { pack, config, clipboard, hasCover } = ctx;
  const probed = pack.video.durationSec > 0;
  const spec = probed
    ? `${pack.video.width}×${pack.video.height} · ${fmtDuration(pack.video.durationSec)} · ${pack.video.transcoded ? '已转成 9:16' : '未转码，原样使用'}`
    : '读不出（没装 ffmpeg） · 未转码，原样使用';
  return [
    '抖音发布包',
    '',
    `生成时间：${new Date(pack.createdAt).toLocaleString('zh-CN')}`,
    `来源文件：${pack.source.path}`,
    `规格：${spec}`,
    `可见范围：${pack.caption.visibility}（发布页里手动选）`,
    `标题字数：${pack.caption.title.length}`,
    '',
    '下一步',
    clipboard.ok
      ? '1. 文案已复制到剪贴板，到发布页直接粘贴（要重抄就打开「文案.txt」，不要复制本文件）'
      : `1. 打开「文案.txt」全选复制（没自动复制：${clipboard.reason ?? '未开启'}）`,
    `2. 打开 ${config.pack.uploadPage}，上传 video.mp4`,
    hasCover ? '3. 粘贴描述；封面可以直接选同目录的「封面.jpg」' : '3. 粘贴描述；封面在发布页里手动挑',
    '4. 发完回设置页把这一条标成「已发布」，台账就不会再重复挑到它',
    '',
    ...(pack.warnings.length > 0 ? ['提醒', ...pack.warnings.map((w) => `· ${w}`), ''] : []),
  ].join('\n');
}

/**
 * 发布包工厂：持有「当前是否在准备中」的互斥状态，供定时器与手动入口共用。
 * @param {{getConfig: () => object, getPacksDir: () => string, ledger: object, log: object}} deps 依赖
 * @returns {{prepare: Function, busy: () => boolean, mark: Function, lastError: () => string|null}} 打包器
 */
export function createPacker({ getConfig, getPacksDir, ledger, log }) {
  let busy = false;
  /** @type {string|null} */
  let lastError = null;
  /** @type {{key: string, value: any}|null} */
  let ffmpegCache = null;

  /**
   * 带缓存的 ffmpeg 定位：同一份配置只探测一次。
   * @param {string} configured 配置里的路径
   * @returns {Promise<object>} 探测结果
   */
  const ffmpegOf = async (configured) => {
    if (ffmpegCache !== null && ffmpegCache.key === configured) return ffmpegCache.value;
    const bin = await detectFfmpeg(configured);
    ffmpegCache = { key: configured, value: bin };
    return bin;
  };

  /**
   * 准备一条发布包。
   * @param {{file?: string, reason?: string}} [opts] `file` 指定源文件（不给则按规则挑）
   * @returns {Promise<{ok: boolean, pack?: object, reason?: string, skipped?: boolean, detail?: string}>} 结果
   */
  async function prepare(opts = {}) {
    if (busy) return { ok: false, reason: '已经有一条在准备中' };
    busy = true;
    try {
      const config = getConfig();
      const now = new Date();
      const bin = await ffmpegOf(config.transcode.ffmpegPath);

      let target;
      if (typeof opts.file === 'string' && opts.file.trim() !== '') {
        const path = opts.file.trim();
        if (!(await isFile(path))) return { ok: false, reason: `文件不存在：${path}` };
        const info = await stat(path);
        target = {
          path,
          name: basename(path, extname(path)),
          ext: extname(path).toLowerCase(),
          size: info.size,
          mtimeMs: info.mtimeMs,
          dir: basename(dirname(path)),
        };
      } else {
        if (!config.source.dir) return { ok: false, reason: '还没有设置待发目录（设置页 → 素材）' };
        const scan = await listVideos(config.source, (key) => ledger.has(key));
        if (scan.error !== undefined) return { ok: false, reason: scan.error };
        target = scan.items[0];
        if (target === undefined) {
          return {
            ok: false,
            reason: `目录里没有可发的新视频（已发过 ${scan.skipped.seen} 条，关键词/体积过滤掉 ${scan.skipped.keyword + scan.skipped.size} 条）`,
          };
        }
      }

      const key = dedupeKey(target);
      if (ledger.has(key)) return { ok: false, reason: `这条已经准备过了：${target.name}` };

      const warnings = [];
      const meta = bin.ok ? await probeMedia(bin, target.path) : null;
      const durationSec = meta?.durationSec ?? 0;
      const durLimit = Math.min(config.source.maxDurationSec, DOUYIN_MAX_SEC);

      // 时长不合规：记一条 skipped 让它以后不再被挑中，而不是每次定时都重试
      if (durationSec > 0 && (durationSec < config.source.minDurationSec || durationSec > durLimit)) {
        const why =
          durationSec < config.source.minDurationSec
            ? `时长 ${fmtDuration(durationSec)} 短于下限 ${fmtDuration(config.source.minDurationSec)}`
            : `时长 ${fmtDuration(durationSec)} 超过上限 ${fmtDuration(durLimit)}`;
        await ledger.add({
          id: `skip_${Date.now()}`,
          key,
          source: target.path,
          sourceName: target.name,
          size: target.size,
          mtimeMs: target.mtimeMs,
          createdAt: Date.now(),
          status: 'skipped',
          packId: '',
          title: '',
          note: why,
        });
        log.warn(`跳过 ${target.name}：${why}`);
        return { ok: false, skipped: true, reason: why };
      }
      if (!bin.ok)
        warnings.push(`没找到 ffmpeg（${bin.reason}），已原样使用源文件；要转 9:16 请装 ffmpeg 并在设置里填路径`);

      const packsDir = getPacksDir();
      const packId = await uniquePackId(packsDir, target.name, now);
      const packDir = join(packsDir, packId);
      await mkdir(packDir, { recursive: true });

      // 视频：能转就转，转失败也不把整条链路打死——退回原文件并写明
      let videoFile;
      let transcoded = false;
      const wantTranscode = config.transcode.mode === 'vertical' && bin.ok;
      if (wantTranscode) {
        const out = join(packDir, 'video.mp4');
        const r = await transcode(bin, config.transcode, target.path, out);
        if (r.ok) {
          videoFile = out;
          transcoded = true;
        } else {
          warnings.push(`转码失败（${r.reason}），已改用原始文件`);
          log.warn(`转码失败：${target.name} → ${r.reason}`);
        }
      }
      if (videoFile === undefined) {
        videoFile = join(packDir, `video${target.ext}`);
        await copyFile(target.path, videoFile);
        if (config.transcode.mode === 'vertical') {
          warnings.push('这条没有转成 9:16，发布页会按源视频比例展示');
        }
      }
      if (config.pack.keepSourceCopy) {
        // 额外留一份原名副本，方便溯源（默认不留，省磁盘）
        const copy = join(packDir, `原始-${basename(target.path)}`);
        await copyFile(target.path, copy).catch(() => warnings.push('原始副本复制失败（不影响发布）'));
      }

      let coverOk = false;
      if (bin.ok) {
        coverOk = await grabCover(bin, target.path, join(packDir, '封面.jpg'));
        if (!coverOk) warnings.push('封面截帧失败，发布页里手动选封面即可');
      }

      const stats = ledger.stats(dateKey(now));
      const caption = composeCaption(config.caption, {
        name: target.name,
        mtime: new Date(target.mtimeMs),
        index: stats.todayCount + 1,
        total: stats.total + 1,
        durationSec,
        dir: target.dir,
      });
      warnings.push(...caption.warnings);

      const pack = {
        id: packId,
        packId,
        createdAt: now.getTime(),
        source: { path: target.path, name: target.name, size: target.size, mtimeMs: target.mtimeMs },
        video: {
          file: basename(videoFile),
          width: transcoded ? config.transcode.width : (meta?.width ?? 0),
          height: transcoded ? config.transcode.height : (meta?.height ?? 0),
          durationSec,
          transcoded,
          fit: transcoded ? config.transcode.fit : '',
        },
        caption: {
          title: caption.title,
          text: caption.text,
          tags: caption.tags,
          mention: caption.mention,
          visibility: caption.visibility,
        },
        status: 'packed',
        warnings,
        trigger: opts.reason ?? 'manual',
      };

      // 先复制再生文件：说明.txt 要如实写「复制成功没有」，顺序反了就只能猜
      const copied = config.pack.copyCaption
        ? await copyToClipboard(caption.text)
        : { ok: false, reason: '未开启自动复制' };
      if (config.pack.copyCaption && !copied.ok)
        warnings.push(`文案没能自动进剪贴板（${copied.reason}），手动打开「文案.txt」复制`);

      await writeFile(join(packDir, '文案.txt'), `${caption.text}\n`, 'utf8');
      await writeFile(join(packDir, 'meta.json'), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
      await writeFile(
        join(packDir, '说明.txt'),
        `${buildReadme({ pack, config, clipboard: copied, hasCover: coverOk })}\n`,
        'utf8',
      );

      await ledger.add({
        id: `pk_${now.getTime()}`,
        key,
        source: target.path,
        sourceName: target.name,
        size: target.size,
        mtimeMs: target.mtimeMs,
        createdAt: now.getTime(),
        status: 'packed',
        packId,
        title: caption.title,
        transcoded,
        warnings,
      });

      if (config.pack.openUploadPage) await openUrl(config.pack.uploadPage);

      log.info(`已备好发布包 ${packId}（${transcoded ? '已转 9:16' : '原样'}，${fmtDuration(durationSec)}）`);
      lastError = null;
      return { ok: true, pack: { ...pack, dir: packDir, clipboard: copied } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      log.error(`准备发布包失败：${message}`);
      return { ok: false, reason: message };
    } finally {
      busy = false;
    }
  }

  return {
    prepare,
    busy: () => busy,
    lastError: () => lastError,
    /**
     * 人工回填结局：已发布 / 作废。
     * @param {string} id 记录 id 或 packId
     * @param {'published'|'skipped'|'packed'} status 新状态
     * @returns {Promise<object|null>} 更新后的记录
     */
    async mark(id, status) {
      const entry = ledger.find(id) ?? ledger.list(500).find((e) => e.packId === id || e.id === `pk_${id}`) ?? null;
      if (entry === null) return null;
      return ledger.update(entry.id, { status });
    },
  };
}
