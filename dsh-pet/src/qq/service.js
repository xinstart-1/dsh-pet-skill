/**
 * 服务门面：把"接上 QQ"这件事装配成一个对象。
 *
 * 组装顺序（也是读代码的顺序）：
 * 事件进来 → `policy.decide` 判要不要回 → 同会话串行排队 → 等一会儿 → **再判一次**
 * → 借人设 + 拼身份/场景 → 宿主 LLM 生成 → 拆条 → 发送 → 记账 + 审计 + 播报。
 *
 * 三条刻意的设计：
 * 1. **同会话串行、不同会话并行**：同一个人连发三条时，回复要按顺序、不能互相踩；
 *    但两个人的消息不该互相等——群里刷屏时串行会把回复拖到几十秒后。
 * 2. **发送前复查**：等的那几秒里配置可能被改了（比如用户刚打开试运行）、额度也可能
 *    被别的会话用掉。所以闸门在两个时点各查一次，**不做"判一次管到底"**。
 * 3. **失败不重试**：发送失败只记账。重试可能造成同一条消息发两遍——那比不回更糟。
 *
 * @module dsh-pet-qq/service
 */
import { createPetBridge } from '../douyin/pet-bridge.js';
import { dataDir, loadConfig, normalizeConfig, pathsFor, saveConfig } from './config.js';
import { buildUserPrompt } from './llm.js';
import { mentionsName } from './message.js';
import { createOneBot } from './onebot.js';
import { createPersonaSource } from './persona.js';
import { describeSender, peerLabel, scenePrompt } from './people.js';
import { decide } from './policy.js';
import { createStore } from './store.js';
import { randomDelay, sleep, splitReply } from './util.js';

/** 只挂一只宠物的人设（与抖音一致：全局单例链路，没有"这条消息归哪只宠物"的概念） */
const MAIN_PET = 'main';

/** 日志里截断长文本 */
const clip = (s, n = 60) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 深合并（只处理纯对象；数组与标量直接覆盖） */
function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base?.[k] !== null &&
      typeof base?.[k] === 'object' &&
      !Array.isArray(base[k])
    ) {
      out[k] = mergeDeep(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 建服务。`init()` 之前读到的都是默认值（路由必须在 init 之后注册）。
 * @param {{home: string, log: object, getPort: () => number, now?: () => number}} deps 依赖
 * @returns {object} 服务
 */
export function createService({ home, log, getPort, now = () => Date.now() }) {
  const paths = pathsFor(dataDir(home));
  const store = createStore({ paths, log, now });
  const bot = createOneBot({ log, now });
  const pet = createPetBridge({ getPort, log });

  /** @type {any} */
  let config = normalizeConfig({});
  let configExists = false;
  let warnings = [];
  /** 宿主 LLM 适配器；null = 宿主没这服务 → 一律不发 */
  let hostLlm = null;
  let personaProvider = null;
  /** 人设取值器：注入 provider 后整个换掉（不能只改 provider 变量——老闭包会一直用旧实现） */
  let personaSource = createPersonaSource({ provider: null, getPort, log, now });
  let started = false;

  /** 每个会话最近几条往来（重启即清——QQ 是事件驱动，不存在"翻旧账回一遍"的问题） */
  const history = new Map();
  /** 每个会话的串行队列 */
  const queues = new Map();
  let lastBotStatus = bot.status();

  const stats = {
    inbound: 0,
    replied: 0,
    skipped: 0,
    failed: 0,
    dryRun: 0,
    lastEventAt: 0,
    lastPeer: '',
    lastText: '',
    lastReply: '',
    connectedAt: 0,
  };

  /** 会话键：私聊/群聊分开算（同一个号在私聊和群里是两段对话） */
  const keyOf = (ev) => `${ev.kind}:${ev.peerId}`;

  /**
   * 取上下文（最近 N 轮）。
   * @param {any} ev 消息
   * @returns {Array<{role: string, content: string}>} 历史
   */
  function historyOf(ev) {
    const turns = Number(config.chat.historyTurns) || 0;
    if (turns <= 0) return [];
    const list = history.get(keyOf(ev)) ?? [];
    return list.slice(-turns * 2);
  }

  /** 记一轮（用户说 + 我们回），超出上限就裁掉最老的 */
  function remember(ev, userText, replyText) {
    const turns = Math.max(1, Number(config.chat.historyTurns) || 1);
    const list = history.get(keyOf(ev)) ?? [];
    list.push({ role: 'user', content: String(userText ?? '') });
    list.push({ role: 'assistant', content: String(replyText ?? '') });
    while (list.length > turns * 2) list.shift();
    history.set(keyOf(ev), list);
  }

  /** 现在该不该回（把 usage / @ / 名字都算进去） */
  function decideNow(ev, selfId) {
    const mention = ev.atMe === true || mentionsName(ev.text, config.chat.mentionNames);
    return decide({
      event: ev,
      config,
      selfId,
      usage: store.usageOf(ev.peerId, now()),
      mention,
      now: now(),
    });
  }

  /** 写审计（开关关着就跳过，但日志照写） */
  function audit(entry) {
    if (config.behavior.recordAudit) store.audit(entry);
  }

  /**
   * 拼一条消息的 OneBot 消息段：群里默认带引用，读起来像人在接话。
   * @param {any} ev 消息
   * @param {string} text 正文
   * @returns {Array<object>} 消息段
   */
  function segmentsFor(ev, text) {
    const segs = [];
    if (ev.kind === 'group' && config.chat.quoteInGroup) {
      const mid = String(ev.id).replace(/^group-/, '');
      if (/^\d+$/.test(mid)) segs.push({ type: 'reply', data: { id: mid } });
    }
    segs.push({ type: 'text', data: { text } });
    return segs;
  }

  /** 在一次真实回复结束后收尾（清工作状态） */
  function endWorkStatus() {
    if (config.pet.workStatus) void pet.clearWorkStatus();
  }

  /**
   * 真正的回复链路。
   * @param {any} ev 消息
   * @returns {Promise<void>} 完成
   */
  async function reply(ev) {
    const wait = randomDelay(config.chat.delayMs);
    if (config.pet.workStatus) void pet.workStatus('thinking', `回 ${ev.senderName}`);
    if (wait > 0) await sleep(wait);

    // 复查①：等的时候总开关/白名单/额度都可能变了
    const v = bot.verifySelf(config.account.selfId);
    if (v.ok !== true) {
      stats.skipped += 1;
      log.warn(`放弃回复 ${peerLabel(ev)}：${v.reason}`);
      endWorkStatus();
      return;
    }
    const again = decideNow(ev, v.selfId);
    if (again.reply !== true) {
      stats.skipped += 1;
      log.info(`放弃回复 ${peerLabel(ev)}：${again.reason}`);
      endWorkStatus();
      return;
    }

    const system = [
      await personaSource(MAIN_PET),
      describeSender({ event: ev, masterId: config.account.masterId, lines: config.chat.knownPeers }),
      scenePrompt(ev.kind),
    ]
      .filter((part) => part !== '')
      .join('\n\n');

    if (hostLlm === null) {
      stats.failed += 1;
      audit({ action: 'reply', ok: false, peer: peerLabel(ev), detail: '宿主未提供 llm 服务' });
      log.warn('宿主没有 llm 服务，QQ 不会回话');
      endWorkStatus();
      return;
    }

    const gen = await hostLlm.generate({
      system,
      user: buildUserPrompt(ev),
      history: historyOf(ev),
      timeoutMs: 30_000,
    });
    if (gen.ok !== true) {
      stats.failed += 1;
      audit({ action: 'reply', ok: false, peer: peerLabel(ev), detail: `未生成：${gen.reason ?? '未知原因'}` });
      log.warn(`未生成正文，不发（${gen.reason ?? '未知原因'}）`);
      endWorkStatus();
      return;
    }

    const parts = config.chat.splitReply ? splitReply(gen.text) : [gen.text];
    const joined = parts.join(' ');

    // 试运行：生成照走、账照记，就是不点发送。第一次接网关必须先跑这个
    if (config.chat.dryRun) {
      stats.dryRun += 1;
      audit({ action: 'reply', ok: true, peer: peerLabel(ev), detail: `[试运行] ${clip(joined, 120)}` });
      log.info(`试运行（未发送）→ ${peerLabel(ev)}：${clip(joined)}`);
      stats.lastReply = joined;
      if (config.pet.bubble)
        void pet.broadcast(`（试运行）会回 ${ev.senderName}：${clip(joined, 40)}`, { pet: MAIN_PET });
      endWorkStatus();
      return;
    }

    if (!bot.isOnline()) {
      stats.failed += 1;
      audit({ action: 'reply', ok: false, peer: peerLabel(ev), detail: '网关不在线' });
      log.warn(`网关不在线，${peerLabel(ev)} 这条没发出去`);
      endWorkStatus();
      return;
    }

    let sentParts = 0;
    for (const part of parts) {
      try {
        await bot.send({ kind: ev.kind, peerId: ev.peerId, message: segmentsFor(ev, part) });
        sentParts += 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        stats.failed += 1;
        audit({ action: 'reply', ok: false, peer: peerLabel(ev), detail: `发送失败：${msg}` });
        log.warn(`发送失败 ${peerLabel(ev)}：${msg}`);
        break;
      }
      if (parts.length > 1) await sleep(400 + Math.floor(Math.random() * 600));
    }
    if (sentParts === 0) {
      endWorkStatus();
      return;
    }

    store.recordUse(ev.peerId, now());
    stats.replied += 1;
    stats.lastReply = joined;
    remember(ev, ev.text, joined);
    audit({
      action: 'reply',
      ok: true,
      peer: peerLabel(ev),
      detail: `${sentParts > 1 ? `${sentParts} 条 · ` : ''}${clip(joined, 120)}`,
    });
    log.info(`已回复 ${peerLabel(ev)}：${clip(joined)}`);
    if (config.pet.bubble) void pet.broadcast(`回了 ${ev.senderName}：${clip(joined, 40)}`, { pet: MAIN_PET });
    endWorkStatus();
  }

  /** 同会话串行、跨会话并行 */
  function enqueue(ev) {
    const key = keyOf(ev);
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => reply(ev))
      .catch((error) => log.warn(`回复链路出错：${error instanceof Error ? error.message : String(error)}`));
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  }

  /** 收到一条消息 */
  function onEvent(ev) {
    stats.inbound += 1;
    stats.lastEventAt = now();
    stats.lastPeer = peerLabel(ev);
    stats.lastText = clip(ev.text, 120);
    if (config.behavior.logMessages) log.info(`收到 ${peerLabel(ev)}：${clip(ev.text)}`);

    const v = bot.verifySelf(config.account.selfId);
    if (v.ok !== true) {
      stats.skipped += 1;
      audit({ action: 'skip', ok: false, peer: peerLabel(ev), detail: v.reason });
      return;
    }

    const verdict = decideNow(ev, v.selfId);
    if (verdict.reply !== true) {
      stats.skipped += 1;
      // 「自己发的」是每条都会出现的高频事件，不值得占日志
      if (verdict.reason !== '自己发的' && config.behavior.logMessages) {
        log.info(`跳过 ${peerLabel(ev)}：${verdict.reason}`);
      }
      return;
    }
    enqueue(ev);
  }

  /** 起连接（按当前配置） */
  function connect() {
    started = true;
    stats.connectedAt = now();
    bot.open({
      wsUrl: config.gateway.wsUrl,
      token: config.gateway.token,
      httpUrl: config.gateway.httpUrl,
      reconnectSec: config.gateway.reconnectSec,
      onEvent,
      onStatus: (s) => {
        lastBotStatus = s;
        if (s.ok === true && s.identity === 'ok') {
          const v = bot.verifySelf(config.account.selfId);
          if (!v.ok) log.warn(`机器人号核对失败：${v.reason}`);
          else log.info(`QQ 在线：${s.nickname || '（无昵称）'}（${s.selfId}）`);
        }
      },
    });
  }

  /** 断连接 */
  function disconnect() {
    started = false;
    bot.close();
    lastBotStatus = bot.status();
  }

  const service = {
    paths,
    store,
    pet,

    /** 首次加载：读配置、读账本（迁移类动作要放在读之前，这里没有） */
    async init() {
      const loaded = await loadConfig(paths);
      config = loaded.config;
      configExists = loaded.exists;
      warnings = loaded.warnings;
      await store.load();
      log.info(`QQ 配置：${configExists ? paths.configFile : '（还没有，用默认值）'}`);
      return { config, exists: configExists, warnings };
    },

    getConfig() {
      return config;
    },

    /** 配置元信息（设置页据此提示"还没保存过"） */
    configMeta() {
      return { exists: configExists, warnings: [...warnings], file: paths.configFile };
    },

    /**
     * 合并保存配置。
     *
     * `gateway.token` 留空 = **不改动**（与抖音的 clientSecret 同一约定）：
     * 设置页从服务端读到的 token 是 `''`，用户不回填就不该被清空。
     * @param {any} patch 局部配置
     * @returns {Promise<{ok: boolean, reason?: string, restarted: boolean}>} 结果
     */
    async saveConfig(patch) {
      const body = patch !== null && typeof patch === 'object' ? { ...patch } : {};
      if (body.gateway !== null && typeof body.gateway === 'object') {
        const token = body.gateway.token;
        body.gateway = { ...body.gateway };
        if (token === undefined || token === '') delete body.gateway.token;
      }
      const prev = config;
      const next = normalizeConfig(mergeDeep(prev, body));
      try {
        await saveConfig(paths, next);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error), restarted: false };
      }
      config = next;
      configExists = true;
      warnings = [];

      const gatewayChanged = JSON.stringify(prev.gateway) !== JSON.stringify(next.gateway);
      const turnedOff = prev.enabled === true && next.enabled !== true;
      let restarted = false;
      if (turnedOff) {
        // 只有"用户刚把它关掉"才断连；总开关一直关着时的手动连接不该被一次保存踢掉
        if (started) {
          disconnect();
          restarted = true;
        }
      } else if (next.enabled === true && (!started || gatewayChanged)) {
        connect();
        restarted = true;
      }
      log.info(`配置已保存${restarted ? '（已按新配置重连）' : ''}`);
      return { ok: true, restarted };
    },

    /**
     * 总开关。
     * @param {boolean} enabled 开/关
     * @returns {Promise<object>} 结果
     */
    async toggle(enabled) {
      return service.saveConfig({ enabled: enabled === true });
    },

    /** 手动连接（不看总开关——设置页要能在关着的时候先试通）。 */
    connect() {
      connect();
      return { ok: true, status: bot.status() };
    },

    /** 手动断开。 */
    disconnect() {
      disconnect();
      return { ok: true, status: bot.status() };
    },

    /**
     * 连上没连上、登录的是不是那个号。
     * @returns {Promise<object>} 结果
     */
    async test() {
      if (!bot.isOnline()) {
        return { ok: false, reason: '还没连上网关（先点「连接」，或看下面的状态）', status: bot.status() };
      }
      try {
        const info = await bot.call('get_login_info', {}, 8000);
        const v = bot.verifySelf(config.account.selfId);
        return {
          ok: v.ok === true,
          reason: v.ok === true ? '' : v.reason,
          selfId: String(info?.user_id ?? v.selfId ?? ''),
          nickname: String(info?.nickname ?? v.nickname ?? ''),
          status: bot.status(),
        };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error), status: bot.status() };
      }
    },

    /**
     * 手动发一条（设置页/命令触发的人工路径，**不受白名单与试运行约束**，但仍要连着网关）。
     * @param {{to: string, kind?: 'private'|'group', text: string}} args 参数
     * @returns {Promise<{ok: boolean, reason?: string, parts?: string[]}>} 结果
     */
    async say({ to, kind = 'private', text }) {
      const target = String(to ?? '').trim();
      const body = String(text ?? '').trim();
      if (target === '') return { ok: false, reason: '没填收件人 QQ / 群号' };
      if (body === '') return { ok: false, reason: '没填要发的内容' };
      if (!bot.isOnline()) return { ok: false, reason: '网关未连接' };
      const parts = config.chat.splitReply ? splitReply(body) : [body];
      try {
        for (const part of parts) {
          await bot.send({
            kind: kind === 'group' ? 'group' : 'private',
            peerId: target,
            message: [{ type: 'text', data: { text: part } }],
          });
          if (parts.length > 1) await sleep(300);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        audit({ action: 'manual-say', ok: false, peer: `${kind}:${target}`, detail: reason });
        return { ok: false, reason };
      }
      audit({ action: 'manual-say', ok: true, peer: `${kind}:${target}`, detail: clip(body, 120) });
      log.info(`手动发送 → ${kind}:${target}：${clip(body)}`);
      return { ok: true, parts };
    },

    /** 给设置页/命令的总状态 */
    state() {
      const status = bot.status();
      lastBotStatus = status;
      return {
        enabled: config.enabled,
        started,
        bot: status || lastBotStatus,
        stats: { ...stats },
        usage: store.summary(),
        configFile: paths.configFile,
        hasToken: config.gateway.token !== '',
        hostLlm: hostLlm !== null,
        persona: personaProvider !== null ? 'in-process' : 'http-fallback',
      };
    },

    /** 配置副本（**抹掉 token**，只留 hasToken） */
    publicConfig() {
      const copy = JSON.parse(JSON.stringify(config));
      copy.gateway.token = '';
      return copy;
    },

    /** 当前用的模型（设置页显示"回复是谁写的"） */
    async modelLabel() {
      if (hostLlm === null) return '宿主未提供 llm';
      try {
        return await hostLlm.modelLabel();
      } catch {
        return '未知';
      }
    },

    /** 最近日志。 */
    logs(limit = 120) {
      return log.list().slice(0, Math.max(1, Math.min(500, Number(limit) || 120)));
    },

    /** 最近审计。 */
    audit(limit = 60) {
      return store.auditList(limit);
    },

    /** 挂宿主 LLM（入口注入） */
    setHostLlm(adapter) {
      hostLlm = adapter ?? null;
    },

    /** 挂人设来源（入口注入；null = 走 HTTP 兜底） */
    setPersonaProvider(fn) {
      personaProvider = typeof fn === 'function' ? fn : null;
      personaSource = createPersonaSource({ provider: personaProvider, getPort, log, now });
    },

    /** 取人设（设置页/命令想看"现在用的人设是什么"时用） */
    personaOf(petId = MAIN_PET) {
      return personaSource(petId);
    },

    /** 起停：`init()` 之后调一次 */
    async start() {
      if (config.enabled !== true) {
        log.info('QQ 总开关关着，不连接网关（设置页里可以单独点「连接」试一下）');
        return { connected: false, reason: 'disabled' };
      }
      connect();
      return { connected: true };
    },

    /** 停：断连、落盘 */
    async stop() {
      disconnect();
      await store.flush();
    },
  };

  return service;
}
