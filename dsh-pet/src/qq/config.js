/**
 * QQ 接管的配置：默认值、归一化、读写。
 *
 * 设计上的三条硬约定（都在默认值里体现）：
 * 1. **默认全关**：`enabled=false`、`chat.dryRun=true`。装完不改一行，一条消息都不会发出去；
 * 2. **默认只在明确允许的范围内回话**：白名单为空时，只有主人私聊会被回；
 * 3. **配置只描述"允许做什么"**，用量/审计这类**状态**在 store.js 里——改配置不该把账本清掉。
 *
 * @module dsh-pet-qq/config
 */

import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './util.js';

/** 路由前缀（尾号与宠物 7340、抖音 7341 错开） */
export const ROUTE_PREFIX = '/dsh-qq-7342';

/** 默认配置。改这里等于改新用户的初值。 */
export const DEFAULT_CONFIG = {
  /** 总开关：关掉后断开网关、不再连、也不再回任何消息 */
  enabled: false,

  /** 网关：任何 OneBot v11 实现。可用：NapCat（首选）/ LLBot（原 LLOneBot）/ SnowLuma；Lagrange.OneBot 已于 2025-10 归档，勿选 */
  gateway: {
    /** 正向 WebSocket 地址 */
    wsUrl: 'ws://127.0.0.1:3001',
    /** 访问令牌（拼到 `?access_token=`，因为浏览器规范不允许自定义 WS 头） */
    token: '',
    /** HTTP API 地址；留空 = 所有调用都走 WS */
    httpUrl: '',
    /** 断线重连的基础间隔（秒），连续失败会退避到 60 秒 */
    reconnectSec: 5,
  },

  /** 账号身份 */
  account: {
    /** 机器人 QQ 号；留空 = 连上后采用网关自报的号（只提示，不落盘） */
    selfId: '',
    /** 主人 QQ 号：这个人私聊必回，也是"能改设置"的唯一身份 */
    masterId: '',
  },

  /** 聊天行为 */
  chat: {
    /** 试运行：照常生成回复、写审计，但**不发送**。装完先跑这个 */
    dryRun: true,
    /** 私聊自动回复 */
    privateEnabled: true,
    /** 群聊只在被 @ 时回（false = 群里任何消息都不回，仍然只监听） */
    groupAtOnly: true,
    /** 主人私聊无条件回（不受白名单约束，但仍受频率与静默时段约束） */
    masterAlwaysReply: true,
    /** 允许自动回复的号：私聊填 QQ 号，群聊填群号。空 = 谁都不回（主人除外） */
    allowlist: [],
    /** 永不回复的号（QQ 号或群号） */
    blocklist: [],
    /** 熟人名单：`QQ号 | 关系 | 备注`，拼进 system 的身份声明（不是人设） */
    knownPeers: [],
    /** 群里叫这些名字也算在叫它（两个字符以上才生效；空 = 只认 @） */
    mentionNames: [],
    /** 群聊回复时引用原消息，读起来像人在接话 */
    quoteInGroup: true,
    /** 长回复拆成多条短句（QQ 里长段落很假） */
    splitReply: true,
    /** 每轮带几轮上下文（0 = 不带，最容易被人设带偏的就是这个） */
    historyTurns: 6,
    /** 回复前随机等待区间（毫秒）：秒回很像机器人 */
    delayMs: [1200, 3000],
    /** 同一个会话每小时最多回几条 */
    maxPerHourPerPeer: 20,
    /** 每天总共最多回几条 */
    maxPerDay: 200,
    /** 同一个会话两条回复之间至少隔几秒 */
    minGapSec: 10,
    /** 静默时段 `23:30-08:00`（空 = 不设）。主人私聊也不回 */
    quietHours: '',
  },

  /** 记录 */
  behavior: {
    /** 写审计（谁、哪个会话、成没成） */
    recordAudit: true,
    /** 每轮把收到的消息也记一条（排障用，含少量正文） */
    logMessages: true,
  },

  /** 桌宠联动 */
  pet: {
    /** 在桌宠气泡里播报"回了谁" */
    bubble: true,
    /** 复用桌宠工作状态槽（正在想回复） */
    workStatus: false,
  },
};

/**
 * 数据目录。**刻意不复用抖音的目录**：两套账号、两套账本，混在一起排查时最费时间。
 * @param {string} home `$DSH_HOME`
 * @returns {string} 目录
 */
export const dataDir = (home) => join(home, 'dsh-pet-qq');

/**
 * 各类文件路径。
 * @param {string} dir 数据目录
 * @returns {{dir: string, configFile: string, stateFile: string, logFile: string}} 路径
 */
export function pathsFor(dir) {
  return {
    dir,
    configFile: join(dir, 'config.json'),
    stateFile: join(dir, 'state.json'),
    logFile: join(dir, 'qq.log'),
  };
}

/** 数值夹紧 */
const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** 字符串数组：剔空、去重、限长 */
const strList = (v, fallback = []) => {
  const src = Array.isArray(v) ? v : fallback;
  const out = [];
  for (const item of src) {
    const s = String(item ?? '').trim();
    if (s !== '' && !out.includes(s)) out.push(s);
  }
  return out;
};

/** 号码数组：只留数字字符串（QQ 号与群号都是纯数字） */
const idList = (v) => strList(v).filter((s) => /^\d{4,12}$/.test(s));

/**
 * 归一化配置：坏值回落默认、数值夹紧、数组去重。
 *
 * 这里是**唯一**把用户输入变成可信配置的地方——路由、设置页、文件读入都过它，
 * 所以下游不需要再防御 `null` / 字符串数字 / 缺字段。
 * @param {any} raw 原始输入
 * @returns {object} 成品配置
 */
export function normalizeConfig(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const g = src.gateway !== null && typeof src.gateway === 'object' ? src.gateway : {};
  const a = src.account !== null && typeof src.account === 'object' ? src.account : {};
  const c = src.chat !== null && typeof src.chat === 'object' ? src.chat : {};
  const b = src.behavior !== null && typeof src.behavior === 'object' ? src.behavior : {};
  const p = src.pet !== null && typeof src.pet === 'object' ? src.pet : {};
  const D = DEFAULT_CONFIG;

  const wsRaw = String(g.wsUrl ?? D.gateway.wsUrl).trim();
  const wsUrl = /^wss?:\/\/\S+$/i.test(wsRaw) ? wsRaw : D.gateway.wsUrl;
  const httpRaw = String(g.httpUrl ?? '').trim();
  const httpUrl = httpRaw === '' ? '' : /^https?:\/\/\S+$/i.test(httpRaw) ? httpRaw.replace(/\/+$/, '') : '';

  const delay = Array.isArray(c.delayMs) ? c.delayMs : D.chat.delayMs;
  const delayMs = [clamp(delay[0], 0, 60_000, D.chat.delayMs[0]), clamp(delay[1], 0, 60_000, D.chat.delayMs[1])];

  const quietRaw = String(c.quietHours ?? '').trim();
  const quietHours = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(quietRaw) ? quietRaw : '';

  return {
    enabled: src.enabled === true,
    gateway: {
      wsUrl,
      token: String(g.token ?? '').trim(),
      httpUrl,
      reconnectSec: clamp(g.reconnectSec, 1, 300, D.gateway.reconnectSec),
    },
    account: {
      selfId: String(a.selfId ?? '').trim(),
      masterId: String(a.masterId ?? '').trim(),
    },
    chat: {
      dryRun: c.dryRun !== false,
      privateEnabled: c.privateEnabled !== false,
      groupAtOnly: c.groupAtOnly !== false,
      masterAlwaysReply: c.masterAlwaysReply !== false,
      allowlist: idList(c.allowlist),
      blocklist: idList(c.blocklist),
      knownPeers: strList(c.knownPeers),
      mentionNames: strList(c.mentionNames),
      quoteInGroup: c.quoteInGroup !== false,
      splitReply: c.splitReply !== false,
      historyTurns: clamp(c.historyTurns, 0, 40, D.chat.historyTurns),
      delayMs,
      maxPerHourPerPeer: clamp(c.maxPerHourPerPeer, 1, 500, D.chat.maxPerHourPerPeer),
      maxPerDay: clamp(c.maxPerDay, 1, 5000, D.chat.maxPerDay),
      minGapSec: clamp(c.minGapSec, 0, 3600, D.chat.minGapSec),
      quietHours,
    },
    behavior: {
      recordAudit: b.recordAudit !== false,
      logMessages: b.logMessages !== false,
    },
    pet: {
      bubble: p.bubble !== false,
      workStatus: p.workStatus === true,
    },
  };
}

/**
 * 读配置。文件不存在返回默认值（新用户第一次打开设置页看到的就是它）。
 * @param {{configFile: string}} paths 路径
 * @returns {Promise<{config: object, exists: boolean, warnings: string[]}>} 结果
 */
export async function loadConfig(paths) {
  const raw = await readJson(paths.configFile, null);
  if (raw === null) return { config: normalizeConfig(DEFAULT_CONFIG), exists: false, warnings: [] };
  const warnings = [];
  if (typeof raw !== 'object') warnings.push('config.json 不是对象，已按默认值重建');
  return { config: normalizeConfig(raw), exists: true, warnings };
}

/**
 * 保存配置（原子写）。
 * @param {{configFile: string}} paths 路径
 * @param {any} config 成品配置
 * @returns {Promise<void>} 完成
 */
export async function saveConfig(paths, config) {
  await writeJsonAtomic(paths.configFile, config);
}
