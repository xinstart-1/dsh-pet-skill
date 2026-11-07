/**
 * 配置：默认值、归一化、读写。
 *
 * 一个插件只有**一份**配置，分六块：
 * - `app`        抖音开放平台应用凭据（扫码授权用）
 * - `source` / `transcode` / `caption` / `pack` / `schedule`  发布包那一半（本地文件管线）
 * - `behavior`   账号侧调优（拉取条数、缓存、限速、审计、自主）
 * - `dm` / `share`  话术模板
 * - `pet`        桌宠联动（气泡、工作状态、右键菜单文案）
 *
 * 账号 token、授牌、审计、用量属于**状态**，在 store.js 里——改配置不该丢 token。
 *
 * @module dsh-pet-douyin/config
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expandPath, readJson, writeJsonAtomic } from './util.js';

/** 默认配置。改这里等于改新用户的初值。 */
export const DEFAULT_CONFIG = {
  /** 总开关：关掉后定时器空转、菜单点击只提示「已关闭」 */
  enabled: true,

  /** 抖音开放平台「网站应用」凭据 */
  app: {
    clientKey: '',
    /** 只存在本机；不回传设置页（留空 = 不改动） */
    clientSecret: '',
    /** 抖音要求回调域是后台配置过的域名；留空也能用（扫码后粘 code） */
    redirectUri: '',
    scopes: ['user_info', 'video.list', 'video.data'],
    authorizeBase: 'https://open.douyin.com/platform/oauth/connect/',
    apiBase: 'https://open.douyin.com',
  },

  /** 发布包：素材来源 */
  source: {
    dir: '',
    recursive: true,
    extensions: ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv'],
    includeKeywords: [],
    excludeKeywords: ['temp', '草稿', 'draft'],
    minSizeMB: 0.5,
    minDurationSec: 3,
    maxDurationSec: 900,
    order: 'oldest',
  },

  /** 发布包：转码 */
  transcode: {
    mode: 'vertical',
    width: 1080,
    height: 1920,
    fit: 'pad',
    fps: 30,
    maxBitrateMbps: 8,
    audio: 'keep',
    ffmpegPath: '',
  },

  /** 发布包：文案模板 */
  caption: {
    titleTemplate: '{name}',
    descTemplate: '',
    tags: ['#桌宠日常'],
    mention: [],
    visibility: 'public',
    extraLines: [],
  },

  /** 发布包：节奏 */
  schedule: {
    mode: 'manual',
    intervalMinutes: 180,
    dailyTimes: ['12:00', '20:00'],
    windows: ['09:00-23:30'],
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    maxPerDay: 3,
    minGapMinutes: 60,
  },

  /** 发布包：产出与交接 */
  pack: {
    outDir: '',
    openUploadPage: true,
    uploadPage: 'https://creator.douyin.com/creator-micro/content/upload',
    copyCaption: true,
    keepSourceCopy: false,
  },

  /** 账号侧调优 */
  behavior: {
    browseCount: 10,
    cacheSec: 60,
    throttleMs: 600,
    recordAudit: true,
    /** 允许宠物按自己的计划跑「浏览」（只读，永不发送） */
    autonomyEnabled: false,
    autonomyWindow: ['09:00-23:00'],
    autonomyIntervalMin: 120,
    /** 刷推荐流一次刷多少条（1–50）。刷多了没意义，气泡也只报前 3 条 */
    feedLimit: 10,
    /** 刷完怎么"分享"：notify=播报给主人 / copy=复制分享文案 / dm=发给指定昵称 */
    feedShareMode: 'notify',
    /** 刷完给当前那条视频抓几帧给模型看（0 = 不看，只读文案）。截图不下载视频，成本很低 */
    feedLookFrames: 3,
  },

  /** 私信草稿话术 */
  dm: {
    greeting: '在的，什么事？',
    tone: '朋友间随口聊',
    signature: '',
  },

  /** 分享卡文案 */
  share: {
    template: '{title}\n{url}',
    copyOnShare: true,
  },

  /** 网页通道：复用"已扫码登录的那个浏览器"（读、导航；发送仅在 allowAutoSend 开着时做且带回执校验） */
  web: {
    enabled: true,
    port: 9333,
    /** 允许插件替你按下发送。默认关；关着的时候只写草稿 */
    allowAutoSend: false,
    /** 专用浏览器可执行文件：Ego Lite 是 Chromium（156），CDP 直接可用 */
    browserPath: 'C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe',
    /** 连不上 CDP 端口时自动拉起专用浏览器（带独立 profile，登录态互不干扰） */
    autoLaunch: true,
    /** 监听界面：chat=专用消息页（douyin.com/chat）；panel=消息侧栏面板（任意抖音页都能开，不用专门挂聊天页） */
    surface: 'chat',
    /** 自动回复轮询发现浏览器离线时自动拉起（持续接管场景开这个，机器人自愈在线） */
    autoWake: true,
    /** 专用浏览器 profile 目录（空=默认 $DSH_HOME/dsh-pet-douyin-web/profile）。
     *  换浏览器（如 Edge）时建议配独立目录：不同 Chromium 系浏览器混用同一 profile
     *  会互相改写偏好文件，且加密 cookie 不通用（切换需重新扫码登录）。 */
    profileDir: '',
    /** 自动回复：后台监听当前打开的会话，新入站消息由大模型现写一条回复（无模板兜底） */
    autoReply: false,
    /** 自动回复轮询间隔（秒） */
    autoReplyPollSec: 30,
    /** 群聊也自动回复。注意：实测（2026-10-28）电脑端（网页/官方桌面客户端）发出的群消息
     *  其他成员（App 端）收不到——平台投递策略，与输入方式无关。关掉 = 仅单聊自动回复。 */
    replyGroups: true,
    /** fork 版 dsh-pet 的设置页已内嵌抖音卡时置 true：自带分区让位，避免设置页出现两个「抖音」 */
    petForkCard: false,
    /** 熟人名单：一行一条 `会话名 | 关系 | 备注`（关系、备注可省；关系写「主人」/「owner」即标记主人）。
     *  只用来拼一句「现在在跟谁说话」的身份声明，**不是人设**——人设真源仍在宠物设置页。
     *  空 = 一句都不加（行为与加这个功能之前完全一致）。 */
    knownPeers: [],
    /** 网页发布：填完标题/话题后是否直接点「发布」。
     *  默认关 = 停在发布按钮前等人点最后一下。发布不可撤销（视频一出去就是公开内容），
     *  而上传/转码/封面/权限是多步表单，中途任何一步错都该让人看一眼再决定。 */
    autoPublish: false,
  },

  /** 桌宠联动 */
  pet: {
    bubble: true,
    workStatus: true,
    animOnStart: '',
    animOnDone: '',
    menuFeed: '刷会儿抖音',
    menuPublish: '做个发布包',
    menuChat: '跟抖音说句话',
    menuSettings: '抖音设置',
  },
};

/** 字段清单：路径 → 类型。归一化、校验、UI 表单结构都由它派生。 */
const FIELDS = {
  enabled: { t: 'bool', d: true },

  'app.clientKey': { t: 'string', d: '' },
  'app.clientSecret': { t: 'string', d: '' },
  'app.redirectUri': { t: 'string', d: '' },
  'app.scopes': { t: 'str[]', d: DEFAULT_CONFIG.app.scopes },
  'app.authorizeBase': { t: 'string', d: DEFAULT_CONFIG.app.authorizeBase },
  'app.apiBase': { t: 'string', d: DEFAULT_CONFIG.app.apiBase },

  'source.dir': { t: 'path', d: '' },
  'source.recursive': { t: 'bool', d: true },
  'source.extensions': { t: 'ext[]', d: DEFAULT_CONFIG.source.extensions },
  'source.includeKeywords': { t: 'str[]', d: [] },
  'source.excludeKeywords': { t: 'str[]', d: DEFAULT_CONFIG.source.excludeKeywords },
  'source.minSizeMB': { t: 'num', d: 0.5, min: 0, max: 10_000 },
  'source.minDurationSec': { t: 'int', d: 3, min: 0, max: 86_400 },
  'source.maxDurationSec': { t: 'int', d: 900, min: 1, max: 86_400 },
  'source.order': { t: 'enum', d: 'oldest', values: ['oldest', 'newest', 'random'] },

  'transcode.mode': { t: 'enum', d: 'vertical', values: ['vertical', 'none'] },
  'transcode.width': { t: 'int', d: 1080, min: 240, max: 3840 },
  'transcode.height': { t: 'int', d: 1920, min: 240, max: 3840 },
  'transcode.fit': { t: 'enum', d: 'pad', values: ['pad', 'crop'] },
  'transcode.fps': { t: 'int', d: 30, min: 12, max: 120 },
  'transcode.maxBitrateMbps': { t: 'num', d: 8, min: 1, max: 100 },
  'transcode.audio': { t: 'enum', d: 'keep', values: ['keep', 'mute'] },
  'transcode.ffmpegPath': { t: 'path', d: '' },

  'caption.titleTemplate': { t: 'string', d: '{name}' },
  'caption.descTemplate': { t: 'string', d: '' },
  'caption.tags': { t: 'tag[]', d: DEFAULT_CONFIG.caption.tags },
  'caption.mention': { t: 'at[]', d: [] },
  'caption.visibility': { t: 'enum', d: 'public', values: ['public', 'friends', 'private'] },
  'caption.extraLines': { t: 'str[]', d: [] },

  'schedule.mode': { t: 'enum', d: 'manual', values: ['manual', 'interval', 'daily'] },
  'schedule.intervalMinutes': { t: 'int', d: 180, min: 5, max: 20_160 },
  'schedule.dailyTimes': { t: 'hhmm[]', d: DEFAULT_CONFIG.schedule.dailyTimes },
  'schedule.windows': { t: 'range[]', d: DEFAULT_CONFIG.schedule.windows },
  'schedule.weekdays': { t: 'weekday[]', d: DEFAULT_CONFIG.schedule.weekdays },
  'schedule.maxPerDay': { t: 'int', d: 3, min: 1, max: 100 },
  'schedule.minGapMinutes': { t: 'int', d: 60, min: 0, max: 10_080 },

  'pack.outDir': { t: 'path', d: '' },
  'pack.openUploadPage': { t: 'bool', d: true },
  'pack.uploadPage': { t: 'string', d: DEFAULT_CONFIG.pack.uploadPage },
  'pack.copyCaption': { t: 'bool', d: true },
  'pack.keepSourceCopy': { t: 'bool', d: false },

  'behavior.browseCount': { t: 'int', d: 10, min: 1, max: 20 },
  'behavior.cacheSec': { t: 'int', d: 60, min: 0, max: 3600 },
  'behavior.throttleMs': { t: 'int', d: 600, min: 0, max: 10_000 },
  'behavior.recordAudit': { t: 'bool', d: true },
  'behavior.autonomyEnabled': { t: 'bool', d: false },
  'behavior.autonomyWindow': { t: 'range[]', d: DEFAULT_CONFIG.behavior.autonomyWindow },
  'behavior.autonomyIntervalMin': { t: 'int', d: 120, min: 10, max: 1440 },
  'behavior.feedLimit': { t: 'int', d: 10, min: 1, max: 50 },
  'behavior.feedShareMode': { t: 'enum', d: 'notify', values: ['notify', 'copy', 'dm'] },
  'behavior.feedLookFrames': { t: 'int', d: 3, min: 0, max: 6 },

  'dm.greeting': { t: 'string', d: DEFAULT_CONFIG.dm.greeting },
  'dm.tone': { t: 'string', d: DEFAULT_CONFIG.dm.tone },
  'dm.signature': { t: 'string', d: '' },

  'share.template': { t: 'string', d: DEFAULT_CONFIG.share.template },
  'share.copyOnShare': { t: 'bool', d: true },

  'pet.bubble': { t: 'bool', d: true },
  'pet.workStatus': { t: 'bool', d: true },
  'pet.animOnStart': { t: 'string', d: '' },
  'pet.animOnDone': { t: 'string', d: '' },
  'pet.menuFeed': { t: 'string', d: DEFAULT_CONFIG.pet.menuFeed },
  'pet.menuPublish': { t: 'string', d: DEFAULT_CONFIG.pet.menuPublish },
  'pet.menuChat': { t: 'string', d: DEFAULT_CONFIG.pet.menuChat },
  'pet.menuSettings': { t: 'string', d: DEFAULT_CONFIG.pet.menuSettings },
  'web.enabled': { t: 'bool', d: true },
  'web.port': { t: 'int', d: 9333, min: 1024, max: 65535 },
  'web.allowAutoSend': { t: 'bool', d: false },
  'web.browserPath': { t: 'path', d: DEFAULT_CONFIG.web.browserPath },
  'web.autoLaunch': { t: 'bool', d: true },
  'web.surface': { t: 'enum', d: 'chat', values: ['chat', 'panel'] },
  'web.autoWake': { t: 'bool', d: true },
  'web.profileDir': { t: 'path', d: '' },
  'web.autoReply': { t: 'bool', d: false },
  'web.autoReplyPollSec': { t: 'int', d: 30, min: 10, max: 600 },
  'web.replyGroups': { t: 'bool', d: true },
  'web.petForkCard': { t: 'bool', d: false },
  'web.knownPeers': { t: 'str[]', d: [] },
  'web.autoPublish': { t: 'bool', d: false },
};

/** @type {string[]} 可配置键路径（UI 用同一份） */
export const CONFIG_KEYS = Object.keys(FIELDS);

/** `HH:MM` 正则（00:00–23:59） */
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** `HH:MM-HH:MM` 正则 */
const RANGE_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * 按点号路径取值。
 * @param {any} obj 对象
 * @param {string} path 点号路径
 * @returns {any} 值
 */
export function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * 按点号路径写值（中间层不存在则建对象）。
 * @param {any} obj 目标对象
 * @param {string} path 点号路径
 * @param {any} value 值
 * @returns {void}
 */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (cur[key] === null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * 单字段归一化：类型对了就用，不对回落默认，并说清楚为什么。
 *
 * 告警只在**真的丢了信息**时才出：话题补 `#`、扩展名补点、数字夹到区间
 * 都是预期内的规整，不该让用户以为自己写错了。
 * @param {{t: string, d: any, min?: number, max?: number, values?: string[]}} field 声明
 * @param {any} raw 用户给的值
 * @returns {{value: any, warn?: string}} 结果
 */
function normalizeField(field, raw) {
  const def = Array.isArray(field.d) ? [...field.d] : field.d;
  const fb = (warn) => ({ value: def, warn });
  if (raw === undefined || raw === null) return { value: def };

  switch (field.t) {
    case 'bool':
      return typeof raw === 'boolean' ? { value: raw } : fb('应当是 true / false，已用默认值');
    case 'string':
      return typeof raw === 'string' ? { value: raw } : fb('应当是文本，已用默认值');
    case 'path':
      return typeof raw === 'string' ? { value: expandPath(raw) } : fb('应当是路径文本，已用默认值');
    case 'int':
    case 'num': {
      const loose =
        typeof raw === 'number'
          ? raw
          : field.t === 'int'
            ? Number.parseInt(String(raw), 10)
            : Number.parseFloat(String(raw));
      if (!Number.isFinite(loose)) return fb('不是有效数字，已用默认值');
      const lo = Number.isFinite(field.min) ? /** @type {number} */ (field.min) : Number.NEGATIVE_INFINITY;
      const hi = Number.isFinite(field.max) ? /** @type {number} */ (field.max) : Number.POSITIVE_INFINITY;
      const exact = field.t === 'int' ? Math.round(loose) : loose;
      const value = Math.min(hi, Math.max(lo, exact));
      return value === exact ? { value } : { value, warn: `超出 ${lo}–${hi}，已夹到 ${value}` };
    }
    case 'enum':
      return Array.isArray(field.values) && field.values.includes(raw)
        ? { value: raw }
        : fb(`只能是 ${(field.values ?? []).join(' / ')}，已用默认值`);
    case 'str[]': {
      if (!Array.isArray(raw)) return fb('应当是数组，已用默认值');
      const value = Array.from(
        new Set(raw.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())),
      );
      return raw.length > 0 && value.length === 0 ? fb('没有有效项，已用默认值') : { value };
    }
    case 'ext[]': {
      if (!Array.isArray(raw)) return fb('应当是数组，已用默认值');
      const value = Array.from(
        new Set(
          raw
            .filter((v) => typeof v === 'string' && v.trim() !== '')
            .map((v) => `.${v.trim().toLowerCase().replace(/^\.+/, '')}`)
            .filter((v) => /^\.[a-z0-9]{1,8}$/.test(v)),
        ),
      );
      return raw.length > 0 && value.length === 0 ? fb('没有合法扩展名，已用默认值') : { value };
    }
    case 'tag[]': {
      if (!Array.isArray(raw)) return fb('应当是数组，已用默认值');
      const value = raw
        .filter((v) => typeof v === 'string')
        .map((v) => `#${v.trim().replace(/^#+/, '')}`)
        .filter((v) => v !== '#');
      return raw.length > 0 && value.length === 0 ? fb('没有有效话题，已用默认值') : { value };
    }
    case 'at[]': {
      if (!Array.isArray(raw)) return fb('应当是数组，已用默认值');
      const value = raw
        .filter((v) => typeof v === 'string')
        .map((v) => `@${v.trim().replace(/^@+/, '')}`)
        .filter((v) => v !== '@');
      return raw.length > 0 && value.length === 0 ? fb('没有有效 @，已用默认值') : { value };
    }
    case 'hhmm[]': {
      if (!Array.isArray(raw)) return fb('应当是数组，已用默认值');
      const value = Array.from(
        new Set(raw.filter((v) => typeof v === 'string' && HHMM_RE.test(v.trim())).map((v) => v.trim())),
      ).sort();
      return raw.length > 0 && value.length === 0 ? fb('没有合法 HH:MM，已用默认值') : { value };
    }
    case 'range[]': {
      if (!Array.isArray(raw)) return fb('应当是数组，已用默认值');
      const value = raw.filter((v) => typeof v === 'string' && RANGE_RE.test(v.trim())).map((v) => v.trim());
      return raw.length > 0 && value.length === 0 ? fb('没有合法时段，已用默认值') : { value };
    }
    case 'weekday[]': {
      if (!Array.isArray(raw)) return fb('应当是数组，已用默认值');
      const days = raw
        .map((v) => (typeof v === 'number' ? v : Number.parseInt(String(v), 10)))
        .filter((v) => Number.isInteger(v) && v >= 1 && v <= 7);
      const value = Array.from(new Set(days)).sort((a, b) => a - b);
      return raw.length > 0 && value.length === 0 ? fb('星期只能是 1–7，已用默认值') : { value };
    }
    default:
      return { value: def };
  }
}

/**
 * 归一化整份配置：逐字段过一遍，输出永远完整、类型永远正确。
 * @param {any} raw 用户配置（可残缺、可损坏）
 * @returns {{config: typeof DEFAULT_CONFIG, warnings: string[]}} 成品与告警
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const config = structuredClone(DEFAULT_CONFIG);
  const warnings = [];
  for (const [path, field] of Object.entries(FIELDS)) {
    const keys = path.split('.');
    let cur = input;
    let present = true;
    for (const key of keys) {
      if (cur === null || typeof cur !== 'object' || !(key in cur)) {
        present = false;
        break;
      }
      cur = cur[key];
    }
    if (!present) continue; // 没写就保持默认
    const { value, warn } = normalizeField(field, cur);
    if (warn !== undefined) warnings.push(`${path}：${warn}`);
    setPath(config, path, value);
  }
  if (config.source.minDurationSec > config.source.maxDurationSec) {
    const { minDurationSec, maxDurationSec } = config.source;
    config.source.minDurationSec = maxDurationSec;
    config.source.maxDurationSec = minDurationSec;
    warnings.push('source.minDurationSec 大于 maxDurationSec，已自动交换');
  }
  if (!/^https:\/\//i.test(config.app.authorizeBase)) {
    config.app.authorizeBase = DEFAULT_CONFIG.app.authorizeBase;
    warnings.push('app.authorizeBase 必须是 https，已用默认值');
  }
  if (!/^https:\/\//i.test(config.app.apiBase)) {
    config.app.apiBase = DEFAULT_CONFIG.app.apiBase;
    warnings.push('app.apiBase 必须是 https，已用默认值');
  }
  return { config, warnings };
}

/**
 * 落盘位置：一个插件一个目录，配置与状态同处。
 * @param {string} dir 本插件用户目录
 * @returns {{dir: string, configFile: string, accountsFile: string, grantsFile: string, auditFile: string, usageFile: string, ledgerFile: string, packsDir: string, logFile: string}} 路径集合
 */
export function pathsFor(dir) {
  return {
    dir,
    configFile: join(dir, 'config.json'),
    accountsFile: join(dir, 'accounts.json'),
    grantsFile: join(dir, 'grants.json'),
    auditFile: join(dir, 'audit.json'),
    usageFile: join(dir, 'usage.json'),
    ledgerFile: join(dir, 'ledger.json'),
    packsDir: join(dir, 'packs'),
    logFile: join(dir, 'logs.txt'),
  };
}

/**
 * 读配置并归一化。文件不存在 = 全默认（不落盘，等用户第一次保存）。
 * @param {{configFile: string}} paths 路径集合
 * @returns {Promise<{config: typeof DEFAULT_CONFIG, warnings: string[], exists: boolean, raw: any}>} 结果
 */
export async function loadConfig(paths) {
  const raw = await readJson(paths.configFile, undefined);
  const { config, warnings } = normalizeConfig(raw ?? {});
  return { config, warnings, exists: raw !== undefined, raw: raw ?? {} };
}

/**
 * 保存配置：先归一化再原子写，返回成品配置。
 * @param {{configFile: string, dir: string}} paths 路径集合
 * @param {any} patch 用户提交的配置
 * @returns {Promise<{config: typeof DEFAULT_CONFIG, warnings: string[]}>} 结果
 */
export async function saveConfig(paths, patch) {
  // 深合并到磁盘上的现状，**不是**以默认值起底。
  // 这里踩过坑：normalizeConfig 从 DEFAULT_CONFIG 出发，只覆盖 patch 里出现的字段，
  // 于是「只改 scope」这种部分保存会把其余设置全部打回默认——静默丢配置。
  const current = await loadConfig(paths);
  const merged = deepMerge(current.raw, patch ?? {});
  const { config, warnings } = normalizeConfig(merged);
  await mkdir(paths.dir, { recursive: true });
  await writeJsonAtomic(paths.configFile, config);
  return { config, warnings };
}

/**
 * 深合并：对象递归，数组整体替换（数组做逐项合并只会制造幽灵元素）。
 * @param {any} base 现状
 * @param {any} patch 补丁
 * @returns {any} 合并结果
 */
function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out = base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

/**
 * 应用凭据是否够生成授权链接。
 * @param {typeof DEFAULT_CONFIG} config 配置
 * @returns {{ready: boolean, missing: string[]}} 判定
 */
export function appReadiness(config) {
  const missing = [];
  if (config.app.clientKey.trim() === '') missing.push('Client Key');
  if (config.app.clientSecret.trim() === '') missing.push('Client Secret');
  return { ready: missing.length === 0, missing };
}

/** 星期英文缩写 → 中文（只用于人话描述） */
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 把星期数字列表渲染成人话。
 * @param {number[]} days 1–7
 * @returns {string} 描述
 */
export function describeWeekdays(days) {
  if (days.length === 7) return '每天';
  return days.map((d) => WEEKDAY_NAMES[d - 1] ?? String(d)).join('、');
}
