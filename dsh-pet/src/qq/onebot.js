/**
 * OneBot v11 客户端：一条正向 WebSocket 收事件，调用走 WS（没配 HTTP 就全走 WS）。
 *
 * 边界写死在这里的几条：
 * 1. **对话链路只连接，不登录、不注入**。网关（NapCat / LLBot / SnowLuma）由用户自己装、
 *    自己登录，本模块只往它的正向 WebSocket 上说话，不替你点协议。那条线越过去就是
 *    "替你承担封号风险"。（「装网关」是另一件事，在 `napcat.js`：它只是把 NapCat 官方
 *    安装器跑完，QQ 与网关都解压成插件目录下的便携副本。）
 * 2. **连上先核对身份**：`get_login_info` 拿到的号与配置里的机器人号不一致时，
 *    只进「身份不符」状态、不自动回话。发错号的代价是别人看到你没说过的话。
 * 3. **调用超时一定释放**：OneBot 的 echo 是唯一的回执凭据，等不到就报错，不猜成功。
 * 4. **断线退避重连**：1×、2×…最多 60 秒一次。不做"疯狂重连"，那只会把网关拖死。
 *
 * 认证：浏览器规范的 WebSocket 构造函数不支持自定义头，所以令牌走 `?access_token=`——
 * OneBot v11 的通用写法，NapCat / LLBot / SnowLuma 都认。
 *
 * @module dsh-pet-qq/onebot
 */
import { normalizeEvent } from './message.js';

/** 认证令牌支持的 query 参数名（OneBot v11 通用） */
const TOKEN_PARAM = 'access_token';

/**
 * 把事件里的流式负载变成字符串（ws 库给 string/Buffer，浏览器规范给 Blob/ArrayBuffer）。
 * @param {any} data 原始负载
 * @returns {Promise<string>} 文本
 */
async function payloadText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  if (data !== null && typeof data === 'object' && typeof data.toString === 'function') {
    const s = data.toString('utf8');
    return typeof s === 'string' ? s : '';
  }
  return String(data ?? '');
}

/**
 * 建客户端。**不会自己连**——`open()` 之后才连，`close()` 之后彻底停。
 * @param {{log: object, fetchImpl?: typeof fetch, now?: () => number}} deps 依赖
 * @returns {object} 客户端
 */
export function createOneBot({ log, fetchImpl = fetch, now = () => Date.now() }) {
  /** @type {{wsUrl: string, token: string, httpUrl: string, reconnectSec: number}} */
  let opts = { wsUrl: '', token: '', httpUrl: '', reconnectSec: 5 };
  /** @type {any} */
  let ws = null;
  /** `idle` 未开始 / `connecting` 连接中 / `online` 在线 / `offline` 断线重连中 / `error` 出错 / `closed` 已停 */
  let state = 'idle';
  let lastError = '';
  let selfId = '';
  let nickname = '';
  let attempts = 0;
  let stopped = true;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let reconnectTimer = null;
  /** @type {((ev: any) => void)|null} */
  let eventSink = null;
  /** @type {((s: any) => void)|null} */
  let statusSink = null;
  /** echo → {resolve, reject, timer} */
  const pending = new Map();
  let echoSeq = 0;
  let lastEventAt = 0;
  let received = 0;
  let sent = 0;
  /** 身份核对结果：`unknown` / `ok` / `mismatch` */
  let identity = 'unknown';

  /** 带令牌的 WS 地址 */
  function dialUrl() {
    const base = String(opts.wsUrl ?? '').trim();
    if (base === '') return '';
    try {
      const u = new URL(base);
      if (opts.token !== '') u.searchParams.set(TOKEN_PARAM, opts.token);
      return u.toString();
    } catch {
      return '';
    }
  }

  /** 状态快照 */
  function snapshot() {
    return {
      state,
      ok: state === 'online',
      url: opts.wsUrl,
      httpFallback: opts.httpUrl !== '',
      selfId,
      nickname,
      identity,
      attempts,
      lastError,
      lastEventAt,
      received,
      sent,
      at: now(),
    };
  }

  /** 改状态并通知上层（上层据此刷新设置页） */
  function setState(next, error = '') {
    state = next;
    if (error !== '') lastError = error;
    try {
      statusSink?.(snapshot());
    } catch {
      /* 上层回调出错不该影响连接 */
    }
  }

  /**
   * 断线重连（指数退避，最多 60 秒）。
   *
   * 刷屏守则：每次都往控制台写一行，宿主会把它收进 stderr 环形缓冲，量一大就把
   * 真正有用的错误挤出 64KB 尾巴（实测：网关没装时 30 秒一条刷了几百行，把 DSH
   * 崩溃日志里其他插件的真实报错全顶没了）。所以只在**第 1、2、3 次以及之后每
   * 30 条**写一行提醒，其余次数只悄悄重试，不碰控制台。
   */
  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const base = Math.max(1, Number(opts.reconnectSec) || 5) * 1000;
    const delay = Math.min(base * Math.min(6, attempts), 60_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void dial();
    }, delay);
    if (typeof reconnectTimer === 'object' && reconnectTimer !== null) reconnectTimer.unref?.();
    const quiet = attempts > 3 && attempts % 30 !== 0;
    if (!quiet) log.warn(`${Math.round(delay / 1000)} 秒后重连（第 ${attempts} 次失败）`);
  }

  /** 打开连接池里的挂起调用全部失败——不能让调用方永远等 */
  function rejectPending(reason) {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
    pending.clear();
  }

  /**
   * 发一个 API 调用（WS 优先，未连接时退回 HTTP）。
   * @param {string} action OneBot 动作名
   * @param {object} [params] 参数
   * @param {number} [timeoutMs] 超时
   * @returns {Promise<any>} 响应里的 `data`
   */
  async function call(action, params = {}, timeoutMs = 15_000) {
    if (ws !== null && ws.readyState === 1) return callWs(action, params, timeoutMs);
    if (opts.httpUrl !== '') return callHttp(action, params, timeoutMs);
    throw new Error(`QQ 网关未连接（${action}）`);
  }

  /** 走 WS + echo 等回执 */
  function callWs(action, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const echo = `q${(echoSeq += 1)}`;
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`${action} 超时（${Math.round(timeoutMs / 1000)} 秒没有回执）`));
      }, timeoutMs);
      if (typeof timer === 'object' && timer !== null) timer.unref?.();
      pending.set(echo, {
        resolve: (data) => {
          sent += 1;
          resolve(data);
        },
        reject,
        timer,
      });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(echo);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 走 HTTP（网关没开 WS 或 WS 正好断着时） */
  async function callHttp(action, params, timeoutMs) {
    const res = await fetchImpl(`${opts.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token === '' ? {} : { authorization: `Bearer ${opts.token}` }),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${action} 返回的不是 JSON（HTTP ${res.status}）`);
    }
    const code = Number(body?.retcode ?? 0);
    if (body?.status === 'failed' || (Number.isFinite(code) && code !== 0)) {
      throw new Error(String(body?.wording ?? body?.message ?? `retcode ${code}`));
    }
    sent += 1;
    return body?.data ?? null;
  }

  /** 连上后核对登录的号：不是机器人号就停在身份不符（不自动回话） */
  async function hello() {
    try {
      const info = await call('get_login_info', {}, 8_000);
      selfId = String(info?.user_id ?? '').trim();
      nickname = String(info?.nickname ?? '').trim();
      identity = 'ok';
      log.info(`QQ 网关已连上：${nickname || '（无昵称）'}（${selfId || '未知号'}）`);
      setState('online');
      try {
        statusSink?.(snapshot());
      } catch {
        /* 忽略 */
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn(`连上了但拿不到登录信息：${lastError}`);
      setState('error', lastError);
    }
  }

  /** 收到一条 WS 消息 */
  async function handlePayload(data) {
    const text = await payloadText(data);
    if (text === '') return;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    if (raw === null || typeof raw !== 'object') return;

    // 回执：优先于一切（它是唯一能证明"这次调用成没成"的东西）
    if (raw.echo !== undefined && pending.has(String(raw.echo))) {
      const item = pending.get(String(raw.echo));
      pending.delete(String(raw.echo));
      clearTimeout(item.timer);
      const code = Number(raw.retcode ?? 0);
      if (raw.status === 'failed' || (Number.isFinite(code) && code !== 0)) {
        item.reject(new Error(String(raw.wording ?? raw.message ?? `retcode ${code}`)));
      } else {
        item.resolve(raw.data ?? null);
      }
      return;
    }

    if (raw.post_type === 'meta_event') {
      const reported = String(raw.self_id ?? '').trim();
      if (reported !== '' && selfId === '' && raw.meta_event_type === 'lifecycle') {
        selfId = reported;
        void hello();
      }
      return;
    }

    if (raw.post_type === 'message' || raw.post_type === 'message_sent') {
      received += 1;
      lastEventAt = now();
      const ev = normalizeEvent(raw);
      if (ev !== null && raw.post_type === 'message') {
        try {
          eventSink?.(ev);
        } catch (error) {
          log.warn(`处理消息出错：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }
  }

  /** 真正拨号 */
  async function dial() {
    if (stopped) return;
    const target = dialUrl();
    if (target === '') {
      setState('error', 'WS 地址不合法（要 ws:// 或 wss:// 开头）');
      return;
    }
    setState('connecting');
    // 只认运行时自带的 WebSocket：Node 22+ / Electron 主进程都有（抖音的 CDP 通道也靠它）。
    // 不引 `ws` 包——多一个运行时依赖就多一处装不上，而这里并不需要它。
    const Ctor = typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null;
    if (Ctor === null) {
      setState('error', '当前运行时没有 WebSocket（需要 Node 22+）');
      return;
    }
    /** @type {any} */
    let sock;
    try {
      sock = new Ctor(target);
    } catch (error) {
      attempts += 1;
      setState('offline', error instanceof Error ? error.message : String(error));
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.addEventListener('open', () => {
      attempts = 0;
      lastError = '';
      setState('online');
      void hello();
    });
    sock.addEventListener('message', (event) => {
      void handlePayload(event?.data);
    });
    sock.addEventListener('error', () => {
      // 错误本身不带可用信息，真正的收尾在 close 里做
      lastError = lastError === '' ? 'WebSocket 出错（网关没开或地址/令牌不对）' : lastError;
    });
    sock.addEventListener('close', (event) => {
      ws = null;
      if (stopped) {
        setState('closed');
        return;
      }
      attempts += 1;
      identity = 'unknown';
      const why = lastError !== '' ? lastError : `连接被关闭（code ${event?.code ?? '?'}）`;
      setState('offline', why);
      rejectPending('连接断开，调用未完成');
      scheduleReconnect();
    });
  }

  /** 停掉连接（不再重连）。 */
  function closeInternal() {
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    rejectPending('已断开');
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        /* 已经关了 */
      }
      ws = null;
    }
    if (state !== 'idle') setState('closed');
  }

  return {
    /**
     * 开始连接（重复调用会先停旧的）。
     * @param {{wsUrl: string, token?: string, httpUrl?: string, reconnectSec?: number, onEvent?: (ev: any) => void, onStatus?: (s: any) => void}} args 参数
     * @returns {void}
     */
    open(args) {
      closeInternal();
      opts = {
        wsUrl: String(args?.wsUrl ?? '').trim(),
        token: String(args?.token ?? '').trim(),
        httpUrl: String(args?.httpUrl ?? '')
          .trim()
          .replace(/\/+$/, ''),
        reconnectSec: Number(args?.reconnectSec) > 0 ? Number(args.reconnectSec) : 5,
      };
      eventSink = typeof args?.onEvent === 'function' ? args.onEvent : null;
      statusSink = typeof args?.onStatus === 'function' ? args.onStatus : null;
      stopped = false;
      attempts = 0;
      lastError = '';
      selfId = '';
      nickname = '';
      identity = 'unknown';
      void dial();
    },

    /** 停掉连接（不再重连）。 */
    close() {
      closeInternal();
    },

    /** 现在是不是能发消息。 */
    isOnline() {
      return state === 'online' && ws !== null && ws.readyState === 1;
    },

    /** 登录号（`get_login_info` 拿到的）。 */
    login() {
      return { selfId, nickname, identity };
    },

    /**
     * 核对配置里的机器人号；不一致就把 identity 标成 mismatch（上层据此不回话）。
     * @param {string} expected 配置里的号
     * @returns {{ok: boolean, selfId: string, nickname: string, reason?: string}} 结果
     */
    verifySelf(expected) {
      const want = String(expected ?? '').trim();
      if (want === '' || selfId === '') {
        identity = 'unknown';
        return {
          ok: true,
          selfId,
          nickname,
          reason: want === '' ? '没配机器人号，按网关自报的号工作' : '还没拿到登录信息',
        };
      }
      if (want !== selfId) {
        identity = 'mismatch';
        return { ok: false, selfId, nickname, reason: `网关登录的是 ${selfId}，不是配置里的 ${want}` };
      }
      identity = 'ok';
      return { ok: true, selfId, nickname };
    },

    call,

    /**
     * 发消息（私聊或群聊）。
     * @param {{kind: 'private'|'group', peerId: string, message: any[], autoEscape?: boolean}} args 参数
     * @returns {Promise<any>} 网关返回
     */
    send({ kind, peerId, message, autoEscape = false }) {
      const to = String(peerId ?? '').trim();
      if (to === '') throw new Error('收件人为空');
      if (kind === 'group')
        return call('send_group_msg', { group_id: Number(to) || to, message, auto_escape: autoEscape });
      return call('send_private_msg', { user_id: Number(to) || to, message, auto_escape: autoEscape });
    },

    /** 状态快照。 */
    status: snapshot,
  };
}
