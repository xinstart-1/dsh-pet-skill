/**
 * 服务门面：一个插件里装配两件事——
 * **账号**（OAuth、token、授牌、配额、审计）与**发布包**（扫目录、转码、出包、台账、节奏）。
 *
 * 为什么能装在一起：两者共用同一份配置、同一个桌宠桥、同一个 HTTP 端口，
 * 而且「出站」本来也该是一种可授予宠物的权力（`publish`）。
 *
 * 一条铁律：**所有宠物发起的调用都走 capabilities 的授牌闸门**；
 * 设置页里的人工操作（扫描、手动出包）走 service 自己的路径，不受授牌约束——
 * 授牌管的是"宠物能干什么"，不是"你能不能干什么"。
 *
 * @module dsh-pet-douyin/service
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CAPS, CAP_LABEL, createStore, dateKey } from './store.js';
import { appReadiness, describeWeekdays, loadConfig, pathsFor, saveConfig } from './config.js';
import { SCOPE_OF, buildAuthorizeUrl, createDouyinClient, extractCode, hasScope } from './douyin-client.js';
import { createCapabilities, dmSendSupported } from './capabilities.js';
import { createLedger } from './ledger.js';
import { createPacker } from './pack.js';
import { createPetBridge } from './pet-bridge.js';
import { decideAutonomy } from './policy.js';
import { describeClaim, intentExamples, parseIntent } from './intent.js';
import { createWebChan } from './webchan.js';
import { newIncoming } from './reply.js';
import { describePeer } from './peers.js';
import { digestOf, shareTextOf, topByLikes } from './feed.js';
import { buildChatMessages } from './llm.js';
import { ROUTE_PREFIX } from './router.js';
import { decideRun, estimateNextRun, markRun } from './schedule.js';
import { copyToClipboard, openUrl, pluginDir, readJson } from './util.js';

/** access_token 提前多久当作过期（毫秒）：留一分钟给网络抖动 */
const TOKEN_SKEW_MS = 60_000;

/**
 * 建服务。`init()` 之前只能读默认值，路由必须在 init 之后注册。
 * @param {{home: string, log: object, getPort: () => number, fetchImpl?: typeof fetch, copy?: Function, mock?: boolean, now?: () => number}} deps 依赖
 * @returns {object} 服务
 */
export function createService({ home, log, getPort, fetchImpl, copy = copyToClipboard, open = openUrl, mock = false, now = () => Date.now() }) {
  const dir = pluginDir(home);
  const paths = pathsFor(dir);
  const store = createStore({ paths, log });
  const client = createDouyinClient({ fetchImpl, now });
  const ledger = createLedger({ file: paths.ledgerFile, log });
  const pet = createPetBridge({ getPort, log });

  /** @type {any} */
  let config;
  let configWarnings = [];
  let configExists = false;
  let stopMenu = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let publishTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let autonomyTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let autoReplyTimer = null;
  /** 宿主能力探测器（入口注入，临时诊断用） */
  let probeRunner = null;
  /** 自动回复的在跑标记（上一轮没完就不叠一轮） */
  let autoBusy = false;
  /** 每个会话已见过的入站消息（内存即可：重启后第一条只入快照不回复，防翻旧账） */
  const autoSeen = {};
  /** 每只宠物上次自主跑的时间（内存即可：重启后靠每日配额兜底） */
  const lastAutonomyAt = {};
  let lastTick = { at: 0, reason: '尚未检查' };
  /** @type {object|null} */
  let lastPack = null;
  /** @type {{key: string, value: object}|null} */
  let ffmpegCache = null;

  /**
   * 发布包输出目录（配置为空时用默认位置）。
   * @returns {string} 目录
   */
  const packsDir = () => (config.pack.outDir.trim() === '' ? paths.packsDir : config.pack.outDir);

  const packer = createPacker({
    getConfig: () => service.getConfig(),
    getPacksDir: packsDir,
    ledger,
    log,
  });

  /** 网页通道：只读 + 导航，永不点击。浏览器没开时所有方法都返回 ok:false */
  const web = createWebChan({ getConfig: () => service.getConfig(), log, home });

  /** 宿主 LLM（入口注入；null = 宿主没提供 llm 服务） */
  let hostLlm = null;
  /** 附件服务（看图要存成附件，模型收的是引用）；宿主没有就 null → 退回只读文案 */
  let attachments = null;  /** 宿主递来的人设取用函数（进程内直取）；null = 宿主没给，走 HTTP 兜底 */
  let personaProvider = null;

  /** 上一次网页通道探测结果（同步给命令用的缓存；探测本身是异步的） */
  let lastWebStatus = null;

  /**
   * 宠物人格缓存（**只在兜底那条路上用**）：人格真源在 pet，这里只借用、不存第二份。
   * 正常情况走宿主递来的 `personaProvider`（进程内直取，改完人设下一句就生效，没有缓存窗口）。
   */
  let personaCache = { at: 0, key: '', system: '' };
  /** 兜底路径的缓存有效期：拿不到 provider 时，最多 5 分钟后的回复会用上新人设 */
  const PERSONA_TTL_MS = 5 * 60 * 1000;
  /** 借不到时的退避：1 分钟内不再试，别让每条自动回复都白等 2.5 秒 */
  const PERSONA_RETRY_MS = 60 * 1000;

  /**
   * 取当前宠物的人设（**唯一入口**：所有要过模型的场景都走这里）。
   *
   * 顺序：宿主递过来的 `personaProvider`（进程内直取，同一拼装点、无缓存）
   * → 兜底 `GET /dsh-pet-7340/persona`（宿主没递时的老路，带缓存）。
   *
   * **为什么不自己备一份默认人格**：宠物没写人设就是"没有人格"，这时只保留场景约束
   * （"在抖音私信里替主人回一句话…"）。自己编一个"抖音AI助手"出来，等于同一个人有两套性格，
   * 用户在宠物设置页改了人设也管不到这边。
   *
   * @param {string} petId 宠物 id
   * @returns {Promise<string>} pet 拼好的 system（拿不到返回空串）
   */
  async function petPersonaOf(petId) {
    const key = String(petId ?? '').trim() || 'main';
    if (personaProvider !== null) {
      try {
        return String((await personaProvider(key)) ?? '');
      } catch (error) {
        log.warn(`向宠物借人设失败（${key}）：${error instanceof Error ? error.message : String(error)}`);
        return '';
      }
    }
    const at = now();
    if (personaCache.key === key && at - personaCache.at < PERSONA_TTL_MS) return personaCache.system;

    const port = Number(getPort?.() ?? 0) || 0;
    if (port <= 0) return '';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/persona?pet=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body?.ok !== true) throw new Error(String(body?.reason ?? 'bad-shape'));
      const system = typeof body.system === 'string' ? body.system : '';
      personaCache = { at, key, system };
      return system;
    } catch (error) {
      log.warn(`向宠物借人设失败（${key}）：${error instanceof Error ? error.message : String(error)}`);
      personaCache = { at: at - PERSONA_TTL_MS + PERSONA_RETRY_MS, key, system: '' };
      return '';
    }
  }

  /**
   * 生成回复正文。**只有一条路：宿主 LLM**（免 Key，用 harness 默认模型）。
   * 模型不由本插件选——pet 与本插件共用 harness 的 `ctx.llm`，选谁跑是 harness 的事。
   *
   * 没有模板兜底：措辞必须是模型现写的。宿主没给 llm、模型没配、调用失败/空正文，
   * 一律 `{ok:false, error}` 交回调用方——**宁可不发，也不发一句模板腔出去**（那种一眼是机器人）。
   * @param {{peer: string, incoming: string[], pet?: string}} args 会话名 + 入站消息（旧→新）
   * @returns {Promise<{ok: boolean, text?: string, via: 'host-llm', error?: string}>} 正文
   */
  async function composeReply({ peer, incoming, pet: petId }) {
    if (hostLlm === null) return { ok: false, via: 'host-llm', error: '宿主未提供 llm 服务' };

    const texts = incoming.length > 0 ? incoming : ['（对方还没说话，先打个招呼）'];
    // 人设只有一份真源：宠物那只（pet 设置页里维护），进程内直取（petPersonaOf）。
    // 本插件不许有第二份人格——没有内置默认人设、也没有"人设补充"，那都会让同一个人有两套性格。
    // 中间那句是**身份声明**（管"对面是谁"，不管"你是谁"），来自熟人名单 web.knownPeers：
    // 每轮现算、不落盘，名单没配就是空串、不注入（老用户语气不变）。
    // 末尾这句是场景约束（管"怎么发"），不算人设。
    const scene =
      '你正在抖音的私信/群聊里替主人回一句话：只输出要发出去的正文，一到两句，不要解释、不要引号、不要分点、不自称 AI。';
    const whose = describePeer(peer, service.getConfig().web.knownPeers);
    const system = [await petPersonaOf(petId), whose, scene].filter((part) => part !== '').join('\n\n');
    const messages = buildChatMessages({ peer, texts, persona: system });
    const sys = messages[0]?.content ?? '';
    const user = messages[1]?.content ?? '请直接给出一条要回复的正文。';
    const r = await hostLlm.generate({ system: sys, user, timeoutMs: 30_000 });
    if (r.ok === true) return { ok: true, text: r.text, via: 'host-llm' };
    log.warn(`宿主 LLM 生成失败：${r.reason}`);
    return { ok: false, via: 'host-llm', error: r.reason };
  }

  /**
   * 最近一次拿到的宠物列表。
   *
   * `state()` 是同步的、`pet.petIds()` 是异步的，所以这里做一层缓存：
   * 前端一直读 `state.pets`（授牌表、对话面板的下拉都靠它），以前 state 里根本没有这个字段，
   * 结果桌宠明明在线，授牌页却写"没发现宠物"。
   */
  let knownPets = ['main'];
  let petsAt = 0;

  /** 刷新宠物缓存（失败就继续用旧的，不影响主流程） */
  async function refreshPets() {
    try {
      knownPets = await service.pets();
    } catch {
      /* 桌宠没在线时保持旧值 */
    }
    petsAt = now();
  }

  const capabilities = createCapabilities({
    getConfig: () => service.getConfig(),
    store,
    client,
    ensureToken,
    log,
    copy,
    packer,
    web,
  });

  /**
   * 过期时间点。
   * @param {number} seconds 秒
   * @returns {number} 时间戳
   */
  const at = (seconds) => (seconds > 0 ? now() + seconds * 1000 : 0);

  /**
   * 确保手里有一个可用的 access_token：
   * 没过期直接用；过期但有 refresh_token 就刷新（滚动保存）；都过期就要求重扫。
   * @param {{openId?: string, force?: boolean}} [opts] 选项（`openId` = 宠物绑定的账号）
   * @returns {Promise<any>} 账号（含明文 accessToken）
   */
  async function ensureToken(opts = {}) {
    const wanted = typeof opts.openId === 'string' ? opts.openId.trim() : '';
    const account = wanted === '' ? store.account() : store.findAccount(wanted);
    if (account === null) {
      throw new Error(
        wanted === ''
          ? '还没有绑定抖音账号（设置页 → 账号 → 扫码授权）'
          : `这只宠物绑定的账号已解绑（${wanted}），去授牌页重新选一个`,
      );
    }
    const expiresAt = Number(account.accessExpiresAt ?? 0);
    if (opts.force !== true && expiresAt > now() + TOKEN_SKEW_MS) return account;

    const refreshExpiresAt = Number(account.refreshExpiresAt ?? 0);
    const canRefresh = typeof account.refreshToken === 'string' && account.refreshToken !== '';
    const refreshAlive = refreshExpiresAt === 0 || refreshExpiresAt > now();
    if (!canRefresh || !refreshAlive) throw new Error('授权已过期（refresh_token 也失效了），请重新扫码');

    const cfg = service.getConfig();
    if (cfg.app.clientKey.trim() === '') throw new Error('应用凭据缺失，无法刷新 token');
    const next = await client.refresh({
      base: cfg.app.apiBase,
      clientKey: cfg.app.clientKey,
      refreshToken: account.refreshToken,
      throttleMs: cfg.behavior.throttleMs,
    });
    await store.patchAccount(account.openId, {
      accessToken: next.accessToken,
      accessExpiresAt: at(next.expiresIn),
      refreshToken: next.refreshToken !== '' ? next.refreshToken : account.refreshToken,
      refreshExpiresAt: next.refreshExpiresIn > 0 ? at(next.refreshExpiresIn) : account.refreshExpiresAt,
      scope: next.scope !== '' ? next.scope : account.scope,
      lastRefreshAt: now(),
    });
    log.info(`access_token 已刷新（${account.openId}）`);
    return store.findAccount(account.openId);
  }

  /**
   * 让桌宠说一句（关掉气泡就跳过）。
   * @param {string} text 台词
   * @param {{pet?: string, anim?: string}} [opts] 选项
   * @returns {Promise<void>} 完成
   */
  async function say(text, opts = {}) {
    if (!service.getConfig().pet.bubble) return;
    await pet.broadcast(text, opts);
  }

  /**
   * 强制说一句（**不看 `pet.bubble` 开关**）。
   *
   * 只给"用户刚下达的指令有了结果"这种必须回话的场合用。那个开关的语义是"别主动冒泡"，
   * 而"你让我发的那条发没发出去"是他要的直接答复——关了气泡不等于不需要知道结果。
   * @param {string} text 台词
   * @param {{pet?: string, anim?: string}} [opts] 选项
   * @returns {Promise<boolean>} 是否说出来
   */
  async function sayAlways(text, opts = {}) {
    const clean = String(text ?? '').trim();
    if (clean === '') return false;
    return pet.broadcast(clean.slice(0, 300), opts);
  }

  /**
   * 写工作状态（关掉就跳过）。
   * @param {'thinking'|'working'|'result'|'waiting'|'success'|'error'} state 档位
   * @param {string} task 文案
   * @returns {Promise<void>} 完成
   */
  async function status(state, task) {
    if (!service.getConfig().pet.workStatus) return;
    await pet.workStatus(state, task);
  }

  /**
   * 过一会儿清掉外部工作状态槽（否则残留的「成功」一直挂着）。
   * @param {number} ms 延迟
   * @returns {void}
   */
  function clearStatusLater(ms) {
    if (!service.getConfig().pet.workStatus) return;
    const timer = setTimeout(() => void pet.clearWorkStatus(), ms);
    if (typeof timer === 'object' && timer !== null) timer.unref?.();
  }

  const service = {
    paths,
    store,
    ledger,
    pet,
    mock,

    /**
     * 首次加载：读配置、台账、账号状态，并把旧的两个插件目录里的数据搬过来。
     * @returns {Promise<void>} 完成
     */
    async init() {
      // 顺序要紧：先读配置、先迁移旧目录，**再**加载 store/ledger——
      // 反过来的话迁移写进磁盘的文件这轮读不到，要等重启才生效
      const loaded = await loadConfig(paths);
      config = loaded.config;
      configWarnings = loaded.warnings;
      configExists = loaded.exists;
      await mkdir(paths.dir, { recursive: true });
      const migrated = await migrateLegacy(loaded.raw);
      await store.load();
      await ledger.load();
      await refreshPets();
      if (migrated.length > 0) log.info(`已从旧插件目录迁移：${migrated.join('、')}`);
      if (configWarnings.length > 0) log.warn(`配置有 ${configWarnings.length} 处不合法，已按默认值处理`);
      log.info(`数据目录：${paths.dir}${mock ? '（演示模式）' : ''}；发布包目录 ${packsDir()}`);
    },

    /** @returns {any} 成品配置 */
    getConfig() {
      if (config === undefined) throw new Error('服务尚未 init()');
      return config;
    },

    /** @returns {string[]} 配置告警 */
    configWarnings: () => configWarnings,

    /**
     * 保存配置并即时生效。
     * @param {any} patch 配置
     * @returns {Promise<{ok: boolean, warnings: string[], error?: string}>} 结果
     */
    async saveConfig(patch) {
      try {
        // Client Secret 不回传页面：留空 = 不改动
        const incoming = JSON.parse(JSON.stringify(patch ?? {}));
        const current = service.getConfig();
        if (incoming?.app !== undefined && (incoming.app.clientSecret === undefined || incoming.app.clientSecret === '')) {
          incoming.app.clientSecret = current.app.clientSecret;
        }
        const result = await saveConfig(paths, incoming);
        config = result.config;
        configWarnings = result.warnings;
        configExists = true;
        ffmpegCache = null;
        capabilities.clearCache();
        await service.refreshMenu();
        log.info('配置已保存');
        return { ok: true, warnings: result.warnings };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`配置保存失败：${message}`);
        return { ok: false, warnings: [], error: message };
      }
    },

    /**
     * 只改总开关。
     * @param {boolean} enabled 开关
     * @returns {Promise<{ok: boolean, warnings: string[]}>} 结果
     */
    async toggle(enabled) {
      return service.saveConfig({ ...service.getConfig(), enabled: enabled === true });
    },

    /**
     * 带缓存的 ffmpeg 探测。
     * @returns {Promise<object>} 探测结果
     */
    async ffmpeg() {
      const key = service.getConfig().transcode.ffmpegPath;
      if (ffmpegCache !== null && ffmpegCache.key === key) return ffmpegCache.value;
      const { detectFfmpeg } = await import('./media.js');
      const bin = await detectFfmpeg(key);
      ffmpegCache = { key, value: bin };
      return bin;
    },

    /* ---------------- 账号：授权 ---------------- */

    /**
     * 生成扫码授权地址。
     * @returns {{ok: boolean, url?: string, reason?: string}} 结果
     */
    authorizeUrl() {
      const cfg = service.getConfig();
      const ready = appReadiness(cfg);
      if (!ready.ready) return { ok: false, reason: `还缺 ${ready.missing.join(' / ')}（设置页 → 账号 → 应用凭据）` };
      return {
        ok: true,
        url: buildAuthorizeUrl({
          clientKey: cfg.app.clientKey.trim(),
          scopes: cfg.app.scopes,
          redirectUri: cfg.app.redirectUri,
          state: `dsh-${now().toString(36)}`,
          base: cfg.app.authorizeBase,
        }),
      };
    },

    /**
     * 用授权码换取并保存 token。`input` 可以是完整回调地址，也可以只是 code。
     * @param {string} input 回调地址或 code
     * @returns {Promise<{ok: boolean, profileWarning?: string, reason?: string}>} 结果
     */
    async exchangeCode(input) {
      const cfg = service.getConfig();
      const ready = appReadiness(cfg);
      if (!ready.ready) return { ok: false, reason: `还缺 ${ready.missing.join(' / ')}` };
      const code = extractCode(input);
      if (code === '') return { ok: false, reason: '没从这段内容里找到 code' };

      let token;
      try {
        token = await client.exchangeCode({
          base: cfg.app.apiBase,
          clientKey: cfg.app.clientKey.trim(),
          clientSecret: cfg.app.clientSecret.trim(),
          code,
          throttleMs: cfg.behavior.throttleMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`授权码换取失败：${message}`);
        return { ok: false, reason: message };
      }

      const account = {
        openId: token.openId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        accessExpiresAt: at(token.expiresIn),
        refreshExpiresAt: at(token.refreshExpiresIn),
        scope: token.scope,
        nickname: '',
        avatar: '',
        followerCount: 0,
        addedAt: now(),
      };
      let profileWarning = '';
      try {
        const info = await client.userInfo({
          base: cfg.app.apiBase,
          accessToken: token.accessToken,
          openId: token.openId,
          throttleMs: cfg.behavior.throttleMs,
        });
        account.nickname = info.nickname;
        account.avatar = info.avatar;
        account.followerCount = info.followerCount;
      } catch (error) {
        profileWarning = `已拿到 token，但读不到昵称头像（${error instanceof Error ? error.message : String(error)}）`;
        log.warn(profileWarning);
      }
      await store.upsertAccount(account);
      if (cfg.behavior.recordAudit) {
        await store.audit({ action: 'authorize', ok: true, detail: `绑定 ${account.nickname || account.openId}` });
      }
      log.info(`已绑定抖音账号：${account.nickname || account.openId}`);
      return { ok: true, profileWarning };
    },

    /**
     * 手动刷新 token。
     * @returns {Promise<{ok: boolean, expiresAt?: number, reason?: string}>} 结果
     */
    async refreshNow() {
      try {
        const account = await ensureToken({ force: true });
        return { ok: true, expiresAt: account.accessExpiresAt };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    /**
     * 切换默认账号。
     * @param {string} openId 账号
     * @returns {Promise<{ok: boolean}>} 结果
     */
    async setCurrent(openId) {
      const ok = await store.setCurrent(String(openId ?? ''));
      if (ok) capabilities.clearCache();
      return { ok };
    },

    /**
     * 解绑账号。
     * @param {string} openId 账号
     * @returns {Promise<{ok: boolean}>} 结果
     */
    async unlink(openId) {
      const removed = await store.removeAccount(openId);
      capabilities.clearCache();
      if (removed) log.info(`已解绑账号 ${openId}`);
      return { ok: removed };
    },

    /* ---------------- 授牌 ---------------- */

    /** @returns {any[]} 授牌列表 */
    listGrants: () => store.listGrants(now()),

    /**
     * 给某只宠物授牌（覆盖式）。
     * @param {{pet: string, caps: Record<string, boolean>, ttlHours?: number, accountOpenId?: string, quota?: any, autonomy?: any}} args 参数
     * @returns {Promise<{ok: boolean, grant?: any, reason?: string}>} 结果
     */
    async setGrant({ pet, caps, ttlHours = 0, accountOpenId = '', quota = null, autonomy = null }) {
      const id = String(pet ?? '').trim();
      if (id === '') return { ok: false, reason: '宠物 id 不能为空' };
      const clean = Object.fromEntries(CAPS.filter((c) => caps?.[c] === true).map((c) => [c, true]));
      const bound = String(accountOpenId ?? '').trim();
      if (bound !== '' && store.findAccount(bound) === null) return { ok: false, reason: `绑定的账号不存在（${bound}）` };
      if (Object.keys(clean).length === 0) {
        await store.revokeGrant(id);
        return { ok: true, grant: null };
      }
      const grant = await store.setGrant(id, clean, Number(ttlHours) || 0, { accountOpenId: bound, quota, autonomy });
      if (service.getConfig().behavior.recordAudit) {
        await store.audit({ pet: id, action: 'grant', ok: true, detail: Object.keys(clean).map((c) => CAP_LABEL[c]).join('、') });
      }
      log.info(`已给宠物 ${id} 授牌：${Object.keys(clean).join(',')}`);
      return { ok: true, grant };
    },

    /**
     * 撤销某只宠物的全部能力。
     * @param {string} pet 宠物 id
     * @returns {Promise<{ok: boolean}>} 结果
     */
    async revokeGrant(pet) {
      const ok = await store.revokeGrant(String(pet ?? '').trim());
      if (ok && service.getConfig().behavior.recordAudit) await store.audit({ pet, action: 'revoke', ok: true });
      return { ok };
    },

    /**
     * 所有宠物 id（dsh-pet 在线列表 + 已授牌的）。
     * @returns {Promise<string[]>} 宠物 id
     */
    async pets() {
      const ids = await pet.petIds();
      const granted = store.listGrants(now()).map((g) => g.pet);
      const all = new Set([...ids, ...granted]);
      if (all.size === 0) all.add('main');
      return Array.from(all).sort();
    },

    /* ---------------- 能力（宠物调用，全部过授牌） ---------------- */

    browse: (args) => capabilities.browse(args),
    share: (args) => capabilities.share(args),
    dm: (args) => capabilities.dm(args),
    openFeed: (args) => capabilities.openFeed(args),
    publish: (args) => capabilities.publish(args),
    dmStatus: () => dmSendSupported(),

    /**
     * 设置页试验台：不校验授牌（本机人工操作）。
     * @returns {Promise<object>} 结果
     */
    async peekVideos() {
      try {
        const res = await capabilities.peek();
        return { ok: true, items: res.items, scopeOk: res.scopeOk, hint: res.hint ?? '' };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    /* ---------------- 发布包（人工路径，不受授牌约束） ---------------- */

    /**
     * 扫一遍目录（不准备、不落盘）。
     * @returns {Promise<object>} 扫描结果
     */
    async scan() {
      const { listVideos } = await import('./media.js');
      const result = await listVideos(service.getConfig().source, (key) => ledger.has(key));
      return { ...result, items: result.items.slice(0, 30), remaining: Math.max(0, result.items.length - 30) };
    },

    /**
     * 人工准备一条发布包。
     * @param {{file?: string, reason?: string, quiet?: boolean}} [opts] 选项
     * @returns {Promise<object>} 结果
     */
    async prepare(opts = {}) {
      const reason = opts.reason ?? 'manual';
      await status('result', `整理抖音发布包（${reason}）`);
      if (service.getConfig().pet.animOnStart !== '') void pet.playAnim(service.getConfig().pet.animOnStart);
      const result = await packer.prepare({ file: opts.file, reason });
      if (result.ok === true && result.pack !== undefined) {
        lastPack = result.pack;
        await ledger.setSchedule(markRun(ledger.schedule(), new Date(), service.state().schedule.pendingSlot));
        await status('success', `发布包已备好：${result.pack.caption.title}`);
        if (opts.quiet !== true) await say(`「${result.pack.caption.title}」备好了，去抖音发一下～`);
        clearStatusLater(15_000);
      } else if (result.skipped === true) {
        await status('waiting', `跳过一条：${result.reason ?? ''}`);
        clearStatusLater(8_000);
      } else {
        await status('error', `抖音分享没成：${result.reason ?? '未知原因'}`);
        clearStatusLater(12_000);
      }
      return result;
    },

    /**
     * 回填一条记录的结局。
     * @param {string} id 记录 id 或 packId
     * @param {'published'|'skipped'|'packed'} status 新状态
     * @returns {Promise<object|null>} 更新后的记录
     */
    mark: (id, status) => packer.mark(id, status),

    /**
     * 发布包列表。
     * @param {number} [limit] 条数
     * @returns {Promise<object[]>} 包信息
     */
    async listPacks(limit = 20) {
      const root = packsDir();
      let dirs;
      try {
        dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
      dirs.sort().reverse();
      const out = [];
      for (const name of dirs.slice(0, limit)) {
        const meta = await readJson(join(root, name, 'meta.json'), null);
        if (meta !== null && typeof meta === 'object') {
          const info = await stat(join(root, name)).catch(() => null);
          out.push({ ...meta, packId: name, dir: join(root, name), mtimeMs: info?.mtimeMs ?? 0 });
        }
      }
      return out;
    },

    /* ---------------- 视图 ---------------- */

    /**
     * 状态快照（设置页唯一数据源）。
     * @returns {object} 状态
     */
    state() {
      const cfg = service.getConfig();
      const atNow = now();
      const sched = ledger.schedule();
      const decision = decideRun(cfg, sched, new Date(atNow));
      const stats = ledger.stats(dateKey(new Date(atNow)));
      const account = store.account();
      const ready = appReadiness(cfg);
      const scope = account?.scope ?? '';
      if (atNow - petsAt > 30_000) void refreshPets();
      return {
        now: atNow,
        mock,
        /** 宠物 id 列表（桌宠在线列表 + 已授牌），授牌表与对话面板的下拉都用它 */
        pets: knownPets,
        enabled: cfg.enabled,
        busy: packer.busy(),
        lastError: packer.lastError(),
        configExists,
        configWarnings,
        /** 与 dsh-pet 的联动状态 */
        link: { petMenu: pet.menuReady?.() === true },
        paths: {
          dir: paths.dir,
          configFile: paths.configFile,
          accountsFile: paths.accountsFile,
          packsDir: packsDir(),
          logFile: paths.logFile,
        },
        // 账号
        app: {
          ready: ready.ready,
          missing: ready.missing,
          clientKey: mask(cfg.app.clientKey),
          redirectUri: cfg.app.redirectUri,
          scopes: cfg.app.scopes,
        },
        account:
          account === null
            ? null
            : {
                openId: account.openId,
                nickname: account.nickname ?? '',
                avatar: account.avatar ?? '',
                followerCount: account.followerCount ?? 0,
                scope,
                accessExpiresAt: account.accessExpiresAt ?? 0,
                refreshExpiresAt: account.refreshExpiresAt ?? 0,
                addedAt: account.addedAt ?? 0,
                scopeBrowse: scope === '' ? null : hasScope(scope, SCOPE_OF.videoList),
              },
        accounts: store.listAccounts(),
        grants: store.listGrants(atNow).map((g) => ({ ...g, usage: store.usageOf(g.pet, atNow) })),
        caps: CAPS.map((c) => ({ key: c, label: CAP_LABEL[c] })),
        /** 支持的说话示例（UI 与命令共用同一份，避免文案漂移） */
        examples: intentExamples(),
        dm: dmSendSupported(),
        audit: store.listAudit(50),
        // 发布包
        ledger: stats,
        schedule: {
          mode: cfg.schedule.mode,
          weekdays: describeWeekdays(cfg.schedule.weekdays),
          todayCount: stats.todayCount,
          maxPerDay: cfg.schedule.maxPerDay,
          nextAt: estimateNextRun(cfg, sched, new Date(atNow)),
          shouldRun: decision.run,
          reason: decision.reason,
          pendingSlot: decision.slot ?? null,
        },
        lastTick,
        lastPack,
        // 配置（脱敏）
        config: { ...cfg, app: { ...cfg.app, clientSecret: '' } },
        hasSecret: cfg.app.clientSecret !== '',
      };
    },

    /* ---------------- 桌宠 ---------------- */

    /**
     * 挂右键菜单（一个 owner、五项）。
     * @returns {Promise<boolean>} 是否挂上
     */
    async startMenu() {
      const cfg = service.getConfig();
      const labels = service.menuLabels();
      const ok = await pet.registerMenu(labels);
      stopMenu = pet.startMenuLoop(labels, (label, petId) => {
        log.info(`右键菜单：${label}（宠物 ${petId}）`);
        void handleMenu(label, petId);
      });
      return ok || cfg.pet.menuFeed !== ''; // 首个注册失败时循环会自动重挂，仍算"已安排"
    },

    /**
     * 当前菜单文案（顺序即菜单顺序）。
     * @returns {string[]} 文案
     */
    menuLabels() {
      const p = service.getConfig().pet;
      return [p.menuFeed, p.menuPublish, p.menuChat, p.menuSettings];
    },

    /**
     * 刷推荐流并按选定的方式"分享"出去。
     *
     * 三种方式共用同一次刷取结果，差别只在收尾：
     * - `notify`（默认）：播报到桌宠气泡，**不发任何消息**；
     * - `copy`：把最热那条的分享文案复制到剪贴板（作者 + 标题 + 单条链接）；
     * - `dm`：把同一段文案发给指定昵称，走已有私信通道（`allowAutoSend` 关着就如实失败，不假装发出）。
     *
     * 为什么"最热那条"而不是随机：刷一屏 30 条，用户要的是"有值得看的"，
     * 按点赞挑比随机更不容易给出垃圾；想换一条再刷一次即可。
     * @param {{pet: string, limit?: number, share?: 'notify'|'copy'|'dm', to?: string}} args 参数
     * @returns {Promise<object>} 结果（失败带 reason，不抛）
     */
    async scanFeed({ pet, limit, share, to }) {
      const cfg = service.getConfig();
      const want = Number(limit) > 0 ? Math.min(Math.floor(Number(limit)), 50) : cfg.behavior.feedLimit;
      const id = String(pet ?? '').trim() || 'main';
      const r = await capabilities.feed({ pet: id, limit: want });
      const items = Array.isArray(r.items) ? r.items : [];
      if (items.length === 0) return { ok: false, pet: id, reason: '推荐流没刷到内容' };
      const mode = ['notify', 'copy', 'dm'].includes(share) ? share : cfg.behavior.feedShareMode;

      if (mode === 'copy') {
        const text = shareTextOf(topByLikes(items, 1)[0]);
        const copied = await copy(text);
        return { ok: true, pet: id, mode, total: items.length, items, text, copied: { ok: copied?.ok === true } };
      }
      if (mode === 'dm') {
        const target = String(to ?? '').trim();
        if (target === '') return { ok: false, pet: id, reason: '没指定发给谁（要给一个抖音昵称）' };
        const text = shareTextOf(topByLikes(items, 1)[0]);
        const sent = await web.sendMessage({ to: target, text });
        if (sent.ok !== true) return { ok: false, pet: id, mode, total: items.length, text, reason: sent.reason ?? '没发出去' };
        return { ok: true, pet: id, mode, total: items.length, items, text, sent: { ok: true, to: target } };
      }

      // 默认：读文案后用自己的话说给主人听（不发任何消息）
      //
      // 为什么不让模板播报：数据里每条都有创作者写的 caption（实测 6/6），
      // 只念标题等于"看见封面就当看过了"。这里把最热几条的标题+文案交给模型，
      // 让它挑值得看的、用自己的口气讲 1–2 句——这才是"知道讲的是啥"。
      // 模型不可用/没出正文就退回模板摘要：播报是给自己看的，宁可有条理，不必宁缺。
      const picked = topByLikes(items, 3);
      const brief = picked
        .map((it, i) => `${i + 1}. @${it.author}｜${it.title}｜${String(it.summary ?? '').slice(0, 160)}`)
        .join('\n');
      const fallback = digestOf(items, { max: 3 });
      let text = fallback;
      let frames = 0;
      if (hostLlm !== null && brief !== '') {
        // 看一眼画面：文案可能是标题党、也可能根本没写清楚，截几帧给模型比只读文字准得多。
        // 三种情况都退回纯文字（不报错、也不假装看了图）：没配帧数 / 宿主没附件服务 / 取帧失败。
        let images = [];
        const wantFrames = Number(cfg.behavior.feedLookFrames) || 0;
        if (wantFrames > 0 && attachments !== null) {
          const grabbed = await web.grabFrames({ count: wantFrames }).catch(() => ({ ok: false }));
          if (grabbed.ok === true) {
            const saved = await attachments.saveImages(grabbed.frames).catch(() => null);
            if (Array.isArray(saved) && saved.length > 0) {
              images = saved;
              frames = saved.length;
            } else {
              log.warn('画面存成附件失败（附件服务没返回引用），这一轮只看文字');
            }
          } else {
            log.warn(`取帧失败，这一轮只看文字：${grabbed.reason ?? '未知原因'}`);
          }
        }
        const persona = (await petPersonaOf(id)).trim();
        const scene =
          '你刚刷完抖音，正在跟主人说哪几条值得看：一到两句口语，挑一条讲清楚讲了什么，不要罗列清单、不要项目符号、不要自称 AI。' +
          (frames > 0 ? '后面附了几张当前这条的画面，按画面说，别只看标题猜。' : '');
        const system = [persona, scene].filter((part) => part !== '').join('\n\n');
        const r = await hostLlm
          .generate({
            system,
            user: `我刚刷了 ${items.length} 条，这是最热的几条（作者｜标题｜创作者写的文案）：\n${brief}\n请挑 1 条讲给主人听，说清它讲了什么。`,
            images,
            timeoutMs: 30_000,
          })
          .catch(() => ({ ok: false }));
        if (r?.ok === true && String(r.text ?? '').trim() !== '') text = String(r.text).trim();
        else log.warn(`刷推荐流的点评生成失败，用模板摘要顶上：${r?.reason ?? '空正文'}`);
      }
      await say(text, { pet: id, anim: cfg.pet.animOnDone });
      return { ok: true, pet: id, mode: 'notify', total: items.length, items, text, frames, via: text === fallback ? 'template' : 'host-llm' };
    },

    /**
     * 重新挂菜单（改了文案后调）。
     * @returns {Promise<boolean>} 是否成功
     */
    async refreshMenu() {
      return pet.registerMenu(service.menuLabels());
    },

    /**
     * 一句话驱动：解析意图 → 过授牌 → 调能力 → 回一句人话。
     *
     * 三条不变量：
     * 1. **`sent` 恒为 false**。私信这条永远只到草稿，UI 据此不出现"已发送"。
     * 2. **认不出收件人就不动手**，只回一句追问，绝不默认发给谁。
     * 3. **读会话要过授牌**。读消息本质上是在碰私信内容，和发草稿一样按 `dm` 能力管。
     * @param {{pet: string, text: string}} args 参数
     * @returns {Promise<object>} 结果
     */
    async say({ pet, text }) {
      const id = String(pet ?? '').trim();
      const intent = parseIntent(text);
      const base = { ok: true, pet: id, intent, sent: false, action: intent.action };

      /** 授牌 + 配额闸门；通过返回 null */
      const gate = (cap) => {
        const g = store.checkGrant(id, cap);
        if (!g.ok) return { ...base, ok: false, reply: g.reason, needGrant: cap };
        const q = store.checkQuota(id, cap);
        if (!q.ok) return { ...base, ok: false, reply: q.reason, needQuota: cap };
        return null;
      };

      /** 记一笔审计，失败不影响主流程 */
      const audit = async (cap, ok, detail) => {
        if (service.getConfig().behavior.recordAudit !== true) return;
        await store.audit({ pet: id, cap, action: 'say', ok, detail }).catch(() => {});
      };

      if (intent.action === 'help') {
        return { ...base, ok: false, reply: intent.needs, needIntent: true };
      }

      if (intent.action === 'dm') {
        const blocked = gate('dm');
        if (blocked !== null) {
          await audit('dm', false, blocked.reply);
          return blocked;
        }

        // 先在已登录窗口里核对这个名字在不在会话列表 —— 对不上就提前说，省得人去 App 里翻
        let found = null;
        let chatNote = '';
        try {
          const chats = await web.listChats();
          if (chats.ok) {
            found = (chats.items ?? []).find((c) => c.name === intent.to) ?? null;
            chatNote = found === null ? '会话列表里没看到这个名字（可能要先互关，或对方从没给你发过消息）' : '';
          } else {
            chatNote = chats.reason ?? '';
          }
        } catch (error) {
          chatNote = error instanceof Error ? error.message : String(error);
        }

        // 用量由 capabilities.dm 内部记（guarded 只在成功后记一次），这里不能重复记
        const draft = await capabilities.dm({ pet: id, to: intent.to, topic: intent.topic, openApp: false });

        const focused = await web.focusChat().catch(() => ({ ok: false }));
        if (focused.ok !== true) await open('https://www.douyin.com/chat');

        // 步骤第 0 句原本是"自己打开抖音"；既然窗口已经带过去了，就得改掉——
        // 回复正文和步骤互相打架，比说错更糟的是让人不知道该信哪一句
        const steps = [...(draft.steps ?? [])];
        if (steps.length > 0) {
          steps[0] = focused.ok === true ? '抖音已切到消息页（那个已登录的窗口）' : '已打开网页版消息页';
        }

        // 若开了「允许自动发送」且用户确实给了正文，就直接发出去（发的是用户原话，不拼开场白）。
        // 没给正文时不发——不能把模板占位文字当成用户的话发给别人。
        let sent = false;
        let sendResult = null;
        const autoOk = service.getConfig().web.allowAutoSend === true && intent.topic.trim() !== '';
        if (autoOk) {
          sendResult = await web.sendMessage({ to: intent.to, text: intent.topic }).catch((e) => ({
            ok: false,
            reason: e instanceof Error ? e.message : String(e),
          }));
          sent = sendResult.ok === true;
          await audit('dm', sent, `send→${intent.to} ${sent ? '已核对' : sendResult.reason ?? '失败'}`);
        }

        const reply = sent
          ? `已发给「${intent.to}」：${intent.topic}（回执已核对：会话里出现了这条）`
          : [
              `草稿已复制（收件人「${intent.to}」）`,
              found !== null ? `会话在，最后一条：「${found.last}」` : chatNote,
              autoOk ? `自动发送没成功：${sendResult?.reason ?? '未知原因'}` : '',
              focused.ok === true ? '窗口已切到消息页：点会话 → 粘贴 → 你点发送' : '专用浏览器没连上，已改为打开网页版消息页',
              autoOk ? '' : '自动发送没开（设置页 → 账号 → 网页通道）；开着我就直接发。',
            ]
              .filter((x) => typeof x === 'string' && x !== '')
              .join('；');

        await audit('dm', true, `say→dm ${intent.to}`);
        return {
          ...base,
          action: 'dm',
          sent,
          sendResult,
          reply,
          draft: { ...draft, steps },
          chatFound: found !== null,
          focused: focused.ok === true,
        };
      }

      if (intent.action === 'reply') {
        const blocked = gate('dm');
        if (blocked !== null) {
          await audit('dm', false, blocked.reply);
          return blocked;
        }

        // 定目标：显式名字 > 当前打开的会话。读不到就直说，不猜。
        const read = await web
          .readIncoming(intent.to !== '' ? { to: intent.to } : {})
          .catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
        if (read.ok !== true) {
          await audit('dm', false, `reply ${read.reason ?? ''}`);
          return { ...base, ok: false, reply: read.reason ?? '读不到会话', needWeb: true };
        }
        const target = read.to;
        const last = Array.isArray(read.incoming) && read.incoming.length > 0 ? read.incoming[read.incoming.length - 1] : '';
        // 用户亲手给的正文原样发（那是用户的话，不加工）；没给正文才让大模型现写
        const composed =
          intent.topic.trim() !== ''
            ? { ok: true, text: intent.topic, via: 'user' }
            : await composeReply({ peer: target, incoming: Array.isArray(read.incoming) ? read.incoming : [], pet: id });
        if (composed.ok !== true) {
          // 没有模板兜底：模型没出正文就不发，如实报原因（发模板腔比不发更糟）
          await audit('dm', false, `reply 未生成 ${composed.error ?? ''}`);
          return {
            ...base,
            ok: false,
            action: 'reply',
            to: target,
            lastIncoming: last,
            reply: `没生成出回复正文：${composed.error ?? '未知原因'}（回复只走大模型，取不到就不发）`,
            needLlm: true,
          };
        }
        const text = composed.text;

        const sendResult = await web.sendMessage({ to: target, text }).catch((e) => ({
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        }));
        const sent = sendResult.ok === true;
        if (sent) await store.recordUse(id, 'dm');
        await audit('dm', sent, `reply(${composed.via})→${target} ${sent ? '已核对' : sendResult.reason ?? '失败'}`);

        const replyMsg = sent
          ? [
              last !== '' ? `他刚说：「${last.slice(0, 40)}」` : '会话里还没有入站消息',
              `已回复「${target}」：${text}`,
            ].join('；')
          : `回复没发出去：${sendResult.reason ?? '未知原因'}`;

        return { ...base, action: 'reply', to: target, lastIncoming: last, sent, replyVia: composed.via, sendResult, reply: replyMsg };
      }

      if (intent.action === 'chats') {
        const blocked = gate('dm');
        if (blocked !== null) {
          await audit('dm', false, blocked.reply);
          return blocked;
        }
        const r = await web.listChats();
        if (r.ok !== true) {
          await audit('dm', false, r.reason ?? '读不到会话');
          return { ...base, ok: false, reply: r.reason ?? '读不到会话', needWeb: true };
        }
        const items = r.items ?? [];
        await store.recordUse(id, 'dm');
        await audit('dm', true, `say→chats ${items.length} 条`);
        const reply =
          items.length === 0
            ? '会话列表是空的。'
            : `有 ${items.length} 个会话：` + items.slice(0, 6).map((c) => `${c.name}（${c.last}）`).join('；');
        return { ...base, action: 'chats', reply, items };
      }

      if (intent.action === 'feed') {
        const blocked = gate('browse');
        if (blocked !== null) {
          await audit('browse', false, blocked.reply);
          return blocked;
        }
        const r = await service.scanFeed({ pet: id });
        if (r.ok !== true) {
          await audit('browse', false, r.reason ?? '刷推荐流失败');
          return { ...base, ok: false, reply: r.reason ?? '刷推荐流失败了', needWeb: true };
        }
        await audit('browse', true, `say→feed ${r.total} 条`);
        return { ...base, action: 'feed', reply: r.text, result: { total: r.total, mode: r.mode } };
      }

      if (intent.action === 'publish') {
        const r = await capabilities.publish({ pet: id });
        lastPack = r.pack ?? lastPack;
        await audit('publish', true, `say→publish`);
        return { ...base, action: 'publish', reply: `发布包做好了：${r.pack?.caption?.title ?? ''}`, result: r };
      }

      return { ...base, ok: false, reply: intent.needs, needIntent: true };
    },

    /**
     * 宠物对话里的一句话（pet 的扩展能力位问过来的，`POST /pet-say`）。
     *
     * 与 `say()` 的唯一区别是**必须立刻回话**：宠物界面上那句话在等回复，而真发一条私信要几秒
     * （开标签、找会话、输入、等回执），同步等会把对话卡住。所以：接得住就立刻给一句回执，
     * 执行放后台，成败再由宠物自己播报（播报不吃授牌，与命令跑完的待遇一致）。
     *
     * 接不住的（认不出意图、缺收件人/正文）如实回 `claimed:false`，让宠物用自己的人格正常闲聊——
     * 那比一句干巴巴的"没听懂"更像宠物。
     *
     * @param {{pet: string, text: string}} args 参数
     * @returns {Promise<{ok: boolean, claimed: boolean, ack: string, action: string}>} 认领结论
     */
    async petSay({ pet, text }) {
      const id = String(pet ?? '').trim() || 'main';
      const clean = String(text ?? '').trim();
      if (clean === '') return { ok: true, claimed: false, ack: '', action: 'help' };

      const intent = parseIntent(clean);
      const claim = describeClaim(intent);
      if (!claim.claimable) {
        // 一行日志足够回答"为什么这句话宠物只是陪我聊了两句"
        log.info(`宠物对话未接管（${id}）：「${clean.slice(0, 40)}」→ ${intent.action}`);
        return { ok: true, claimed: false, ack: '', action: intent.action };
      }
      log.info(`宠物对话接管（${id}）：「${clean.slice(0, 40)}」→ ${intent.action}`);

      /**
       * 结果播报（只播一次）。
       *
       * **故意不走 `announce()`**：它吃 `pet.bubble` 开关，而那个开关的语义是"别主动冒泡"。
       * 用户刚说完"给谁发条消息"，办成没办成属于他要的直接答复——关了气泡不等于不需要知道结果，
       * 否则就变成"我说去办了，然后再也没有下文"。这是本插件唯一绕开该开关的地方。
       * @param {string} reply 结果文案
       * @returns {Promise<void>} 完成
       */
      let announced = false;
      const announceResult = async (reply) => {
        if (announced) return;
        announced = true;
        const text = String(reply ?? '').trim();
        if (text === '') return;
        // 注意用 sayAlways（不吃 bubble 开关），且不能用 `pet.broadcast`——
        // 本方法的参数就叫 `pet`（宠物 id），直接写会把字符串当桥对象用
        try {
          await sayAlways(text, { pet: id });
        } catch (e) {
          // 播报失败不该反过来污染"执行结果"的日志，单独记一行
          log.warn(`宠物对话结果播报失败（${id}）：${e instanceof Error ? e.message : String(e)}`);
        }
      };

      // 兜底：真卡住（浏览器在启动、页面不响应）也要有一句，不然用户会以为石沉大海
      const timer = setTimeout(() => void announceResult('这件事拖太久了，我先放下，等会儿再试。'), 120_000);
      if (typeof timer === 'object' && timer !== null) timer.unref?.();

      // 不 await：先把回执还回去，执行与播报在后台跑（失败也要说，宠物不能假装成功）
      void service
        .say({ pet: id, text: clean })
        .then((r) => {
          log.info(`宠物对话执行完成（${id}）：${r.ok === true ? 'ok' : r.reason ?? 'fail'}，回执 ${String(r.reply ?? '').slice(0, 30)}`);
          return announceResult(r.reply);
        })
        .catch((e) => {
          log.warn(`宠物对话执行抛错（${id}）：${e instanceof Error ? e.message : String(e)}`);
          return announceResult(`没办成：${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => clearTimeout(timer));

      return { ok: true, claimed: true, ack: claim.ack, action: intent.action };
    },

    /**
     * 试一句：按当前人设生成一条回复，**只生成、不发送**。
     *
     * 为什么需要：调提示词最难受的是"改了不知道效果"。这里走的是真链路——同一套
     * system/user 拼装、同一个宿主模型，只是不落到聊天窗口，所以可以反复试而不会真的给人发消息。
     * @param {{pet?: string, peer?: string, text?: string}} args 对方名字 + 对方说的话
     * @returns {Promise<object>} `{ok, text?, via, error?}`（失败时 ok=false，与真实发送链路同一判据）
     */
    async previewReply({ pet, peer, text }) {
      const said = String(text ?? '').trim();
      return composeReply({
        peer: String(peer ?? '').trim() || '对方',
        incoming: said === '' ? [] : [said],
        ...(String(pet ?? '').trim() === '' ? {} : { pet: String(pet).trim() }),
      });
    },

    /**
     * 网页发布：把发布包（或指定视频）直接投到抖音创作者中心，**不走官方 API**。
     *
     * 默认**不点发布**：`web.autoPublish` 关着就停在发布按钮前。理由不是保守——
     * 视频一出去就是公开内容且不可撤销，而封面、权限（公开/好友/仅自己）、定时发布
     * 这些字段还得人看一眼；自动化到"填完标题"这一步，剩下的价值远小于风险。
     * 开关打开才走最后那一下。
     *
     * @param {{pet: string, file?: string, title?: string, autoPublish?: boolean}} args 参数
     * @returns {Promise<object>} 结果（带 `mode`：`ready` = 停在发布前，`published` = 已发）
     */
    async publishToDouyin({ pet, file, title, autoPublish }) {
      const id = String(pet ?? '').trim();
      // 空 pet = 设置页里人自己点的（与 /prepare 同一条人工路径），不受宠物授牌约束；
      // 带 pet = 宠物代劳，必须过 publish 授牌与配额
      if (id !== '') {
        const g = store.checkGrant(id, 'publish');
        if (!g.ok) return { ok: false, reason: g.reason, needGrant: 'publish' };
        const q = store.checkQuota(id, 'publish');
        if (!q.ok) return { ok: false, reason: q.reason, needQuota: 'publish' };
      }

      // 视频来源：显式路径 > 最近一个发布包（包里的视频是按 pack.dir 拼接的相对文件名）
      const packVideo = lastPack?.dir && lastPack?.video?.file ? join(lastPack.dir, lastPack.video.file) : '';
      const target = String(file ?? '').trim() || packVideo;
      if (target === '') return { ok: false, reason: '没有可发布的视频：先出一个发布包，或直接给文件路径' };

      const text = String(title ?? '').trim() || String(lastPack?.caption?.title ?? '').trim();
      // 显式传了就以它为准（设置页"发一次"可以临时覆盖），没传才听配置
      const auto = autoPublish === undefined ? service.getConfig().web.autoPublish === true : autoPublish === true;

      const r = await web.publishVideo({ file: target, title: text, autoPublish: auto });
      const mode = r.ok === true ? r.mode ?? 'ready' : 'fail';
      await store
        .audit({ pet: id, cap: 'publish', action: 'webpublish', ok: r.ok === true, detail: `${mode} ${target.split(/[\\/]/).pop() ?? ''}${text === '' ? '' : ' / ' + text.slice(0, 20)}` })
        .catch(() => {});

      // 结果必达（与对话认领同一条规矩：用户下的指令有了结果就得说一声）。
      // 没有 pet（设置页人工路径）就不播报——那时候人就在页面前，看得见结果。
      if (id !== '') {
        if (r.ok === true && mode === 'published') {
          await sayAlways(`发出去了：${text === '' ? '视频' : text}`, { pet: id });
        } else if (r.ok === true) {
          await sayAlways(r.titleSet === true ? '视频传好了，标题也填了，去点「发布」吧～' : '视频传好了，标题没填上，你去看看再发', { pet: id });
        } else {
          await sayAlways(`没发成：${String(r.reason ?? '').slice(0, 60)}`, { pet: id });
        }
      }

      return { ...r, file: target, title: text, autoPublish: auto };
    },

    /**
     * 让桌宠说一句。
     *
     * 这是**插件主动播报**，不是宠物调能力，所以不过授牌——否则命令跑完没人看见结果。
     * 关掉气泡时不说话，只返回 false。
     * @param {string} text 内容
     * @param {string} [pet] 指定宠物
     * @returns {Promise<boolean>} 是否说出来了
     */
    async announce(text, pet) {
      if (service.getConfig().pet.bubble !== true) return false;
      const clean = String(text ?? '').trim();
      if (clean === '') return false;
      return say(clean.slice(0, 300), { pet });
    },

    /**
     * 网页通道状态（给 UI 显示"那个专用浏览器开着没"）。
     * @returns {Promise<object>} 状态
     */
    async webStatus() {
      const st = await web.status();
      const result =
        st.ok !== true ? { ...st, checkedAt: now() } : { ...st, loggedIn: (await web.loginState()).loggedIn === true, port: web.port(), checkedAt: now() };
      lastWebStatus = result;
      return result;
    },

    /**
     * 上一次探测到的网页通道状态（同步；没探过返回 null）。
     *
     * 命令 handler 必须同步返回，而探测是异步的——所以「先给上次结果、同时后台刷新」，
     * 用户打两次 `/ego-browser` 就能看到最新状态，不用等。
     * @returns {any|null} 缓存
     */
    webStatusCached() {
      return lastWebStatus;
    },

    /**
     * 在专用浏览器里开一个标签页（`/ego-browser` 用）；离线就先把它拉起来。
     * @param {string} url 目标链接
     * @returns {Promise<{ok: boolean, reason?: string}>} 结果
     */
    async openBrowserTab(url) {
      const online = await web.ensureOnline();
      if (online.ok !== true) return { ok: false, reason: online.reason ?? '专用浏览器没起来' };
      return web.openTab(url);
    },

    /**
     * 设置页地址。
     * @returns {string} URL
     */
    pageUrl() {
      const port = getPort();
      return port ? `http://127.0.0.1:${port}${ROUTE_PREFIX}/` : '';
    },

    /**
     * 刷新并返回宠物列表。
     * @returns {Promise<string[]>} 宠物 id
     */
    async refreshPets() {
      await refreshPets();
      return knownPets;
    },

    /**
     * 探活桌宠。
     * @returns {Promise<{ok: boolean, pets: number, said?: boolean, reason?: string}>} 结果
     */
    async petTest() {
      const ping = await pet.ping();
      if (!ping.ok) return { ok: false, pets: 0, reason: `连不上 dsh-pet：${ping.error ?? '未知'}` };
      const said = await pet.broadcast('抖音插件已就位，授个牌我就能用～');
      return { ok: true, pets: ping.pets, said };
    },

    /* ---------------- 定时 ---------------- */

    /**
     * 发布包节奏：每 30 秒问一次「该不该自动出一条」。
     * @param {number} [intervalMs] 间隔
     * @returns {void}
     */
    startPublishSchedule(intervalMs = 30_000) {
      if (publishTimer !== null) return;
      const tick = async () => {
        if (packer.busy()) return;
        const atNow = new Date(now());
        const decision = decideRun(service.getConfig(), ledger.schedule(), atNow);
        lastTick = { at: atNow.getTime(), reason: decision.reason };
        if (!decision.run) return;
        if (decision.slot !== undefined) {
          await ledger.setSchedule(markRun(ledger.schedule(), atNow, decision.slot, { count: false }));
        }
        await service.prepare({ reason: `定时（${decision.reason}）` });
      };
      publishTimer = setInterval(() => void tick(), intervalMs);
      if (typeof publishTimer === 'object' && publishTimer !== null) publishTimer.unref?.();
      log.info(`发布包定时检查已启动（每 ${Math.round(intervalMs / 1000)} 秒）`);
    },

    /**
     * 自主浏览：每分钟问一次「哪只宠物该自己看两眼了」，只读不发送。
     * @param {number} [intervalMs] 间隔
     * @returns {void}
     */
    startAutonomy(intervalMs = 60_000) {
      if (autonomyTimer !== null) return;
      const tick = async () => {
        const cfg = service.getConfig();
        if (cfg.behavior.autonomyEnabled !== true) return;
        const decisions = decideAutonomy(cfg.behavior, store.listGrants(now()), (pet2) => store.usageOf(pet2, now()), new Date(now()), lastAutonomyAt);
        for (const d of decisions) {
          if (!d.run) continue;
          lastAutonomyAt[d.pet] = now();
          try {
            const r = await capabilities.browse({ pet: d.pet, force: true });
            log.info(`自主浏览 ${d.pet}：${r.summary}`);
            await say(`自己翻了下：${r.summary}`, { pet: d.pet });
          } catch (error) {
            log.warn(`自主浏览失败（${d.pet}）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };
      autonomyTimer = setInterval(() => void tick(), intervalMs);
      if (typeof autonomyTimer === 'object' && autonomyTimer !== null) autonomyTimer.unref?.();
      log.info('自主检查已启动（每分钟一次，间隔/时段由配置决定）');
    },

    /**
     * 自动回复：定期读"当前打开的那个会话"的入站消息，新消息按模板回一条。
     *
     * 四条护栏：
     * 1. **双开关**：`web.autoReply` 和 `web.allowAutoSend` 都开着才动手；
     * 2. **不拉浏览器**：后台轮询连不上 CDP 就静默跳过——自动拉窗口是"你主动要做事"时的行为，
     *    定时任务半夜自己开浏览器不合适；
     * 3. **首见入快照**：某个会话第一次被看到时只记录不回复，防止把历史消息翻出来回一遍；
     * 4. **不叠轮**：上一轮没跑完（发送校验可能要等 8 秒回执）就跳过这一轮。
     * @param {number} [intervalMs] 轮询间隔（默认取 `web.autoReplyPollSec`）
     * @returns {void}
     */
    startAutoReply(intervalMs = 0) {
      if (autoReplyTimer !== null) return;
      // autoPeer：当前监听的会话；autoPrev：会话名 → 上次列表预览；
      // autoSent：会话名 → 最后一次发出的正文（用来把"自己发的"从预览变化里排除）。
      // 列表预览轮询让机器人不依赖"哪个会话恰好开着"——谁的预览变了就切给谁。
      let autoPeer = '';
      let autoPrev = {};
      let autoSent = {};
      let autoGroup = {};
      let autoTriggered = false;
      // 静默失败会让"没回复"变成悬案：2026-10-29 面板收起 + 判据误判，整晚零日志，
      // 只能手工探页面才知道卡在哪。所以"明明该干活却干不了"的分支都要留痕，
      // 同一原因 60 秒只报一次（轮询 10 秒一次，不节流会刷屏）。
      let quietKey = '';
      let quietAt = 0;
      const warnQuiet = (key, text) => {
        if (quietKey === key && Date.now() - quietAt < 60_000) return;
        quietKey = key;
        quietAt = Date.now();
        log.warn(text);
      };
      const tick = async () => {
        if (autoBusy) return;
        autoBusy = true;
        try {
          const cfg = service.getConfig();
          const w = cfg.web ?? {};
          if (w.autoReply !== true || w.allowAutoSend !== true) return;
          const st = await web.ensureOnline();
          if (!st.ok) {
            warnQuiet('offline', `自动回复暂停：网页通道不可用（${st.reason ?? '未知原因'}）`);
            return;
          }

          // ① 扫会话列表预览：预览变了且不是自己刚发的 → 把监听焦点切给那个会话
          const ls = await web.listConversations().catch(() => null);
          autoTriggered = false;
          if (ls?.ok !== true) {
            warnQuiet('list', `自动回复暂停：读不到会话列表（${ls?.reason ?? '调用异常'}）`);
          }
          if (ls?.ok === true && Array.isArray(ls.items)) {
            for (const conv of ls.items) {
              const name = String(conv.name ?? '');
              const last = String(conv.last ?? '');
              if (name === '' || last === '') continue;
              const prev = autoPrev[name];
              autoPrev[name] = last;
              if (prev === undefined || prev === last) continue;
              if (autoSent[name] !== undefined && last.includes(autoSent[name])) continue;
              autoPeer = name;
              autoTriggered = true;
            }
          }

          // ② 读焦点会话的入站气泡（列表触发过的会话此刻会被精确点开）
          const r = await web.readIncoming(autoPeer !== '' ? { to: autoPeer } : {}).catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
          if (r.ok !== true) {
            warnQuiet('read', `自动回复暂停：${r.reason ?? '读不到当前会话'}`);
            return;
          }
          const peer = r.to;
          autoPeer = peer;
          if (r.group !== undefined) autoGroup[peer] = r.group === true;

          // ③ 首见分级：被列表触发的（预览证实有新消息）只回最后一条、历史照常入快照；
          //    常规首见只快照不回复，防止把历史消息翻出来回一遍。
          let fresh;
          if (autoSeen[peer] === undefined) {
            if (autoTriggered === true && Array.isArray(r.incoming) && r.incoming.length > 0) {
              // 快照必须整段入账（含要回的那条），否则下一轮会把同一条再回一遍
              autoSeen[peer] = [...(r.incoming ?? [])];
              fresh = [r.incoming[r.incoming.length - 1]];
            } else {
              autoSeen[peer] = [...(r.incoming ?? [])];
              return;
            }
          } else {
            fresh = newIncoming(autoSeen[peer], r.incoming ?? []);
            if (fresh.length === 0) return;
            autoSeen[peer] = [...(autoSeen[peer] ?? []), ...fresh];
          }
          // 群聊仅监听：电脑端（网页/桌面客户端）发出的群消息其他成员收不到（平台投递
          // 策略，2026-10-28 真机对照），发出去等于白发——跳过回复但照常更新快照。
          if (autoGroup[peer] === true && w.replyGroups !== true) {
            if (fresh.length > 0) log.info(`群聊仅监听：${peer} 的 ${fresh.length} 条新消息不自动回复（web.replyGroups=false）`);
            return;
          }
          for (const t of fresh) {
            // 自动回复是全局单例（监听的是：当前打开的会话），没有"这只宠物"的概念：人设按主宠物借
            const composed = await composeReply({ peer, incoming: [...(r.incoming ?? [])] });
            if (composed.ok !== true) {
              // 只走大模型：生成不出来就不发（不留模板兜底），但照常记账，方便查是模型挂了还是没配
              if (cfg.behavior.recordAudit === true) {
                await store
                  .audit({ pet: 'auto', cap: 'dm', action: 'auto-reply', ok: false, detail: `${peer}「${t.slice(0, 30)}」→未生成：${composed.error ?? '未知原因'}` })
                  .catch(() => {});
              }
              log.warn(`自动回复跳过 ${peer}：未生成正文（${composed.error ?? '未知原因'}）`);
              continue;
            }
            const sr = await web.sendMessage({ to: peer, text: composed.text }).catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
            if (sr.ok === true) autoSent[peer] = composed.text;
            if (cfg.behavior.recordAudit === true) {
              await store
                .audit({ pet: 'auto', cap: 'dm', action: 'auto-reply', ok: sr.ok === true, detail: `${peer}「${t.slice(0, 30)}」→(${composed.via}) ${sr.ok === true ? '已核对' : sr.reason}` })
                .catch(() => {});
            }
            log.info(`自动回复 ${peer}（${composed.via}/${sr.method ?? 'enter'}）：${sr.ok === true ? `已发「${composed.text.slice(0, 30)}」` : `失败（${sr.reason}）`}`);
          }
        } catch (error) {
          log.warn(`自动回复轮询出错：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          autoBusy = false;
        }
      };
      const sec = intervalMs > 0 ? Math.round(intervalMs / 1000) : Number(service.getConfig().web.autoReplyPollSec) || 30;
      const ms = Math.max(10, sec) * 1000;
      autoReplyTimer = setInterval(() => void tick(), ms);
      if (typeof autoReplyTimer === 'object' && autoReplyTimer !== null) autoReplyTimer.unref?.();
      log.info(`自动回复已启动（每 ${Math.round(ms / 1000)} 秒查一次当前会话；双开关：web.autoReply + web.allowAutoSend）`);
    },

    /** 停所有定时器/轮询并清菜单。 @returns {Promise<void>} 完成 */
    async stop() {
      if (publishTimer !== null) clearInterval(publishTimer);
      if (autonomyTimer !== null) clearInterval(autonomyTimer);
      if (autoReplyTimer !== null) clearInterval(autoReplyTimer);
      publishTimer = null;
      autonomyTimer = null;
      autoReplyTimer = null;
      stopMenu?.();
      stopMenu = null;
      await pet.clearMenu();
      await pet.release();
    },

    /** 挂宿主能力探测器（入口注入——只有入口摸得到 cordis ctx） @param {() => Promise<any>} fn 探测器 */
    setProbeRunner(fn) {
      probeRunner = fn;
    },

    /** 挂宿主 LLM 适配器（入口注入；传 null 表示宿主没这服务） @param {any} adapter 适配器 */
    setHostLlm(adapter) {
      hostLlm = adapter ?? null;
    },

    /** 挂宿主人设取用函数（入口注入；真源在 pet，进程内直取。传 null 时退回 HTTP 兜底） @param {((petId: string) => string)|null} fn 取用函数 */
    setPersonaProvider(fn) {
      personaProvider = typeof fn === 'function' ? fn : null;
    },

    /**
     * 挂附件服务（入口注入；`ctx.get('attachments')` 软取）。
     *
     * 看图这条路要靠它把截下来的画面存成附件——模型消息里收的是 `attachmentId` 引用而不是裸字节。
     * 宿主没有这个服务时留 null：`scanFeed` 会退回"只读文案"，不报错、不假装看了图。
     * @param {any} sink 附件服务（需有 `saveImages`）
     * @returns {void}
     */
    setAttachments(sink) {
      attachments = sink !== null && typeof sink?.saveImages === 'function' ? sink : null;
    },

    /** 跑一次宿主能力探测；没挂探测器时如实说没有 @returns {Promise<any>} 结果 */
    async probe() {
      if (probeRunner === null) return { ok: false, reason: 'no probe runner' };
      return probeRunner();
    },
  };

  /**
   * 菜单分派：五项各自走对应能力；失败一律留日志（气泡可能关着/宠物可能不在）。
   * @param {string} label 菜单文案
   * @param {string} petId 宠物 id
   * @returns {Promise<void>} 完成
   */
  async function handleMenu(label, petId) {
    const cfg = service.getConfig();
    const p = cfg.pet;

    if (label === p.menuSettings) {
      await openUrl(service.pageUrl());
      return;
    }

    // 对话入口只负责把人送到输入框——绝不在后台"自己发一条出去"
    if (label === p.menuChat) {
      await openUrl(`${service.pageUrl()}#say`);
      return;
    }

    await status('working', label);
    try {
      if (label === p.menuPublish) {
        const r = await capabilities.publish({ pet: petId });
        lastPack = r.pack ?? lastPack;
        await status('success', '发布包好了');
        await say(`发布包做好了：「${r.pack?.caption?.title ?? ''}」`, { anim: p.animOnDone });
      } else if (label === p.menuFeed) {
        const r = await service.scanFeed({ pet: petId });
        if (r.ok !== true) throw new Error(r.reason ?? '刷推荐流失败了');
        await status('success', '刷完了');
        // notify 模式由 scanFeed 自己播报，这里只补另外两种的收尾
        if (r.mode === 'copy') {
          await say(r.copied?.ok ? '分享文案已复制，去粘贴吧' : '刷好了，但复制没成功', { anim: p.animOnDone });
        } else if (r.mode === 'dm') {
          await say(`已分享给「${r.sent?.to ?? ''}」`, { anim: p.animOnDone });
        }
      } else {
        // 认不出的菜单文案：不动手（旧版本残留的菜单项会走到这里）
        log.warn(`菜单「${label}」没有对应动作，忽略`);
      }
      clearStatusLater(12_000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`菜单「${label}」失败：${msg}`);
      await status('error', msg);
      await say(msg, { pet: petId });
      clearStatusLater(12_000);
    }
  }

  /**
   * 从旧的两个插件目录搬数据（只搬一次，不覆盖已有文件）。
   *
   * 旧布局：`$DSH_HOME/dsh-pet-douyin/{config.json,ledger.json,packs}` +
   *        `$DSH_HOME/dsh-pet-douyin-account/{config.json,accounts.json,grants.json,audit.json,usage.json}`
   * 新布局：全部并入 `$DSH_HOME/dsh-pet-douyin/`。
   * @returns {Promise<string[]>} 迁移过的项目
   */
  async function migrateLegacy(rawConfig) {
    const moved = [];
    const legacyDir = join(home, 'dsh-pet-douyin-account');
    // 1) 账号侧状态文件直接搬过来
    for (const [from, to] of [
      ['accounts.json', paths.accountsFile],
      ['grants.json', paths.grantsFile],
      ['audit.json', paths.auditFile],
      ['usage.json', paths.usageFile],
    ]) {
      const src = join(legacyDir, from);
      const dst = to;
      if (await existsFlag(dst)) continue;
      const data = await readJson(src, undefined);
      if (data === undefined) continue;
      const { writeJsonAtomic } = await import('./util.js');
      await writeJsonAtomic(dst, data);
      moved.push(from);
    }
    // 2) 配置合并
    const legacyCfg = await readJson(join(legacyDir, 'config.json'), undefined);
    const merged = { ...config };
    let touched = false;
    // 2a) 旧账号配置里的 app/dm/share（老包才有）
    if (legacyCfg !== null && typeof legacyCfg === 'object') {
      if (legacyCfg.app !== undefined && (merged.app.clientKey ?? '') === '') {
        merged.app = { ...merged.app, ...legacyCfg.app };
        touched = true;
      }
      if (legacyCfg.dm !== undefined) {
        merged.dm = { ...merged.dm, ...legacyCfg.dm };
        touched = true;
      }
      if (legacyCfg.share !== undefined) {
        merged.share = { ...merged.share, ...legacyCfg.share };
        touched = true;
      }
    }
    // 2b) 旧发布包配置里叫 pet.menuItem（如"分享到抖音"）；归一化会把它丢掉，所以从**原文**取。
    //     注意：这一段不能挂在 legacyCfg 存在与否上——旧账号目录可能根本没有 config.json。
    const legacyMenuItem = rawConfig?.pet?.menuItem ?? legacyCfg?.pet?.menuItem;
    if (typeof legacyMenuItem === 'string' && legacyMenuItem.trim() !== '') {
      merged.pet = { ...merged.pet, menuPublish: legacyMenuItem.trim() };
      touched = true;
    }
    if (touched) {
      const { normalizeConfig } = await import('./config.js');
      const normalized = normalizeConfig(merged).config;
      const { writeJsonAtomic } = await import('./util.js');
      await writeJsonAtomic(paths.configFile, normalized);
      config = normalized;
      moved.push('config（合并旧配置）');
    }
    return moved;
  }

  return service;
}

/**
 * 判断文件是否存在（迁移用，不关心内容）。
 * @param {string} file 路径
 * @returns {Promise<boolean>} 是否存在
 */
async function existsFlag(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 脱敏：只留前 4 后 4。
 * @param {string} s 原文
 * @returns {string} 脱敏结果
 */
export function mask(s) {
  const text = String(s ?? '');
  if (text.length <= 8) return text === '' ? '' : '****';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}
