/**
 * 能力层：浏览 / 分享 / 私信草稿。
 *
 * 每个能力入口都做三件事，顺序不能变：
 * 1. **过授牌**（`store.checkGrant`）——这是唯一闸门，没授牌一律拒绝，并记审计；
 * 2. 调抖音（或本地生成），失败把抖音的原始错误码翻成人话；
 * 3. 写审计（谁、哪只宠物、做了什么、成没成）。
 *
 * 私信这块必须说清楚：官方对个人号**没有**发送接口，唯一通道是企业号客服私信
 * （认证企业号 + 应用过审 + 日耗门槛），本项目不实现、也不走逆向。所以这里只产出
 * "草稿 + 唤起 App"，把最后一步交给用户点。`dmSendSupported()` 会如实返回原因，
 * 上层据此决定按钮文案——不假装能发。
 *
 * @module dsh-pet-douyin-account/capabilities
 */
import { CAP_LABEL } from './store.js';
import { SCOPE_OF, hasScope, pickUrl } from './douyin-client.js';
import { parseRecommendList } from './feed.js';
import { copyToClipboard, douyinAppInstalled, openUrl } from './util.js';

/** 打开抖音 App 首页的 scheme（私信入口在 App 里） */
export const DOUYIN_APP = 'snssdk1128://';

/** 网页版消息页：没装客户端时的兜底入口（需浏览器已登录 douyin.com） */
export const DOUYIN_CHAT = 'https://www.douyin.com/chat';

/** 抖音主页（推荐流只做跳转，不抓内容） */
export const DOUYIN_WEB = 'https://www.douyin.com/';

/**
 * 数字变人话（1.2万 / 3.4亿），播报与卡片都用。
 * @param {number} n 数字
 * @returns {string} 文本
 */
export function humanCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}

/**
 * 时间戳 → `YYYY-MM-DD`。
 * @param {number} sec 秒级时间戳
 * @returns {string} 日期（0 返回空串）
 */
export function dayOf(sec) {
  const n = Number(sec) || 0;
  if (n <= 0) return '';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 建能力集合。
 * @param {{getConfig: () => any, store: any, client: any, ensureToken: () => Promise<any>, log: any, copy?: Function, packer?: any, web?: any}} deps 依赖
 * @returns {object} 能力
 */
export function createCapabilities({
  getConfig,
  store,
  client,
  ensureToken,
  log,
  copy = copyToClipboard,
  packer,
  web,
}) {
  /** 作品列表缓存：`{openId, at, data}` */
  let cache = null;

  /**
   * 统一的能力包装：授牌 → 配额 → 绑定账号 → 执行 → 记账 → 审计。
   *
   * 顺序是刻意的：配额要在**动手之前**查，否则会白花一次调用才发现超额；
   * 记账只在成功后做，失败不该吃掉今天的额度。
   * @param {'browse'|'share'|'dm'} cap 能力
   * @param {string} pet 宠物 id
   * @param {(account: any|null) => Promise<any>} fn 真正干活（`dm` 这类本地生成拿 null）
   * @param {{needAccount?: boolean}} [opts] 选项
   * @returns {Promise<any>} 结果（失败抛带 `code` 的错误）
   */
  async function guarded(cap, pet, fn, opts = {}) {
    const { needAccount = true } = opts;
    const gate = store.checkGrant(pet, cap);
    if (!gate.ok) {
      const err = new Error(gate.reason ?? '没有权限');
      // @ts-expect-error 自定义标记，路由据此返回 403
      err.code = 'no-grant';
      if (getConfig().behavior.recordAudit)
        await store.audit({ pet, cap, action: cap, ok: false, detail: gate.reason });
      throw err;
    }

    const quota = store.checkQuota(pet, cap);
    if (!quota.ok) {
      const err = new Error(quota.reason ?? '配额用完');
      // @ts-expect-error 自定义标记，路由据此返回 429
      err.code = 'quota';
      if (getConfig().behavior.recordAudit) {
        await store.audit({ pet, cap, action: cap, ok: false, detail: `${quota.reason}（上限 ${quota.limit}）` });
      }
      throw err;
    }

    try {
      // 取 token 也放进 try：没绑账号 / token 过期同样是「这次调用失败」，
      // 必须进审计——否则气泡关掉（或桌宠没在线）时用户什么线索都看不到
      const account = needAccount ? await ensureToken({ openId: store.bindOf(pet) }) : null;
      const result = await fn(account);
      await store.recordUse(pet, cap);
      if (getConfig().behavior.recordAudit) {
        await store.audit({
          pet,
          cap,
          action: cap,
          ok: true,
          account: account?.openId ?? '',
          detail: summarize(cap, result),
        });
      }
      return result;
    } catch (error) {
      if (getConfig().behavior.recordAudit) {
        await store.audit({
          pet,
          cap,
          action: cap,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * 审计里那行摘要：别把整份数据塞进去。
   * @param {string} cap 能力
   * @param {any} result 结果
   * @returns {string} 摘要
   */
  function summarize(cap, result) {
    if (cap === 'browse') return `列出 ${result.items?.length ?? 0} 条作品`;
    if (cap === 'share') return `分享「${(result.title ?? '').slice(0, 20)}」`;
    if (cap === 'dm') return `草稿 ${(result.text ?? '').length} 字`;
    if (cap === 'publish') return `生成发布包「${(result.pack?.caption?.title ?? '').slice(0, 20)}」`;
    return '';
  }

  /**
   * 取作品列表（带缓存与 scope 检查）。
   * @param {any} account 已经解析好的账号（含明文 token）
   * @param {{force?: boolean}} [opts] 选项
   * @returns {Promise<{items: any[], account: any, cached: boolean, scopeOk: boolean, hint?: string}>} 列表
   */
  async function loadVideos(account, opts = {}) {
    const config = getConfig();
    const token = account;
    const scopeOk = token.scope === '' ? true : hasScope(token.scope, SCOPE_OF.videoList);
    const fresh =
      cache !== null && cache.openId === token.openId && Date.now() - cache.at < config.behavior.cacheSec * 1000;
    if (opts.force !== true && fresh) {
      return { items: cache.data.items, account: token, cached: true, scopeOk };
    }
    if (!scopeOk) {
      return {
        items: [],
        account: token,
        cached: false,
        scopeOk: false,
        hint: `授权里没有 ${SCOPE_OF.videoList}（当前：${token.scope || '空'}）——去开放平台补申请后重新扫码`,
      };
    }
    const res = await client.videoList({
      base: config.app.apiBase,
      accessToken: token.accessToken,
      openId: token.openId,
      count: config.behavior.browseCount,
      throttleMs: config.behavior.throttleMs,
    });
    cache = { openId: token.openId, at: Date.now(), data: res };
    return { items: res.items, account: token, cached: false, scopeOk: true };
  }

  return {
    /**
     * 浏览：列自己账号的作品。推荐流没有接口，只能跳转（见 openFeed）。
     * @param {{pet: string, force?: boolean}} args 参数
     * @returns {Promise<object>} 结果
     */
    browse: ({ pet, force = false }) =>
      guarded('browse', pet, async (account) => {
        const res = await loadVideos(account, { force });
        const latest = res.items[0];
        return {
          ok: true,
          pet,
          items: res.items,
          count: res.items.length,
          cached: res.cached,
          scopeOk: res.scopeOk,
          hint: res.hint ?? '',
          summary:
            latest === undefined
              ? '这个账号还没有可读的作品'
              : `最新一条「${latest.title || '未命名'}」· 播放 ${humanCount(latest.stats.play)} / 赞 ${humanCount(latest.stats.digg)}`,
          account: { nickname: res.account.nickname ?? '', openId: res.account.openId },
        };
      }),

    /**
     * 分享：生成分享卡（标题 + 链接 + 话题），复制并可选打开分享页。
     * 官方「分享至抖音私信/群」需要单独申请 scope，这里不硬依赖——分享卡在任何情况下都能用。
     * @param {{pet: string, itemId?: string, open?: boolean}} args 参数
     * @returns {Promise<object>} 结果
     */
    share: ({ pet, itemId, open = false }) =>
      guarded('share', pet, async (account) => {
        const config = getConfig();
        const res = await loadVideos(account, {});
        const item =
          itemId !== undefined && itemId !== '' ? res.items.find((it) => it.itemId === itemId) : res.items[0];
        if (item === undefined)
          throw new Error(
            itemId ? `没找到作品 ${itemId}（可能不在最近 ${res.items.length} 条里）` : '这个账号没有可分享的作品',
          );

        const text = config.share.template
          .replace(/\{title\}/g, item.title || '未命名作品')
          .replace(/\{url\}/g, item.shareUrl || '')
          .replace(/\{tags\}/g, '')
          .trim();
        let copied = { ok: false, reason: '未开启自动复制' };
        if (config.share.copyOnShare) copied = await copy(text);
        let opened = false;
        if (open && item.shareUrl !== '') opened = (await openUrl(item.shareUrl)).ok;

        return {
          ok: true,
          pet,
          itemId: item.itemId,
          title: item.title,
          url: item.shareUrl,
          text,
          copied,
          opened,
          // 明确告诉上层：真正的"分享到私信"要走官方 scope，这里只是分享卡
          note: '这是分享卡（文字 + 链接）。直接分享到抖音私信/群需要「分享至抖音私信/群」权限，目前未申请。',
        };
      }),

    /**
     * 私信：生成草稿 + 复制 + 可选唤起抖音 App。
     * 不发送——个人号没有官方发送接口；企业号客服通道需资质，本项目不实现。
     * @param {{pet: string, topic?: string, to?: string, openApp?: boolean}} args 参数
     * @returns {Promise<object>} 结果
     */
    dm: ({ pet, topic = '', to = '', openApp = false }) =>
      guarded(
        'dm',
        pet,
        async () => {
          const config = getConfig();
          const lines = [];
          if (config.dm.greeting.trim() !== '') lines.push(config.dm.greeting.trim());
          const body = String(topic ?? '').trim();
          if (body !== '') lines.push(body);
          else lines.push(`（${config.dm.tone}，你想聊什么就写在这）`);
          if (config.dm.signature.trim() !== '') lines.push(config.dm.signature.trim());
          const text = lines.join('\n\n');

          const copied = await copy(text);

          // 打开入口要分两种：装了客户端走 scheme，没装就走网页版消息页。
          // `spawn` 成功不等于"打开了"——所以不能只看 openUrl 的 ok。
          let openedVia = '';
          let openNote = '';
          if (openApp) {
            const hasApp = await douyinAppInstalled();
            const target = hasApp ? DOUYIN_APP : DOUYIN_CHAT;
            const r = await openUrl(target);
            if (r.ok) {
              openedVia = hasApp ? 'app' : 'web';
              if (!hasApp) openNote = '本机没检测到抖音客户端，已改开网页版消息页（需要浏览器里已登录 douyin.com）';
            } else {
              openNote = `打开失败：${r.reason ?? '未知原因'}`;
            }
          }

          return {
            ok: true,
            pet,
            to: String(to ?? ''),
            text,
            copied,
            opened: openedVia !== '',
            openedVia,
            openNote,
            channel: 'draft',
            steps: [
              openedVia === 'app'
                ? '抖音客户端已唤起，切到「消息」'
                : openedVia === 'web'
                  ? '浏览器已打开抖音消息页'
                  : '自己打开抖音（App 或 douyin.com）',
              to === '' ? '在「消息」里找到要回复的会话' : `在「消息」里找到「${to}」`,
              '粘贴（草稿已复制到剪贴板），确认措辞后自己点发送',
            ],
            note: dmSendSupported().reason,
          };
        },
        { needAccount: false },
      ),

    /**
     * 做发布包：扫目录 → 转 9:16 → 出发布包（video/文案/说明/封面）。
     *
     * 这是"出站"那一半，**不需要账号 token**——所以 `needAccount: false`：
     * 你就算没有 client_key，也能只授这项能力给宠物让它帮你整理素材。
     * 但仍然要过授牌与配额，否则宠物能把磁盘刷满。
     * @param {{pet: string, file?: string}} args 参数
     * @returns {Promise<object>} 结果
     */
    publish: ({ pet, file }) => {
      if (packer === undefined) throw new Error('发布包模块未装配');
      return guarded(
        'publish',
        pet,
        async () => {
          const r = await packer.prepare({ file, reason: '宠物发起' });
          if (r.ok !== true) {
            const err = new Error(r.reason ?? '没能生成发布包');
            throw err;
          }
          return r;
        },
        { needAccount: false },
      );
    },

    /**
     * 打开推荐流：只做跳转，不抓内容（官方没有推荐流接口）。
     * @param {{pet: string, app?: boolean}} args 参数
     * @returns {Promise<object>} 结果
     */
    openFeed: ({ pet, app = false }) =>
      guarded(
        'browse',
        pet,
        async () => {
          const target = app ? DOUYIN_APP : DOUYIN_WEB;
          const r = await openUrl(target);
          return { ok: r.ok, pet, url: target, note: '推荐流没有公开接口，这里只打开页面，不读取任何内容。' };
        },
        { needAccount: false },
      ),

    /**
     * 刷一刷推荐流（网页通道，只读、不发任何消息）。
     *
     * 复用 `browse` 的授牌与配额：它和"看作品"是同一类事，单独开一套额度
     * 只会让用户在两个地方各勾一次。`needAccount: false`——网页通道不依赖开放平台 token。
     * @param {{pet: string, limit?: number}} args 参数
     * @returns {Promise<object>} `{ok, pet, items, total, opened}`
     */
    feed: ({ pet, limit }) =>
      guarded(
        'browse',
        pet,
        async () => {
          if (web === undefined) throw new Error('网页通道未装配');
          const r = await web.readFeed({ limit });
          if (r.ok !== true) throw new Error(r.reason ?? '刷推荐流失败');
          const items = parseRecommendList(r.items);
          return { ok: true, pet, items, total: items.length, opened: r.opened === true };
        },
        { needAccount: false },
      ),

    /** 清掉作品缓存（改了 scope 或换号后调）。 @returns {void} */
    clearCache() {
      cache = null;
    },

    /** @returns {Promise<object>} 当前账号的作品列表（内部复用，不校验授牌） */
    async peek(account) {
      const acc = account ?? (await ensureToken({}));
      return loadVideos(acc, {});
    },
  };
}

/**
 * 官方私信发送在此项目里是否可用。
 *
 * 结论固定在代码里，避免 UI 上出现"看起来能发"的按钮：
 * 个人抖音号**没有任何**官方私信接口；企业号客服私信（im.direct_message）需要
 * 认证企业号 + 应用正式上线 + 权限审核 + 日耗门槛，且只能被动回复。
 * @returns {{supported: false, reason: string}} 固定结果
 */
export function dmSendSupported() {
  return {
    supported: false,
    reason:
      '个人抖音号没有官方私信发送接口；企业号客服私信需认证企业号 + 应用过审 + 日耗门槛，本项目未实现也不会走逆向。所以这里只给草稿，发送由你手动点。',
  };
}

/**
 * 从作品里挑一张封面（有的返回里封面在 `cover` 之外）。
 * @param {any} item 作品
 * @returns {string} URL
 */
export function coverOf(item) {
  return pickUrl(item?.cover) || pickUrl(item?.cover_original);
}

/** 能力中文名（路由/UI 复用） */
export { CAP_LABEL };
