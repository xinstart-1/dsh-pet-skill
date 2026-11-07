/**
 * 抖音客户端：授权（OAuth 扫码）与三个只读/半自动能力的 HTTP 封装。
 *
 * 三条硬原则：
 * 1. **不编接口。** 只实现官方文档里存在的端点；官方没有的能力（个人号私信）不假装能调，
 *    直接返回一句人话说明，让上层降级到「草稿 + 唤起 App」。
 * 2. **不吞错误。** 抖音的失败常常是 HTTP 200 + `data.error_code != 0`，必须解析出来，
 *    否则用户只会看到"空列表"而不知道是没权限。
 * 3. **可注入 fetch。** 单测与演示数据都靠这一点，不必真的连抖音。
 *
 * @module dsh-pet-douyin-account/douyin-client
 */

/** 抖音 OpenAPI 的默认基址 */
export const DEFAULT_BASE = 'https://open.douyin.com';

/** 各能力需要的 scope（用于"配了但没授权"时给出准确提示） */
export const SCOPE_OF = {
  videoList: 'video.list',
  videoData: 'video.data',
  userInfo: 'user_info',
};

/** 带业务错误码的异常：`code` 是抖音的 error_code，`detail` 是 description */
export class DouyinError extends Error {
  /**
   * @param {string} message 人话消息
   * @param {{code?: number, detail?: string, httpStatus?: number, endpoint?: string}} [info] 附加信息
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'DouyinError';
    this.code = info.code ?? 0;
    this.detail = info.detail ?? '';
    this.httpStatus = info.httpStatus ?? 0;
    this.endpoint = info.endpoint ?? '';
  }
}

/**
 * 拼授权页地址。这个页面本身就是"扫一扫"——用户用抖音 App 扫码确认后，
 * 浏览器会跳到 `redirectUri?code=...&state=...`。
 * @param {{clientKey: string, scopes: string[], redirectUri?: string, state?: string, base?: string}} opts 参数
 * @returns {string} 授权地址
 */
export function buildAuthorizeUrl({
  clientKey,
  scopes,
  redirectUri,
  state,
  base = 'https://open.douyin.com/platform/oauth/connect/',
}) {
  const url = new URL(base);
  url.searchParams.set('client_key', clientKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(','));
  if (typeof redirectUri === 'string' && redirectUri.trim() !== '')
    url.searchParams.set('redirect_uri', redirectUri.trim());
  if (typeof state === 'string' && state !== '') url.searchParams.set('state', state);
  return url.toString();
}

/**
 * 从回调地址里抠出 code（用户可能整条 URL 粘进来，也可能只粘 code）。
 * @param {string} input 回调 URL 或裸 code
 * @returns {string} code（抓不到返回空串）
 */
export function extractCode(input) {
  const text = String(input ?? '').trim();
  if (text === '') return '';
  if (!text.includes('://') && !text.includes('?')) return text;
  try {
    const url = new URL(text);
    return url.searchParams.get('code') ?? '';
  } catch {
    const m = /[?&]code=([^&]+)/.exec(text);
    return m === null ? '' : decodeURIComponent(m[1]);
  }
}

/**
 * scope 字符串是否包含某项（抖音返回的是空格或逗号分隔）。
 * @param {string} scopeText 授权返回的 scope
 * @param {string} need 需要的那项
 * @returns {boolean} 是否包含
 */
export function hasScope(scopeText, need) {
  const list = String(scopeText ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(need);
}

/**
 * 从抖音的各种返回形状里抽出错误码（HTTP 200 + error_code 才是常态）。
 * @param {any} json 响应体
 * @returns {{code: number, detail: string}} 错误信息（code 0 表示成功）
 */
export function readError(json) {
  const node =
    json !== null && typeof json === 'object' && json.data !== null && typeof json.data === 'object' ? json.data : json;
  const code = Number(node?.error_code ?? node?.err_no ?? 0);
  const detail = String(node?.description ?? node?.desc ?? json?.message ?? '');
  return { code: Number.isFinite(code) ? code : 0, detail };
}

/**
 * 建客户端。
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [deps] 依赖（单测注入）
 * @returns {object} 客户端
 */
export function createDouyinClient({ fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  /** 上一次外部请求时间，用于限速 */
  let lastAt = 0;
  /** 每个账号串行化，避免并发打到 QPS 上限 */
  let chain = Promise.resolve();

  /**
   * 发一个请求并解析。
   * @param {string} base OpenAPI 基址
   * @param {string} path 路径
   * @param {{method?: string, headers?: Record<string, string>, json?: any, form?: Record<string, string>, retryForm?: boolean}} opts 选项
   * @returns {Promise<any>} 解析后的 JSON
   */
  async function request(base, path, opts = {}) {
    const { method = 'GET', headers = {}, json, form, retryForm = false } = opts;
    const url = new URL(path, base).toString();

    /**
     * 发一次。**解析失败不抛**——要留给下面的重试逻辑处理
     * （有的网关在 400 时直接甩一段纯文本，先抛就永远走不到"改表单再来一次"）。
     * @param {string|undefined} payload 体
     * @param {string|undefined} contentType 类型
     * @returns {Promise<{res: Response, parsed: any, raw: string}>} 结果
     */
    const send = async (payload, contentType) => {
      const res = await doFetch(url, {
        method,
        headers: { ...headers, ...(contentType === undefined ? {} : { 'content-type': contentType }) },
        body: payload,
        signal: AbortSignal.timeout(20_000),
      });
      const raw = await res.text();
      let parsed = null;
      if (raw !== '') {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
      }
      return { res, parsed, raw };
    };

    const { res, parsed, raw } =
      json !== undefined
        ? await send(JSON.stringify(json), 'application/json')
        : form !== undefined
          ? await send(new URLSearchParams(form).toString(), 'application/x-www-form-urlencoded')
          : await send(undefined, undefined);

    const { code, detail } = parsed === null ? { code: 0, detail: '' } : readError(parsed);
    if (res.status >= 400 || code !== 0) {
      // 有的端点在 JSON 体上不认：改成表单再来一次（只对显式允许的调用，且只重试一次）
      if (retryForm && json !== undefined && res.status >= 400) {
        return request(base, path, { ...opts, json: undefined, form: toForm(json), retryForm: false });
      }
      const fallback = parsed === null ? `返回不是 JSON：${raw.slice(0, 120)}` : `抖音接口返回 HTTP ${res.status}`;
      throw new DouyinError(detail !== '' ? detail : `${fallback}（端点 ${path}）`, {
        code,
        detail: detail !== '' ? detail : raw.slice(0, 200),
        httpStatus: res.status,
        endpoint: path,
      });
    }
    if (parsed === null) {
      throw new DouyinError(`成功状态但返回不是 JSON（端点 ${path}）`, {
        httpStatus: res.status,
        endpoint: path,
        detail: raw.slice(0, 200),
      });
    }
    return parsed;
  }

  /** 限速：两次外部请求之间至少间隔 throttleMs */
  const throttle = async (ms) => {
    if (ms <= 0) return;
    const wait = lastAt + ms - now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = now();
  };

  /** 串行化包装，避免同一账号并发调用 */
  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  return {
    /**
     * 用授权码换 token。
     * @param {{base: string, clientKey: string, clientSecret: string, code: string, throttleMs?: number}} opts 参数
     * @returns {Promise<{accessToken: string, openId: string, expiresIn: number, refreshToken: string, refreshExpiresIn: number, scope: string, raw: any}>} token
     */
    exchangeCode(opts) {
      return serial(async () => {
        const { base, clientKey, clientSecret, code, throttleMs = 0 } = opts;
        await throttle(throttleMs);
        const json = await request(base, '/oauth/access_token/', {
          method: 'POST',
          json: { client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code' },
          retryForm: true,
        });
        const d = normalizeToken(json);
        if (d.accessToken === '' || d.openId === '')
          throw new DouyinError('授权成功但返回里没有 access_token / open_id', {
            detail: JSON.stringify(json).slice(0, 200),
          });
        return d;
      });
    },

    /**
     * 刷新 access_token（refresh_token 有效期更长，过期就真的得重扫）。
     * @param {{base: string, clientKey: string, refreshToken: string, throttleMs?: number}} opts 参数
     * @returns {Promise<object>} 新 token
     */
    refresh(opts) {
      return serial(async () => {
        const { base, clientKey, refreshToken, throttleMs = 0 } = opts;
        await throttle(throttleMs);
        const json = await request(base, '/oauth/refresh_token/', {
          method: 'POST',
          json: { client_key: clientKey, grant_type: 'refresh_token', refresh_token: refreshToken },
          retryForm: true,
        });
        return normalizeToken(json);
      });
    },

    /**
     * 取账号公开资料（昵称/头像/粉丝数）。
     * @param {{base: string, accessToken: string, openId: string, throttleMs?: number}} opts 参数
     * @returns {Promise<{openId: string, nickname: string, avatar: string, followerCount: number, followingCount: number, raw: any}>} 资料
     */
    userInfo(opts) {
      return serial(async () => {
        const { base, accessToken, openId, throttleMs = 0 } = opts;
        await throttle(throttleMs);
        const q = new URLSearchParams({ open_id: openId, access_token: accessToken });
        const json = await request(base, `/oauth/userinfo/?${q.toString()}`, {
          headers: { 'access-token': accessToken },
        });
        const d = json?.data ?? json ?? {};
        return {
          openId: String(d.open_id ?? openId),
          nickname: String(d.nickname ?? ''),
          avatar: pickUrl(d.avatar_larger ?? d.avatar_thumb ?? d.avatar),
          followerCount: Number(d.follower_count ?? 0) || 0,
          followingCount: Number(d.following_count ?? 0) || 0,
          raw: json,
        };
      });
    },

    /**
     * 列该账号发布过的作品（官方 video.list）。
     * 注意：这是**自己账号的作品**，不是抖音推荐流——推荐流没有公开接口。
     * @param {{base: string, accessToken: string, openId: string, cursor?: number, count?: number, throttleMs?: number}} opts 参数
     * @returns {Promise<{items: any[], cursor: number, hasMore: boolean, raw: any}>} 作品列表
     */
    videoList(opts) {
      return serial(async () => {
        const { base, accessToken, openId, cursor = 0, count = 10, throttleMs = 0 } = opts;
        await throttle(throttleMs);
        const q = new URLSearchParams({ open_id: openId, cursor: String(cursor), count: String(count) });
        const json = await request(base, `/api/douyin/v1/video/video_list/?${q.toString()}`, {
          headers: { 'access-token': accessToken },
        });
        const d = json?.data ?? {};
        const list = Array.isArray(d.list) ? d.list : [];
        return {
          items: list.map(normalizeItem),
          cursor: Number(d.cursor ?? 0) || 0,
          hasMore: d.has_more === true,
          raw: json,
        };
      });
    },
  };
}

/**
 * 对象转表单（重试路径用）。
 * @param {Record<string, any>} obj 对象
 * @returns {Record<string, string>} 表单
 */
function toForm(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = String(v);
  return out;
}

/**
 * 从各种形状里挑一个 URL：字符串 / `{url_list: []}` / `{url}`。
 * @param {any} node 节点
 * @returns {string} URL（没有则空串）
 */
export function pickUrl(node) {
  if (typeof node === 'string') return node.startsWith('http') ? node : '';
  if (node !== null && typeof node === 'object') {
    if (Array.isArray(node.url_list) && typeof node.url_list[0] === 'string') return node.url_list[0];
    if (typeof node.url === 'string') return node.url;
    if (Array.isArray(node.uri_list) && typeof node.uri_list[0] === 'string') return node.uri_list[0];
  }
  return '';
}

/**
 * token 返回归一化。
 * @param {any} json 响应
 * @returns {{accessToken: string, openId: string, expiresIn: number, refreshToken: string, refreshExpiresIn: number, scope: string, raw: any}} token
 */
export function normalizeToken(json) {
  const d = json?.data ?? json ?? {};
  return {
    accessToken: String(d.access_token ?? ''),
    openId: String(d.open_id ?? ''),
    expiresIn: Number(d.expires_in ?? 0) || 0,
    refreshToken: String(d.refresh_token ?? ''),
    refreshExpiresIn: Number(d.refresh_expires_in ?? 0) || 0,
    scope: String(d.scope ?? ''),
    raw: json,
  };
}

/**
 * 作品归一化：只留 UI 与分享需要的那几个字段，大小写/嵌套都兜住。
 * @param {any} raw 抖音返回的一条
 * @returns {object} 归一化后的作品
 */
export function normalizeItem(raw) {
  const item = raw !== null && typeof raw === 'object' ? raw : {};
  const stat = item.statistics !== null && typeof item.statistics === 'object' ? item.statistics : {};
  const id = String(item.item_id ?? item.aweme_id ?? item.video_id ?? '');
  return {
    itemId: id,
    title: String(item.title ?? item.desc ?? '').trim(),
    cover: pickUrl(item.cover),
    shareUrl: String(item.share_url ?? item.shareUrl ?? ''),
    createTime: Number(item.create_time ?? 0) || 0,
    isTop: item.is_top === true,
    status: String(item.video_status ?? ''),
    stats: {
      play: Number(stat.play_count ?? 0) || 0,
      digg: Number(stat.digg_count ?? 0) || 0,
      comment: Number(stat.comment_count ?? 0) || 0,
      share: Number(stat.share_count ?? 0) || 0,
    },
  };
}
