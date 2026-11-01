/**
 * 网页通道：复用"已经扫码登录的那个 Chromium 系浏览器"（Edge / Ego Lite），读会话、发私信。
 *
 * 四条边界，写死在这里，不留给调用方决定：
 * 1. **默认只读 + 导航**。读会话、翻页面随便；但**发送**只有 `allowAutoSend` 开着才做，
 *    且发送是单发的（不重试）——重试是重复发消息的主要来源。
 * 2. **发送必须带回执**。文字写进输入框要读回比对；按了发送后要在消息气泡或
 *    会话预览里看到这段文字才算成功，看不到就如实报失败，绝不假装成功。
 *    （气泡选择器用 `[class*="MessageItemText"]`；`body.innerText` 会把输入框
 *    内容也算进去，是假阳性，不能用。）
 * 3. **不接管凭据**。登录态留在那个浏览器的 profile 里，插件不读 cookie 值、
 *    不导出、不转发。这里唯一碰 cookie 的地方是"数名字"判断登录没登录。
 * 4. **连不上就自己拉**。CDP 端口没人听时，按 `web.browserPath` 拉起专用浏览器
 *    （独立 profile，`web.autoLaunch` 可关）。拉不起来就如实返回 `{ok:false, reason}`。
 *
 * 协议：CDP over WebSocket。Node 22 自带 WebSocket，所以这层零依赖。
 *
 * @module dsh-pet-douyin/webchan
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 单条 CDP 命令的超时（毫秒） */
const CDP_TIMEOUT = 20_000;

/** 页面渲染等待：抖音是 SPA，6 秒以下的观察基本都会读到空壳 */
const RENDER_WAIT = 6_500;

/** 登录态的可靠判据。`passport_csrf_token` 未登录时也有，不能算。 */
const LOGIN_COOKIES = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt'];

/**
 * 推荐流地址（全屏竖滑播放器）。
 *
 * 实测：裸 `?recommend=1` 有一次被 302 到 `/jingxuan`（精选卡片墙，结构完全不同），
 * 带 `from_nav=1` 才稳定停在推荐页——所以这里固定用带 from_nav 的地址，
 * 并且"复用已有标签"也按 `recommend=1` 匹配，避免误用精选页。
 */
const FEED_URL = 'https://www.douyin.com/?recommend=1&from_nav=1';

/** 推荐流数据接口（实测路径；tab / module 两种都见过） */
const FEED_API_RE = /\/aweme\/v1\/web\/(?:tab|module)\/feed/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 页面内复用的辅助片段（拼进每个 `(() => { ... })()` 的开头）。
 *
 * 两件事，都是踩过的坑：
 *
 * 1. **`visible` 必须参与判据**。抖音把**未展开**的消息面板 DOM 也挂在页面上，
 *    容器尺寸 0×0。只数 `querySelectorAll('[data-e2e="conversation-item"]').length`
 *    会把"面板没开"读成"面板开着"，于是 `ensurePanelSurface` 永远不去点「消息」、
 *    面板永远打不开——2026-10-29 自动回复整夜沉默就是这个（全程零日志）。
 *    与之配套：隐藏元素的 `innerText` 会退化成 `textContent`（一个换行都没有），
 *    "名字/时间/预览/未读"会粘成一串（`星⭐心刚刚你是谁1`），`split('\n')[0]`
 *    拿到的是整串、预览永远是空。所以下面改用 `convParts` 按文本节点逐段取，
 *    隐藏态和展开态结果一致，也不依赖任何 class 名。
 * 2. `convItems` 只返回**可见**的会话项，所有读列表的地方都应该用它。
 */
const PAGE_HELPERS = `
  const clean = (v) => [...String(v)].filter((ch) => { const c = ch.codePointAt(0); return c > 31 && c !== 0x200b && c !== 0x200c && c !== 0x200d && c !== 0xfeff; }).join('').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const convItems = () => [...document.querySelectorAll('[data-e2e="conversation-item"]')].filter(visible);
  const convParts = (el) => {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { const t = clean(n.textContent); if (t !== '') out.push(t); return; }
      if (n.nodeType !== 1) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return out;
  };`;


/**
 * 网页通道。
 * @param {{getConfig: () => any, log: any, home: string, spawnImpl?: any}} deps 依赖
 * @returns {object} 通道
 */
export function createWebChan({ getConfig, log, home = '', spawnImpl = spawn }) {
  /**
   * 侧栏最近一次展开失败的时刻（0 = 没失败过）。
   *
   * 为什么要记：`panel` 模式下 autoReply 每 10 秒轮询一次，每次都要先确保侧栏展开。
   * 在"没有会话列表的页面"（创作者中心、个人主页）上，展开必然失败——不记状态就会
   * 每 10 秒去点几下「消息」，用户看到的是页面一直在切聊天。记住之后失败退避 1 分钟。
   */
  let panelMissAt = 0;
  /** 侧栏展开失败后的退避时长（ms） */
  const PANEL_RETRY_MS = 60_000;
  /** 上次失败时所在页面（URL 变了就重新允许尝试） */
  let panelMissKey = '';
  /** 同一页面上连续失败次数：到 2 次就判定"这个页面不支持侧栏"，不再点 */
  let panelMissCount = 0;

  /** @returns {{enabled: boolean, port: number, allowSend: boolean, surface: 'chat'|'panel'}} 当前设置 */
  function opts() {
    const web = getConfig().web ?? {};
    return { enabled: web.enabled !== false, port: Number(web.port) || 9333, allowSend: web.allowAutoSend === true, surface: web.surface === 'panel' ? 'panel' : 'chat' };
  }

  /** @returns {string} CDP 根地址 */
  function base() {
    return `http://127.0.0.1:${opts().port}`;
  }

  /**
   * 发一条 CDP 命令。
   * @param {string} wsUrl 目标 websocket
   * @param {string} method 方法
   * @param {object} [params] 参数
   * @returns {Promise<any>} 结果
   */
  function cdp(wsUrl, method, params = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`${method} 超时`));
      }, CDP_TIMEOUT);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${method}: websocket 失败`));
      });
    });
  }

  /**
   * 列出所有页面 target。
   * @returns {Promise<Array<{id: string, url: string, webSocketDebuggerUrl: string}>>} 页面
   */
  async function pages() {
    const list = await (await fetch(`${base()}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
    return list.filter((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
  }

  /**
   * 通道状态（给 UI 用）。
   * @returns {Promise<{ok: boolean, reason?: string, browser?: string, douyinTabs?: number}>} 状态
   */
  async function status() {
    if (!opts().enabled) return { ok: false, reason: '网页通道已关闭（设置页 → 账号 → 网页通道）' };
    try {
      const v = await (await fetch(`${base()}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
      const list = await pages();
      const tabs = list.filter((t) => /(^|\.)douyin\.com/.test(safeHost(t.url))).length;
      return { ok: true, browser: String(v.Browser ?? ''), douyinTabs: tabs };
    } catch {
      return { ok: false, reason: `连不上网页通道（127.0.0.1:${opts().port}）——那个专用浏览器窗口没开` };
    }
  }

  /**
   * 取一个"已经在抖音上"的页面；没有就返回 null。
   * @returns {Promise<any|null>} 页面
   */
  async function douyinPage() {
    const list = await pages();
    return list.find((t) => /(^|\.)douyin\.com/.test(safeHost(t.url))) ?? null;
  }

  /**
   * CDP 端口没人听时，按配置拉起专用浏览器（Ego Lite / Edge，都是 Chromium）。
   *
   * 独立 profile（`$DSH_HOME/dsh-pet-douyin-web/profile`）——不动用户日常浏览器的登录态，
   * 也不被日常浏览器占用 profile 而起不来。detached 启动，插件进程退出它也活着。
   * @returns {Promise<{ok: boolean, already?: boolean, reason?: string}>} 结果
   */
  async function launchBrowser() {
    const st = await status();
    if (st.ok) return { ok: true, already: true };
    const w = getConfig().web ?? {};
    if (w.autoLaunch === false) return { ok: false, reason: '自动拉起浏览器已关闭（设置 → web.autoLaunch）' };
    const exe = String(w.browserPath ?? '').trim();
    if (exe === '') return { ok: false, reason: '没配置浏览器路径（web.browserPath）' };
    if (!existsSync(exe)) return { ok: false, reason: `浏览器不存在：${exe}` };
    const profile = String(getConfig().web?.profileDir ?? '').trim() || join(home || process.cwd(), 'dsh-pet-douyin-web', 'profile');
    // panel 模式起始页用精选流（消息面板哪里都能开，没必要落在聊天页）
    const startUrl = opts().surface === 'panel' ? 'https://www.douyin.com/jingxuan' : 'https://www.douyin.com/chat';
    try {
      spawnImpl(
        exe,
        [`--remote-debugging-port=${opts().port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', startUrl],
        { detached: true, stdio: 'ignore' },
      ).unref();
    } catch (error) {
      return { ok: false, reason: `拉起浏览器失败：${error instanceof Error ? error.message : String(error)}` };
    }
    // Chromium 冷启动 + CDP 端口就绪，最多等 15 秒
    for (let i = 0; i < 30; i += 1) {
      await sleep(500);
      const s = await status();
      if (s.ok) {
        log?.info?.(`已拉起专用浏览器（${exe}），CDP 端口 ${opts().port} 就绪`);
        return { ok: true };
      }
    }
    return { ok: false, reason: '浏览器进程起来了但 CDP 端口一直没就绪（可能端口被别的实例占了）' };
  }

  /** 需要浏览器时先保证它在：连不上就拉一次，再试一次状态 */
  async function ensureBrowser() {
    const st = await status();
    if (st.ok) return true;
    const r = await launchBrowser();
    if (r.ok !== true) {
      log?.warn?.(`网页通道不可用：${r.reason}`);
      return false;
    }
    return true;
  }

  /**
   * 在专用浏览器里新开一个标签页（通用能力，与抖音无关，`/ego-browser` 用）。
   *
   * 走 CDP 的 HTTP 端点而不是 WebSocket：新建标签页不需要会话，
   * `PUT /json/new?<url>` 一条请求就够。新版 Chromium 只认 PUT，GET 会返回 405。
   * 浏览器没起来时由调用方先 `ensureOnline()`，这里只管开。
   * @param {string} targetUrl http(s) 链接
   * @returns {Promise<{ok: boolean, reason?: string}>} 结果
   */
  async function openTab(targetUrl) {
    const u = String(targetUrl ?? '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, reason: '只接受 http(s) 链接' };
    try {
      const res = await fetch(`${base()}/json/new?${encodeURIComponent(u)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        // 少数旧内核只支持 GET，退回一次
        const res2 = await fetch(`${base()}/json/new?${encodeURIComponent(u)}`, { signal: AbortSignal.timeout(8000) });
        if (!res2.ok) return { ok: false, reason: `CDP 建标签页失败：HTTP ${res2.status}` };
      }
      log?.info?.(`已新开标签页：${u}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 在页面里求值。
   * @param {string} wsUrl 页面 websocket
   * @param {string} expression JS 表达式（返回字符串）
   * @returns {Promise<string>} 结果
   */
  async function evaluate(wsUrl, expression) {
    const r = await cdp(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails !== undefined) {
      throw new Error(`页面里报错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return String(r.result?.value ?? '');
  }

  /**
   * 读会话列表。
   *
   * 优先复用已打开的消息页（省 6 秒）；没有就临时开一个、读完关掉——
   * 刻意不动用户正在看的那个标签，巡检不该把人的页面跳走。
   * @returns {Promise<{ok: boolean, items?: Array<{name: string, last: string}>, reason?: string, reused?: boolean}>} 结果
   */
  async function listChats() {
    if (!(await ensureBrowser())) return { ok: false, reason: `连不上网页通道（127.0.0.1:${opts().port}），自动拉起也没成功` };

    const expr = `(() => {
      ${PAGE_HELPERS}
      return JSON.stringify(convItems().map((e) => { const parts = convParts(e); return { name: parts[0] || '', last: parts.slice(1).join(' ') }; }));
    })()`;

    const reuse = await pages();
    const open = opts().surface === 'panel'
      ? reuse.find((t) => /(^|\.)douyin\.com/.test(safeHost(t.url)))
      : reuse.find((t) => t.url.includes('/chat'));
    if (open !== undefined) {
      try {
        return { ok: true, items: JSON.parse(await evaluate(open.webSocketDebuggerUrl, expr)), reused: true };
      } catch (error) {
        log?.warn(`复用消息页失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const v = await (await fetch(`${base()}/json/version`, { signal: AbortSignal.timeout(4000) })).json();
    const created = await cdp(v.webSocketDebuggerUrl, 'Target.createTarget', { url: 'https://www.douyin.com/chat' });
    let page = null;
    for (let i = 0; i < 40 && page === null; i += 1) {
      await sleep(250);
      page = (await pages()).find((t) => t.id === created.targetId) ?? null;
    }
    if (page === null) return { ok: false, reason: '新标签没开起来' };
    try {
      await sleep(RENDER_WAIT);
      return { ok: true, items: JSON.parse(await evaluate(page.webSocketDebuggerUrl, expr)), reused: false };
    } finally {
      await cdp(v.webSocketDebuggerUrl, 'Target.closeTarget', { targetId: created.targetId }).catch(() => {});
    }
  }

  /**
   * 把已登录窗口带到消息页（用户随后自己点会话、粘贴、发送）。
   * @returns {Promise<{ok: boolean, reason?: string}>} 结果
   */
  async function focusChat() {
    if (!(await ensureBrowser())) return { ok: false, reason: `连不上网页通道（127.0.0.1:${opts().port}）` };
    const page = await douyinPage();
    if (page === null) return { ok: false, reason: '窗口里没有抖音标签页' };
    if (opts().surface === 'panel') {
      const ensured = await ensurePanelSurface();
      if (ensured === null) return { ok: false, reason: '消息侧栏没展开' };
      return { ok: true };
    }
    await cdp(page.webSocketDebuggerUrl, 'Page.navigate', { url: 'https://www.douyin.com/chat' });
    await sleep(2500);
    return { ok: true };
  }

  /* ---------------- 网页发布：创作者中心（不经官方 API） ---------------- */

  /** 创作者中心上传页 */
  const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';

  /**
   * 找到（没有就新开）创作者中心页面。
   *
   * 优先复用已经开着的 creator 标签：新开会多一次冷启动，而且"同一个账号开好几个发布页"
   * 容易让表单状态互相打架。
   * @returns {Promise<any|null>} 页面 target
   */
  async function creatorPage() {
    const open = (await pages()).find((t) => typeof t.url === 'string' && t.url.includes('creator.douyin.com'));
    if (open !== undefined) {
      // 已经在上传页就别导航——导航会丢掉正在填的表单
      if (!open.url.includes('/content/upload')) {
        await cdp(open.webSocketDebuggerUrl, 'Page.navigate', { url: UPLOAD_URL });
        await sleep(RENDER_WAIT);
      }
      return open;
    }
    const v = await (await fetch(`${base()}/json/version`, { signal: AbortSignal.timeout(4000) })).json();
    const created = await cdp(v.webSocketDebuggerUrl, 'Target.createTarget', { url: UPLOAD_URL });
    let page = null;
    for (let i = 0; i < 60 && page === null; i += 1) {
      await sleep(250);
      page = (await pages()).find((t) => t.id === created.targetId) ?? null;
    }
    return page;
  }

  /**
   * 量元素中心坐标（量不到返回 null）。
   * @param {any} page 页面
   * @param {string} selector CSS 选择器
   * @returns {Promise<{x: number, y: number}|null>} 坐标
   */
  async function centerOf(page, selector) {
    const raw = await evaluate(
      page.webSocketDebuggerUrl,
      `(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        if (e === null) return 'null';
        const r = e.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return 'null';
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`,
    );
    if (raw === '' || raw === 'null') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * 多条 CDP 命令共用一条连接。
   *
   * 为什么需要：`cdp()` 是"一条命令一个连接"，而有些能力（`DOM.setFileInputFiles`）
   * 要求的 `objectId` 是**会话级**句柄——连接一关就失效。这类流程必须在一个会话里连续发。
   * @param {string} wsUrl 页面 WebSocket 地址
   * @param {(send: (method: string, params?: any) => Promise<any>) => Promise<any>} body 会话体
   * @returns {Promise<any>} body 的返回值
   */
  function cdpSession(wsUrl, body) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let seq = 0;
      /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
      const pending = new Map();
      let settled = false;

      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        for (const p of pending.values()) clearTimeout(p.timer);
        pending.clear();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fn(value);
      };

      ws.addEventListener('open', () => {
        const send = (method, params = {}) =>
          new Promise((res, rej) => {
            const id = ++seq;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} 超时`));
            }, CDP_TIMEOUT);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        body(send).then(
          (v) => done(resolve, v),
          (e) => done(reject, e),
        );
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const p = pending.get(msg.id);
        if (p === undefined) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      });

      ws.addEventListener('error', () => done(reject, new Error('websocket 失败')));
    });
  }

  /**
   * 把本地文件塞进页面的 `<input type=file>`。
   *
   * **不模拟系统文件对话框**：那需要 OS 级输入、窗口必须在前台，对话框一卡整条链就废。
   * `DOM.setFileInputFiles` 是浏览器内部直接赋值，等价于"用户选完文件点了确定"。
   *
   * 必须走 `cdpSession`：`Runtime.evaluate` 返回的 `objectId` 只在**同一个 WebSocket 会话**内有效，
   * 而 `cdp()` 是"一条命令一个连接"——分两次调用会报 `Could not find object with given id`。
   * @param {any} page 页面
   * @param {string} filePath 绝对路径
   * @returns {Promise<boolean>} 是否塞进去了
   */
  async function setUploadFile(page, filePath) {
    return cdpSession(page.webSocketDebuggerUrl, async (send) => {
      const r = await send('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')` });
      const objectId = r?.result?.objectId;
      if (typeof objectId !== 'string') return false;
      await send('DOM.setFileInputFiles', { files: [filePath], objectId });
      return true;
    });
  }

  /**
   * 等上传/转码完成到"可以填标题"的状态。
   *
   * 转码耗时跟文件大小强相关，所以给的是一个总预算而不是固定等待；
   * 页面自己报错（格式不支持/过大/失败）时立刻返回，不傻等到超时。
   * @param {any} page 页面
   * @param {number} timeoutMs 总预算
   * @returns {Promise<{ok: boolean, reason?: string}>} 结果
   */
  async function waitUploadReady(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      const raw = await evaluate(
        page.webSocketDebuggerUrl,
        `(() => {
          const body = (document.body.innerText || '').replace(/\\s+/g, ' ');
          const err = (body.match(/(上传失败|格式不支持|视频过大|转码失败|请上传)[^。]{0,40}/) || [])[1] || '';
          return JSON.stringify({ editor: document.querySelector('[contenteditable="true"]') !== null, err });
        })()`,
      );
      let s = null;
      try {
        s = JSON.parse(raw);
      } catch {
        s = null;
      }
      if (s !== null && s.editor === true) return { ok: true };
      if (s !== null && s.err !== '') return { ok: false, reason: s.err };
      if (s !== null) lastErr = '';
      await sleep(2000);
    }
    return { ok: false, reason: `等上传/转码超时（${Math.round(timeoutMs / 1000)} 秒）${lastErr}` };
  }

  /**
   * 填标题（真实点击 + insertText）。
   *
   * 不直接用 JS 改 innerText：抖音的标题是富文本编辑器，直接改 DOM 不会被它的状态接管，
   * 提交时是空的。这与私信输入框踩的是同一个坑。
   * @param {any} page 页面
   * @param {string} text 标题（可含 #话题）
   * @returns {Promise<boolean>} 是否写上（读回比对）
   */
  async function fillTitle(page, text) {
    const box = await centerOf(page, '[contenteditable="true"]');
    if (box === null) return false;
    await clickAt(page, box.x, box.y);
    await sleep(300);
    // Ctrl+A 全选再插入：编辑器里可能已有默认文案或草稿残留
    for (const type of ['keyDown', 'keyUp']) {
      await cdp(page.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', {
        type,
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: 2,
      });
    }
    await sleep(120);
    await cdp(page.webSocketDebuggerUrl, 'Input.insertText', { text });
    await sleep(400);
    const got = await evaluate(
      page.webSocketDebuggerUrl,
      `(() => (document.querySelector('[contenteditable="true"]')?.innerText ?? '').trim())()`,
    );
    const head = text.slice(0, Math.min(8, text.length));
    return String(got).includes(head);
  }

  /**
   * 点「发布」（只有 autoPublish 开着才会走到这里）。
   * @param {any} page 页面
   * @returns {Promise<{ok: boolean, reason?: string}>} 结果
   */
  async function clickPublish(page) {
    const raw = await evaluate(
      page.webSocketDebuggerUrl,
      `(() => {
        const hit = [...document.querySelectorAll('button, [role="button"]')].find((e) => {
          const t = (e.innerText || '').replace(/\\s+/g, '');
          if (t !== '发布' && t !== '立即发布') return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && e.disabled !== true;
        });
        if (hit === undefined) return 'null';
        const r = hit.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`,
    );
    if (raw === 'null' || raw === '') return { ok: false, reason: '没找到可点的「发布」按钮（可能被禁用或页面改版）' };
    let box = null;
    try {
      box = JSON.parse(raw);
    } catch {
      box = null;
    }
    if (box === null) return { ok: false, reason: '发布按钮坐标解析失败' };
    await clickAt(page, box.x, box.y);
    return { ok: true };
  }

  /**
   * 等发布结果。
   * @param {any} page 页面
   * @param {number} timeoutMs 超时
   * @returns {Promise<{ok: boolean, reason?: string}>} 结果
   */
  async function waitPublished(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = await evaluate(
        page.webSocketDebuggerUrl,
        `(() => {
          const body = (document.body.innerText || '').replace(/\\s+/g, ' ');
          return JSON.stringify({
            ok: /发布成功|作品发布成功/.test(body),
            href: location.href,
            err: (body.match(/(发布失败|审核不通过|网络异常)[^。]{0,40}/) || [])[1] || '',
          });
        })()`,
      );
      let v = null;
      try {
        v = JSON.parse(raw);
      } catch {
        v = null;
      }
      if (v !== null && v.err !== '') return { ok: false, reason: v.err };
      if (v !== null && (v.ok === true || String(v.href).includes('/content/manage'))) return { ok: true };
      await sleep(2000);
    }
    return { ok: false, reason: `点了发布但 ${Math.round(timeoutMs / 1000)} 秒内没看到成功提示，去创作者中心确认一下` };
  }

  /**
   * 网页发布：上传 → 等转码 → 填标题 →（可选）点发布。
   *
   * **默认不点发布**。这是整条链上唯一不可撤销的动作——视频一出去就是公开内容，
   * 而上游还有封面、权限、定时发布这些字段，中途任何一处错都该让人看一眼再决定。
   * 只有 `web.autoPublish` 打开时才会走到最后一步。
   *
   * @param {{file: string, title?: string, autoPublish?: boolean, timeoutMs?: number}} args 参数
   * @returns {Promise<{ok: boolean, mode?: 'ready'|'published', title?: string, titleSet?: boolean, reason?: string}>} 结果
   */
  async function publishVideo({ file, title = '', autoPublish = false, timeoutMs = 240_000 }) {
    if (!(await ensureOnline())) return { ok: false, reason: `连不上网页通道（127.0.0.1:${opts().port}）` };
    const abs = resolve(String(file ?? ''));
    if (!existsSync(abs)) return { ok: false, reason: `找不到视频文件：${abs}` };

    const page = await creatorPage();
    if (page === null) return { ok: false, reason: '创作者中心页面没打开' };
    await sleep(RENDER_WAIT);

    if (!(await setUploadFile(page, abs))) {
      return { ok: false, reason: '上传页没有找到 file 输入框（页面可能改版了）' };
    }

    const ready = await waitUploadReady(page, timeoutMs);
    if (!ready.ok) return { ok: false, reason: ready.reason ?? '上传没成功' };

    const text = String(title ?? '').trim();
    const titleSet = text === '' ? false : await fillTitle(page, text);

    if (autoPublish !== true) {
      return { ok: true, mode: 'ready', title: text, titleSet, reason: '已停在发布按钮前，等人点最后一下' };
    }

    const clicked = await clickPublish(page);
    if (!clicked.ok) return { ok: false, mode: 'ready', reason: clicked.reason ?? '点不到发布按钮' };
    const done = await waitPublished(page, 60_000);
    if (!done.ok) return { ok: false, mode: 'published', title: text, titleSet, reason: done.reason ?? '发布结果未知' };
    return { ok: true, mode: 'published', title: text, titleSet };
  }

  /**
   * 真实鼠标点击（坐标来自页面里量出来的矩形）。
   * @param {any} page 页面 target
   * @param {number} x 横坐标
   * @param {number} y 纵坐标
   * @returns {Promise<void>} 完成
   */
  async function clickAt(page, x, y) {
    await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 40));
    await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * 抓页面上的提示文案（toast / alert / 报错）。
   *
   * 为什么要：发送失败时分不清"平台拒绝"（新号限制、频率限制）和"我们自己写错了"。
   * 把当时页面弹出的提示带进失败原因，下次看日志就能直接判断，不用再猜。
   * @param {any} page 页面
   * @returns {Promise<string>} 提示文案（没有就是空串）
   */
  async function readPageNotice(page) {
    const r = await evalJson(
      page,
      `(() => {
        const out = [];
        for (const s of ['[role="alert"]', '[class*="toast"]', '[class*="Toast"]', '[class*="error"]', '[class*="Error"]']) {
          for (const el of document.querySelectorAll(s)) {
            const box = el.getBoundingClientRect();
            if (box.width < 1 || box.height < 1) continue;
            const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
            if (t !== '' && t.length <= 60) out.push(t);
          }
        }
        return JSON.stringify({ list: [...new Set(out)].slice(0, 3) });
      })()`,
    );
    const list = r?.list ?? [];
    return list.length === 0 ? '' : list.join(' | ');
  }

  /**
   * 清空当前聚焦的输入框（发送前必做）。
   *
   * 为什么用退格而不是 JS 改 DOM：抖音的输入框是富文本编辑器，直接写 innerText 它的状态
   * 不认，提交时还是空的（跟发布页标题踩的是同一个坑）。退格是真实按键，编辑器一定认。
   *
   * 判据必须**先剔掉零宽字符**：空输入框里天然有一个 `\u200B` 占位符，退格删不掉，
   * 所以 `innerText.length === 0` 永远不成立——按这个写会把所有发送都判成失败。
   * 这里与发送前的读回比对用同一套 clean 规则。
   * @param {any} page 页面
   * @returns {Promise<boolean>} 是否清干净（按"可见字符为空"判定）
   */
  async function clearEditor(page) {
    /** 框内可见字符数（零宽 / 控制字符不计） */
    const readClean = async () =>
      (
        await evalJson(
          page,
          `(() => {
            const e = document.querySelector('[contenteditable="true"]');
            const raw = e ? String(e.innerText ?? '') : '';
            const clean = [...raw]
              .filter((ch) => {
                const c = ch.codePointAt(0) ?? 0;
                return c > 31 && c !== 0x200b && c !== 0x200c && c !== 0x200d && c !== 0xfeff;
              })
              .join('')
              .trim();
            return JSON.stringify({ n: clean.length });
          })()`,
        )
      )?.n ?? 0;

    for (let round = 0; round < 2; round += 1) {
      const n = await readClean();
      if (n === 0) return true;
      const times = Math.min(n + 5, 400);
      for (let i = 0; i < times; i += 1) {
        await cdp(page.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await cdp(page.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      }
      await sleep(300);
    }
    return (await readClean()) === 0;
  }

  /** 页面里求值并解析 JSON（失败返回 null，不抛） */
  async function evalJson(page, expr) {
    try {
      return JSON.parse(await evaluate(page.webSocketDebuggerUrl, expr));
    } catch {
      return null;
    }
  }

  /**
   * 反复求值直到满足条件或超时。
   *
   * 抖音是 SPA，"页面已经加载"和"数据已经渲染"是两件事：导航完 body 里已经有几千字页脚，
   * 但会话列表可能还要 6–9 秒才出来。固定 sleep 要么太短（读空）、要么太长（白等）。
   * @param {any} page 页面 target
   * @param {string} expr 表达式（返回 JSON）
   * @param {(v: any) => boolean} ok 满足条件
   * @param {number} [timeoutMs] 超时
   * @returns {Promise<any>} 最后一次结果
   */
  async function waitJson(page, expr, ok, timeoutMs = 12_000) {
    const started = Date.now();
    let last = null;
    for (;;) {
      last = await evalJson(page, expr);
      if (last !== null && ok(last)) return last;
      if (Date.now() - started > timeoutMs) return last;
      await sleep(400);
    }
  }

  /** 确保有一个停在消息页的标签，返回它 */
  async function ensureChatPage() {
    if (!(await ensureBrowser())) return null;
    if (opts().surface === 'panel') return ensurePanelSurface();
    const page = await douyinPage();
    if (page === null) return null;
    if (!page.url.includes('/chat')) {
      await cdp(page.webSocketDebuggerUrl, 'Page.navigate', { url: 'https://www.douyin.com/chat' });
      await sleep(RENDER_WAIT);
    }
    return page;
  }

  /**
   * 面板模式（web.surface = 'panel'）：不跳页面，在用户当前浏览的任意抖音页上
   * 确保「消息」侧栏面板展开。面板与消息页复用同一套组件——实测（2026-10-28）：
   * 会话列表 `[data-e2e="conversation-item"]`、聊天头 `RightPanelHeadertitle`、
   * 气泡 `[class*="MessageItemText"]`、输入框 `[contenteditable="true"]` 全部同款，
   * 所以读/发逻辑零改动，只是页面选择与面板展开保障不同。
   * @returns {Promise<any|null>} 页面 target
   */
  async function ensurePanelSurface() {
    const page = await douyinPage();
    if (page === null) return null;

    // 已经开着的侧栏直接用——这是 panel 模式的正常路径（用户自己点开消息，插件在旁边读）
    const probe = await evalJson(
      page,
      `(() => {
        ${PAGE_HELPERS}
        // hidden 只用于诊断：抖音会在面板**收起**时把会话项 DOM 留在页面上（尺寸 0×0），
        // 这个数会大于 0 而 items 是 0，日志里一眼能看出是"折叠"还是"压根没有侧栏"
        const total = document.querySelectorAll('[data-e2e="conversation-item"]').length;
        const items = convItems().length;
        let entry = null;
        if (items === 0) {
          for (const el of document.querySelectorAll('[data-e2e], a, button, div[role="button"]')) {
            if (clean(el.innerText) === '消息' && visible(el)) {
              const r = el.getBoundingClientRect();
              if (r.top >= 0 && r.top < 160) { entry = { x: Math.round(r.x + 5), y: Math.round(r.y + 5) }; break; }
            }
          }
        }
        return JSON.stringify({ items, hidden: total - items, entry });
      })()`,
    );
    if (probe !== null && probe.items > 0) {
      panelMissAt = 0;
      panelMissKey = '';
      panelMissCount = 0;
      return page;
    }

    /** 记录一次失败并说明原因；同一页面连续失败 2 次就永久跳过（直到 URL 变化） */
    const miss = (why) => {
      const key = page.url.slice(0, 120);
      panelMissCount = panelMissKey === key ? panelMissCount + 1 : 1;
      panelMissKey = key;
      panelMissAt = Date.now();
      const tail = panelMissCount >= 2 ? '，这个页面不再尝试（换页面或手动点开侧栏后恢复）' : `，${PANEL_RETRY_MS / 1000}s 后再试一次`;
      log?.warn?.(`面板模式：${why}${tail}（${key.slice(0, 60)}）`);
      return null;
    };

    // 这个页面已经判定不支持侧栏：别再点，用户会看到页面被反复抢
    if (panelMissKey === page.url.slice(0, 120) && panelMissCount >= 2) return null;
    // 刚失败过：退避期内不重试
    if (panelMissAt !== 0 && Date.now() - panelMissAt < PANEL_RETRY_MS) return null;

    const entry = probe?.entry ?? null;
    // 找不到「消息」入口 = 这个页面压根没有侧栏（创作者中心、作品详情页等），点也没用
    if (entry === null) {
      return miss(probe?.hidden > 0 ? '侧栏是折叠的（会话项 DOM 在、尺寸为 0）但找不到「消息」入口' : '当前页没有「消息」入口');
    }

    // 只点一次、等 3 秒看结果。原来点 3 次是"多点几次总能开"的赌法，
    // 代价是失败时页面被连点 3 下——比开不出来更难受。
    await clickAt(page, entry.x, entry.y);
    await sleep(3000);
    const after = await evalJson(page, `(() => { ${PAGE_HELPERS} return JSON.stringify({ items: convItems().length }); })()`);
    if (after !== null && after.items > 0) {
      panelMissAt = 0;
      panelMissKey = '';
      panelMissCount = 0;
      return page;
    }
    return miss('点开侧栏后仍没有会话列表');
  }

  /**
   * 打开一个会话：等列表渲染 → 按名字**精确匹配** → 元素级点击。
   * （元素级 dispatch 不经过命中检测，实测比按坐标点稳定——会话项上有浮层吃命中。）
   * @param {any} page 页面 target
   * @param {string} to 会话名
   * @returns {Promise<{ok: boolean, reason?: string}>} 结果
   */
  async function openConversation(page, to) {
    // 等列表渲染完，再精确匹配会话名
    const conv = await waitJson(
      page,
      `(() => {
        ${PAGE_HELPERS}
        const want = ${JSON.stringify(String(to))};
        const items = convItems();
        const firstLine = (e) => convParts(e)[0] || '';
        const hit = items.find((e) => firstLine(e) === want);
        if (!hit) return JSON.stringify({ ok: false, names: items.map(firstLine) });
        return JSON.stringify({ ok: true });
      })()`,
      (v) => v.ok === true,
      12_000,
    );
    if (conv === null || conv.ok !== true) {
      const names = Array.isArray(conv?.names) ? conv.names.slice(0, 8).join('、') : '';
      const seen = names === '' ? '一个都没读到（列表可能还没渲染）' : `现有：${names}`;
      return { ok: false, reason: `会话里没有「${to}」（${seen}）` };
    }
    const clicked = await evaluate(
      page.webSocketDebuggerUrl,
      `(() => {
        ${PAGE_HELPERS}
        const want = ${JSON.stringify(String(to))};
        const items = convItems();
        const firstLine = (e) => convParts(e)[0] || '';
        const hit = items.find((e) => firstLine(e) === want);
        if (!hit) return 'gone';
        hit.scrollIntoView({ block: 'center' });
        const b = hit.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 };
        hit.dispatchEvent(new MouseEvent('mousedown', o));
        hit.dispatchEvent(new MouseEvent('mouseup', o));
        hit.dispatchEvent(new MouseEvent('click', o));
        return 'clicked';
      })()`,
    );
    if (clicked !== 'clicked') return { ok: false, reason: '会话节点在等待期间消失了' };
    await sleep(1500);
    return { ok: true };
  }

  /** 读入站消息的表达式：不带 isFromMe 的文本气泡，排除系统提示 */
  const INCOMING_EXPR = `(() => {
    const clean = (v) => [...String(v)].filter((ch) => { const c = ch.codePointAt(0); return c > 31 && c !== 0x200b && c !== 0x200c && c !== 0x200d && c !== 0xfeff; }).join('').trim();
    const out = [];
    for (const e of document.querySelectorAll('[class*="MessageItemTextcontainer"]')) {
      if (/isFromMe/.test(String(e.className))) continue;
      const t = clean(e.innerText);
      if (t && !t.includes('我们已互相关注')) out.push(t);
    }
    return JSON.stringify(out);
  })()`;

  /**
   * 读一个会话的入站消息（旧→新）。
   *
   * 方向判据（真机核实 2026-10）：自己发的气泡带 `MessageItemTextisFromMe` class，
   * 对方发的不带；系统提示（"我们已互相关注"）按文本排除。
   * `to` 为空 = 读当前打开的会话（名字从聊天头部 `RightPanelHeadertitle` 取，
   * 兜底 `document.title`——真机上标题就是对方名字）。
   * @param {{to?: string}} [args] 参数
   * @returns {Promise<{ok: boolean, to?: string, incoming?: string[], reason?: string}>} 结果
   */
  async function readIncoming({ to = '' } = {}) {
    if (!(await ensureBrowser())) return { ok: false, reason: `连不上网页通道（127.0.0.1:${opts().port}）` };
    const page = await ensureChatPage();
    if (page === null) return { ok: false, reason: '没有可用的抖音标签页' };

    let target = String(to ?? '').trim();
    let isGroup = false;
    if (target !== '') {
      const opened = await openConversation(page, target);
      if (opened.ok !== true) return opened;
    } else if (opts().surface === 'panel') {
      // 面板模式的会话头没有语义化类名（通用 StackLayout 布局），
      // 用"头部文本 ↔ 会话列表名字"求交集：剥掉成员数后缀后能对上的那个才是当前会话，
      // 对不上就如实说没有——绝不对着网页标题瞎猜。
      const peer = await evalJson(
        page,
        `(() => {
          ${PAGE_HELPERS}
          const strip = (s) => s.replace(/\\(\\d+\\)\\s*$/, '').trim();
          const items = convItems().map((e) => convParts(e)[0] || '');
          const cands = [];
          for (const el of document.querySelectorAll('div,span')) {
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.left > 600 && r.top >= 40 && r.top < 140)) continue;
            const t = clean(el.innerText || '');
            if (!t || t.length > 60 || el.children.length > 4) continue;
            if ([...el.children].some((c) => clean(c.innerText || '') === t)) continue;
            cands.push(t);
          }
          const rawHit = cands.find((t) => items.includes(strip(t)));
          return JSON.stringify({ peer: rawHit ?? '', group: rawHit !== undefined && /\\(\\d+\\)\\s*$/.test(rawHit) });
        })()`,
      );
      if (peer === null || String(peer.peer ?? '') === '') {
        return { ok: false, reason: '面板里没有打开的会话（在「消息」面板里点开一个会话后才会监听）' };
      }
      target = String(peer.peer).replace(/\(\d+\)\s*$/, '').trim();
      isGroup = peer.group === true;
    } else {
      const peer = await evalJson(
        page,
        `(() => {
          const clean = (v) => [...String(v)].filter((ch) => { const c = ch.codePointAt(0); return c > 31 && c !== 0x200b; }).join('').trim();
          const e = document.querySelector('[class*="RightPanelHeadertitle"]');
          const raw = e ? clean(e.innerText) : clean(document.title);
          return JSON.stringify({ peer: raw, group: /\\(\\d+\\)\\s*$/.test(raw) });
        })()`,
      );
      isGroup = peer?.group === true;
      target = String(peer?.peer ?? '').trim();
      // 群聊头部的名字带成员数后缀（如「…在发什么呆(3)」），而会话列表第一行没有——
      // 这个后缀是从 header 拿名字时混进来的杂质，剥掉才能和列表里的会话精确对上。
      target = target.replace(/\(\d+\)\s*$/, '').trim();
      if (target === '') return { ok: false, reason: '读不到当前会话的名字（可能没点开任何会话）' };
    }

    const incoming = await evalJson(page, INCOMING_EXPR);
    if (incoming === null) return { ok: false, reason: '读不到消息气泡（会话可能还没渲染完）' };
    return { ok: true, to: target, group: isGroup === true, incoming };
  }

  /**
   * 真的把一条消息发出去。
   *
   * 这是整个插件里唯一会**改变外部世界**的函数，所以每一步都带校验，
   * 任何一步对不上就立刻中止，绝不"再试一次"：
   *   1. 会话必须按名字**精确匹配**（找不到就不发，不落到第一个）；
   *   2. 文字写进输入框后要**读回比对**，不一致就不按发送；
   *   3. 发送后要**核对回执**：消息气泡（`MessageItemText`）或会话预览里出现这段文字，
   *      轮询最多 8 秒；两者都没有就是失败，如实上报；
   *   4. 全程只发一次。失败就是失败，不重试——重试是重复发消息的主要来源。
   * @param {{to: string, text: string}} args 参数
   * @returns {Promise<{ok: boolean, verified?: boolean, reason?: string, tried?: string}>} 结果
   */
  async function sendMessage({ to, text }) {
    if (opts().allowSend !== true) return { ok: false, reason: '自动发送未开启（设置页 → 账号 → 网页通道）' };
    const body = String(text ?? '').trim();
    if (body === '') return { ok: false, reason: '正文是空的，不发' };

    const page = await ensureChatPage();
    if (page === null) return { ok: false, reason: '没有可用的抖音标签页' };

    // 1) 打开会话（等列表渲染 → 精确匹配 → 元素级点击）
    const opened = await openConversation(page, String(to));
    if (opened.ok !== true) return { ok: false, reason: opened.reason, tried: 'conversation' };

    // 2) 等输入框出现再聚焦
    const ed = await waitJson(
      page,
      `(() => {
        const e = document.querySelector('[contenteditable="true"]');
        if (!e) return JSON.stringify({ ok: false });
        const b = e.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(b.x + 40), y: Math.round(b.y + b.height / 2) });
      })()`,
      (v) => v.ok === true,
      8000,
    );
    if (ed === null || ed.ok !== true) return { ok: false, reason: '点开会话后没找到输入框', tried: 'editor' };
    const focused = await evaluate(
      page.webSocketDebuggerUrl,
      `(() => {
        const e = document.querySelector('[contenteditable="true"]');
        if (!e) return 'gone';
        const b = e.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window, clientX: b.x + 40, clientY: b.y + b.height / 2 };
        e.dispatchEvent(new MouseEvent('mousedown', o));
        e.dispatchEvent(new MouseEvent('mouseup', o));
        e.dispatchEvent(new MouseEvent('click', o));
        e.focus();
        return 'focused';
      })()`,
    );
    if (focused !== 'focused') return { ok: false, reason: '输入框在等待期间消失了', tried: 'editor' };
    await sleep(300 + Math.floor(Math.random() * 300));

    // 2.5) **清空残留**（2026-10-28 修）。
    //      上一次发送失败/超时会在框里留下半截内容，而下面用的是逐字符"键入"——
    //      键入是**追加**不是替换。不清空就会变成「旧内容 + 新内容」，读回比对必然失败，
    //      表现就是"某个会话永远发不出去"，日志里能看到框内是两段话拼在一起。
    if (!(await clearEditor(page))) {
      return { ok: false, reason: '输入框里的旧内容清不掉，为免发错内容已中止', tried: 'clear' };
    }

    // 3) 输入：逐字符真实键入（拟人化）。
    //    2026-10-28 用户真机对照：Input.insertText 整段注入 + 回车，群聊消息只有本地回显、
    //    其他成员（App/网页都）看不到；同会话手动打字+点发送别人可见。整段注入走的不是
    //    真人输入管线，逐字符 keyDown(keyUp) 带 text 才与真人按键同路径（Playwright type 同款）。
    for (const ch of [...body]) {
      await cdp(page.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
      await cdp(page.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await sleep(24 + Math.floor(Math.random() * 56));
    }
    await sleep(500 + Math.floor(Math.random() * 300));

    const typed = await evaluate(
      page.webSocketDebuggerUrl,
      `(() => {
        const clean = (v) => [...String(v)].filter((ch) => { const c = ch.codePointAt(0); return c > 31 && c !== 0x200b && c !== 0x200c && c !== 0x200d && c !== 0xfeff; }).join('').trim();
        const e = document.querySelector('[contenteditable="true"]');
        return e ? clean(e.innerText) : '';
      })()`,
    );
    if (typed !== body.trim()) {
      // 写进去的东西和我们想发的不一样 —— 这种情况下按发送就是发错内容。
      // 但要先把框清干净：不然残留会让**下一次**也失败（曾经的"某个会话永远发不出去"就是这个）
      await clearEditor(page);
      // 顺手把页面提示也带回来：这条能区分"平台拒绝（新号限制/频率限制）"和"我们自己写错了"
      const notice = await readPageNotice(page);
      return {
        ok: false,
        reason: `输入框内容与要发送的不一致（框内：${typed.slice(0, 30)}）${notice === '' ? '' : `；页面提示：${notice}`}`,
        tried: 'verify',
      };
    }

    // 4) 发送：优先点「发送」箭头/按钮。2026-10-28 真机实测：面板群聊的发送触发器是
    //    [class*="publishBtn"] 图标（编辑器右侧，打字后出现），回车与它不等价——
    //    回车/insertText 产生的消息只有本地回显、其他成员（App/网页）看不到。
    //    探测顺序：publishBtn 图标 → 文字「发送」/Send → class 含 send → 回车兜底。
    let sendMethod = 'enter';
    const btn = await evalJson(
      page,
      `(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; };
        const pick = (sel) => { for (const el of document.querySelectorAll(sel)) { const p = vis(el); if (p) return p; } return null; };
        const p1 = pick('[class*="publishBtn"]');
        if (p1) return JSON.stringify({ ok: true, p: p1, kind: 'publishBtn' });
        const all = [...document.querySelectorAll('button, [role="button"], [data-e2e*="send"], [class*="send" i]')];
        const hit = all.find((e) => { const t = (e.innerText || '').trim(); return t === '发送' || t === 'Send' || (/send/i.test(String(e.className || '')) && t !== '' && t.length <= 6); });
        if (hit) { const p = vis(hit); if (p) return JSON.stringify({ ok: true, p, kind: 'button' }); }
        return JSON.stringify({ ok: false });
      })()`,
    );
    if (btn !== null && btn.ok === true) {
      sendMethod = btn.kind;
      await clickAt(page, btn.p.x, btn.p.y);
    } else {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp(page.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: type === 'keyDown' ? '\r' : undefined,
        });
      }
    }

    // 5) 回执：消息气泡或会话预览里出现这段文字才算发出去。
    //    注意不能用 body.innerText——它把输入框残留也算进去，是假阳性；
    //    气泡用 [class*="MessageItemText"]（真机实测的选择器），会话预览兜底。
    const receipt = await waitJson(
      page,
      `(() => {
        ${PAGE_HELPERS}
        const ed = document.querySelector('[contenteditable="true"]');
        const left = ed ? clean(ed.innerText) : '';
        const want = ${JSON.stringify(body.slice(0, 12))};
        const inBubble = [...document.querySelectorAll('[class*="MessageItemText"]')].some((e) => clean(e.innerText).includes(want));
        const inConv = convItems().some((e) => convParts(e).join(' ').includes(want));
        return JSON.stringify({ left, inBubble, inConv });
      })()`,
      (v) => v.inBubble === true || v.inConv === true,
      8000,
    );
    if (receipt === null) return { ok: false, reason: '发送后读不到页面状态', tried: 'receipt' };
    if (receipt.inBubble !== true && receipt.inConv !== true) {
      // 这个分支最可能是"平台没让发"（新号群聊限制、频率限制、被风控）——
      // 所以把页面当时弹的提示一起带回去，不用人去猜是哪一层拦下的
      const notice = await readPageNotice(page);
      return {
        ok: false,
        reason: `发送没生效（消息气泡和会话预览里都没出现这段文字；输入框还剩「${String(receipt.left).slice(0, 20)}」）${notice === '' ? '' : `；页面提示：${notice}`}`,
        tried: 'receipt',
      };
    }
    return { ok: true, verified: true, method: sendMethod, editorCleared: String(receipt.left).trim() === '' };
  }

  /**
   * 会话列表预览（自动回复轮询用）：不开新标签，只在当前抖音页上读名字+最后一条。
   * 面板模式要求消息面板已展开（ensurePanelSurface 保证），chat 模式要求停在消息页。
   * @returns {Promise<{ok: boolean, items?: Array<{name: string, last: string}>, reason?: string}>} 结果
   */
  async function listConversations() {
    if (!(await ensureBrowser())) return { ok: false, reason: `连不上网页通道（127.0.0.1:${opts().port}）` };
    const page = opts().surface === 'panel' ? await ensurePanelSurface() : await ensureChatPage();
    if (page === null) return { ok: false, reason: '没有可用的抖音标签页（会话列表不可见）' };
    const items = await evalJson(
      page,
      `(() => {
        ${PAGE_HELPERS}
        return JSON.stringify(convItems().map((e) => { const parts = convParts(e); return { name: parts[0] || '', last: parts.slice(1).join(' ') || '' }; }));
      })()`,
    );
    if (items === null) return { ok: false, reason: '会话列表没渲染出来' };
    return { ok: true, items };
  }

  /**
   * 刷推荐流：**直接读抖音自己的 feed 接口**，不解析 DOM。
   *
   * 为什么放弃 DOM（2026-10-29 全部实测，别回头重走）：
   * - 推荐页是全屏竖滑播放器，只暴露"当前这一条"，字段挂在活跃项的祖先里；
   * - 翻页要用**可信输入**（`Input.dispatchKeyEvent`）：JS 合成 KeyboardEvent 的
   *   `isTrusted=false` 时灵时不灵，CDP 滚轮完全推不动；
   * - 最要命的是 `[data-e2e="feed-active-video"]` 这个标记**会掉**：标签切到后台、
   *   或者连刷几十条之后它就再也不回来，于是整页都读不到 id（"刷到一半突然没内容"）。
   * 换到接口这条路：页面自己在发 `/aweme/v1/web/tab/feed/`，一次回 6 条结构化数据
   * （aweme_id / desc / author.nickname / statistics.digg_count / video.duration），
   * 拿到的比 DOM 更全、更快，也不再依赖任何会变的 class 名。
   *
   * 做法：一条 CDP 长连接同时收 `Network.responseReceived` 事件与发命令；
   * 按方向键让页面去取下一批，再从 `Network.getResponseBody` 里解析 aweme_list。
   * 首屏那次请求在 `Network.enable` 之前就发完了，读不到——所以总会先按一次键。
   * @param {{limit?: number}} [args] 要多少条
   * @returns {Promise<{ok: boolean, items?: Array<object>, opened?: boolean, total?: number, reason?: string}>} 结果
   */
  async function readFeed({ limit = 10 } = {}) {
    const want = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const st = await ensureOnline();
    if (st.ok !== true) return { ok: false, reason: st.reason ?? '网页通道不可用' };

    // 复用已开着的推荐流标签；没有才新开——绝不动用户正在看的那个标签
    let page = (await pages()).find((t) => t.url.includes('recommend=1'));
    let opened = false;
    if (page === undefined) {
      const r = await openTab(FEED_URL);
      if (r.ok !== true) return { ok: false, reason: r.reason };
      opened = true;
      for (let i = 0; i < 25 && page === undefined; i += 1) {
        await sleep(600);
        const list = await pages().catch(() => []);
        page = list.find((t) => t.url.includes('recommend=1'));
      }
      if (page === undefined) return { ok: false, reason: '推荐流页面没能打开' };
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
    });

    let seq = 0;
    const pending = new Map();
    const hits = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const done = pending.get(msg.id);
        pending.delete(msg.id);
        done(msg.result);
        return;
      }
      if (msg.method === 'Network.responseReceived') {
        const url = String(msg.params?.response?.url ?? '');
        if (FEED_API_RE.test(url)) hits.push(msg.params.requestId);
      }
    });

    /** 发一条 CDP 命令 */
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = (seq += 1);
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`${method} 超时`));
        }, 15_000);
        pending.set(id, (r) => {
          clearTimeout(timer);
          res(r);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });

    /** 翻到下一条：可信方向键（合成事件与滚轮都不可靠） */
    const pressDown = async () => {
      const key = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key }).catch(() => {});
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }).catch(() => {});
    };

    const items = [];
    const seen = new Set();
    try {
      await send('Network.enable', {}).catch(() => {});
      for (let step = 0; step < Math.min(want * 2, 40) && items.length < want; step += 1) {
        await pressDown();
        await sleep(1400);
        while (hits.length > 0) {
          const requestId = hits.shift();
          const body = await send('Network.getResponseBody', { requestId }).catch(() => null);
          if (body === null || typeof body.body !== 'string') continue;
          let json = null;
          try {
            json = JSON.parse(body.body);
          } catch {
            continue;
          }
          const list = Array.isArray(json?.aweme_list) ? json.aweme_list : [];
          for (const a of list) {
            const id = String(a?.aweme_id ?? '');
            if (id === '' || seen.has(id)) continue;
            seen.add(id);
            items.push({
              id,
              nick: String(a?.author?.nickname ?? ''),
              desc: String(a?.desc ?? ''),
              // caption 是创作者写的完整文案（实测 6/6 都有，比 desc 信息量大得多）；
              // item_title 是结构化标题（如《太公在此》）。两者都可能为空，解析层各自兜底。
              caption: String(a?.caption ?? ''),
              itemTitle: String(a?.item_title ?? ''),
              digg: a?.statistics?.digg_count ?? '',
              duration: Number(a?.video?.duration ?? 0) || 0,
            });
          }
        }
      }
    } finally {
      ws.close();
    }

    if (items.length === 0) {
      return { ok: false, reason: '没抓到推荐流数据（可能没登录，或接口变了）', opened };
    }
    return { ok: true, items: items.slice(0, want), opened, total: Math.min(items.length, want) };
  }

  /**
   * 给当前正在播的这条视频抓几帧（**不下载视频**）。
   *
   * 为什么不用下载：实测直链（douyinvod）对 Node 的裸请求回 **403**（要签名/凭据），
   * 而视频本来就在浏览器里解码播放着——直接 `Page.captureScreenshot` 截播放区就行，
   * 既绕过防盗链，也不用为看 3 帧付几十 MB 流量。
   *
   * 两个坑：
   * 1. **不要用 `video.duration` 去 seek**：抖音这条流式加载时 `duration` 是 null，
   *    `currentTime = duration*0.3` 等于 NaN，跳不动，抓回来的是同一帧。
   *    改成"自然播放 + 按间隔连拍"。
   * 2. 后台标签里视频是 paused 的，先 `play()` 再截；截完把原来的暂停状态还原。
   * @param {{count?: number, intervalMs?: number, scale?: number}} [args] 帧数 / 间隔 / 缩放
   * @returns {Promise<{ok: boolean, frames?: Array<{data: Buffer, mediaType: string, width: number, height: number}>, reason?: string}>} 结果
   */
  async function grabFrames({ count = 3, intervalMs = 1800, scale = 0.8 } = {}) {
    const want = Math.min(Math.max(Number(count) || 3, 1), 6);
    const st = await ensureOnline();
    if (st.ok !== true) return { ok: false, reason: st.reason ?? '网页通道不可用' };

    let page = (await pages()).find((t) => t.url.includes('recommend=1'));
    if (page === undefined) return { ok: false, reason: '推荐流页面没开着（先刷一次）' };

    await cdp(page.webSocketDebuggerUrl, 'Page.bringToFront').catch(() => {});

    /** 取视口正中那个视频元素的位置（不用 active 标记，那个会掉） */
    const rectExpr = `(() => {
      const vh = innerHeight;
      const vids = [...document.querySelectorAll('video')].map((v) => ({ v, r: v.getBoundingClientRect() }));
      const hit = vids.find((x) => x.r.width > 200 && Math.abs(x.r.top + x.r.height / 2 - vh / 2) < vh / 2);
      if (!hit) return JSON.stringify(null);
      const r = hit.r;
      return JSON.stringify({
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        paused: hit.v.paused, t: hit.v.currentTime || 0,
      });
    })()`;

    const rect = await evalJson(page, rectExpr);
    if (rect === null || !(rect.w > 0) || !(rect.h > 0)) return { ok: false, reason: '没找到正在播放的视频区域' };

    // 播放起来（后台标签是被暂停的），并让播放器把首帧画出来
    await evalJson(
      page,
      `(() => { const v = [...document.querySelectorAll('video')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 200 && Math.abs(r.top + r.height / 2 - innerHeight / 2) < innerHeight / 2; }); if (v && v.paused) v.play().catch(() => {}); return JSON.stringify({ ok: true }); })()`,
    );
    await sleep(900);

    // 只截画面上部：底部压着作者/描述/点赞，那些字模型不需要（文字层已经单独给过）
    const clip = {
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: Math.round(rect.h * 0.72),
      scale,
    };

    const frames = [];
    for (let i = 0; i < want; i += 1) {
      const shot = await cdp(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'jpeg', quality: 72, clip }).catch(() => null);
      if (shot === null || typeof shot.data !== 'string' || shot.data === '') break;
      const data = Buffer.from(shot.data, 'base64');
      frames.push({
        data,
        mediaType: 'image/jpeg',
        width: Math.round(clip.width * scale),
        height: Math.round(clip.height * scale),
      });
      if (i + 1 < want) await sleep(intervalMs);
    }

    // 原来是暂停的就还原（别把用户的页面留在"被我按了播放"的状态）
    if (rect.paused === true) {
      await evalJson(
        page,
        `(() => { const v = [...document.querySelectorAll('video')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 200; }); if (v) v.pause(); return JSON.stringify({ ok: true }); })()`,
      );
    }

    if (frames.length === 0) return { ok: false, reason: '截图没抓到画面' };
    return { ok: true, frames };
  }

  /**
   * 轮询用的在线保障：浏览器离线时按 web.autoWake 决定是否自动拉起。
   * @returns {Promise<{ok: boolean, reason?: string, browser?: string, douyinTabs?: number}>} 状态
   */
  async function ensureOnline() {
    if (!opts().enabled) return { ok: false, reason: '网页通道已关闭（设置页 → 账号 → 网页通道）' };
    const st = await status();
    if (st.ok) return st;
    if (getConfig().web?.autoWake !== true) return st;
    const launched = await ensureBrowser();
    if (launched !== true) return { ok: false, reason: '浏览器离线且自动拉起未成功' };
    return status();
  }

  /**
   * 登录状态（只数 cookie 名字，不读值）。
   * @returns {Promise<{ok: boolean, loggedIn: boolean, reason?: string}>} 结果
   */
  async function loginState() {
    const page = await douyinPage();
    if (page === null) return { ok: false, loggedIn: false, reason: '窗口里没有抖音标签页' };
    try {
      const r = await cdp(page.webSocketDebuggerUrl, 'Network.getCookies', { urls: ['https://www.douyin.com'] });
      const names = (r.cookies ?? []).map((c) => c.name);
      const hit = LOGIN_COOKIES.filter((n) => names.includes(n));
      return { ok: true, loggedIn: hit.length > 0 };
    } catch (error) {
      return { ok: false, loggedIn: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    status,
    ensureOnline,
    listChats,
    listConversations,
    focusChat,
    loginState,
    sendMessage,
    readIncoming,
    readFeed,
    grabFrames,
    launchBrowser,
    openTab,
    publishVideo,
    port: () => opts().port,
  };
}

/**
 * 取 host；解析失败返回空串（不抛）。
 * @param {string} url 地址
 * @returns {string} host
 */
function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
