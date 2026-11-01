/**
 * HTTP 层：把服务门面映射到**一个**前缀 `/dsh-douyin-7341` 下，并托管设置页静态资源。
 *
 * 只监听 127.0.0.1（DSH 自己的 Web 服务就这么绑的）、无鉴权——本机任何进程都能调，
 * 所以**不要**把这个端口转发到公网。
 *
 * 权限闸门不在这层：这层只把 `?pet=` 传下去，并把能力层抛的三种失败映射成状态码：
 * 没授牌 → 403 `no-grant`；配额用完 → 429 `quota`；没绑账号/授权过期 → 409 `not-authorized`。
 *
 * @module dsh-pet-douyin/router
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCaption } from './caption.js';
import { normalizeConfig } from './config.js';
import { copyToClipboard, openPath, openUrl } from './util.js';

/** 路由前缀（带随机尾号，避免与别的插件撞车） */
export const ROUTE_PREFIX = '/dsh-douyin-7341';

/** 设置页静态资源根 */
// 设置页静态资源根。
// 合并进 dsh-pet 之后由 scripts/copy-web.mjs 复制到 lib/douyin-web/——
// 单独一个目录名，不跟宿主将来可能有的 lib/web 抢位置。
const WEB_ROOT = fileURLToPath(new URL('./douyin-web/', import.meta.url));

/** 静态文件类型 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status 状态码
 * @param {any} obj 体
 * @returns {void}
 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 读 JSON 体（限 1 MiB）。
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<any>} 体
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('请求体超过 1 MiB');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 防目录穿越。
 * @param {string} rel 相对路径
 * @returns {string|undefined} 绝对路径（越界返回 undefined）
 */
function resolveWebPath(rel) {
  const clean = rel === '' || rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
  const target = resolve(normalize(join(WEB_ROOT, clean)));
  const rootWithSep = WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep;
  return target === WEB_ROOT || target.startsWith(rootWithSep) ? target : undefined;
}

/**
 * 把异常翻成 HTTP 响应。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {any} error 异常
 * @param {object} log 日志器
 * @returns {void}
 */
function sendError(res, error, log) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  if (code === 'no-grant') return sendJson(res, 403, { ok: false, error: message, reason: message, code: 'no-grant' });
  if (code === 'quota') return sendJson(res, 429, { ok: false, error: message, reason: message, code: 'quota' });
  if (/还没有绑定抖音账号|授权已过期|已解绑/.test(message)) {
    return sendJson(res, 409, { ok: false, error: message, reason: message, code: 'not-authorized' });
  }
  log.warn(`接口出错：${message}`);
  sendJson(res, 500, { ok: false, error: message, reason: message });
}

/**
 * 建路由。
 * @param {{service: object, log: object}} deps 依赖
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 处理器
 */
export function createRouter({ service, log }) {
  /**
   * 静态资源。
   * @param {import('node:http').ServerResponse} res 响应
   * @param {string} pathname 路径
   * @returns {Promise<boolean>} 是否已处理
   */
  async function serveStatic(res, pathname) {
    const file = resolveWebPath(pathname);
    if (file === undefined) return false;
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-cache',
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * API 分发。
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {import('node:http').ServerResponse} res 响应
   * @param {string} pathname 形如 `/api/state`
   * @param {URL} url URL（取 query）
   * @returns {Promise<void>} 完成
   */
  async function handleApi(req, res, pathname, url) {
    const route = `${req.method} ${pathname.slice('/api'.length)}`;
    const body = req.method === 'PUT' || req.method === 'POST' ? await readJsonBody(req) : undefined;

    switch (route) {
      /* ---- 状态与配置 ---- */
      case 'GET /state':
        return sendJson(res, 200, { ...service.state(), pets: await service.pets(), ffmpeg: await service.ffmpeg() });
      case 'GET /config':
        return sendJson(res, 200, { config: service.getConfig(), warnings: service.configWarnings() });
      case 'PUT /config': {
        const r = await service.saveConfig(body ?? {});
        return sendJson(res, r.ok ? 200 : 400, { ...r, state: service.state() });
      }
      case 'POST /toggle':
        return sendJson(res, 200, await service.toggle(body?.enabled === true));

      /* ---- 账号授权 ---- */
      case 'POST /auth/url': {
        const r = service.authorizeUrl();
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      case 'POST /auth/open': {
        const r = service.authorizeUrl();
        if (!r.ok || r.url === undefined) return sendJson(res, 400, r);
        return sendJson(res, 200, { ok: true, url: r.url, opened: await openUrl(r.url) });
      }
      case 'POST /auth/exchange': {
        const r = await service.exchangeCode(String(body?.code ?? ''));
        return sendJson(res, r.ok ? 200 : 400, { ...r, state: service.state() });
      }
      case 'POST /auth/refresh':
        return sendJson(res, 200, await service.refreshNow());
      case 'POST /auth/current':
        return sendJson(res, 200, { ...(await service.setCurrent(String(body?.openId ?? ''))), state: service.state() });
      case 'POST /auth/unlink':
        return sendJson(res, 200, { ...(await service.unlink(String(body?.openId ?? ''))), state: service.state() });

      /* ---- 授牌 ---- */
      case 'GET /pets':
        return sendJson(res, 200, { pets: await service.pets() });
      case 'POST /grants':
        return sendJson(
          res,
          200,
          await service.setGrant({
            pet: body?.pet,
            caps: body?.caps,
            ttlHours: body?.ttlHours,
            accountOpenId: body?.accountOpenId,
            quota: body?.quota,
            autonomy: body?.autonomy,
          }),
        );
      case 'POST /grants/revoke':
        return sendJson(res, 200, await service.revokeGrant(String(body?.pet ?? '')));

      /* ---- 能力（宠物路径，全部过授牌） ---- */
      case 'GET /videos': {
        const pet = url.searchParams.get('pet') ?? '';
        const force = url.searchParams.get('force') === '1';
        return sendJson(res, 200, await service.browse({ pet, force }));
      }
      case 'POST /share':
        return sendJson(res, 200, await service.share({ pet: String(body?.pet ?? ''), itemId: body?.itemId, open: body?.open === true }));
      case 'POST /dm':
        return sendJson(
          res,
          200,
          await service.dm({
            pet: String(body?.pet ?? ''),
            topic: String(body?.topic ?? ''),
            to: String(body?.to ?? ''),
            openApp: body?.openApp === true,
          }),
        );
      case 'POST /feed':
        return sendJson(res, 200, await service.openFeed({ pet: String(body?.pet ?? ''), app: body?.app === true }));
      case 'POST /feed/scan':
        return sendJson(res, 200, await service.scanFeed({
          pet: String(body?.pet ?? ''),
          limit: body?.limit,
          share: body?.share,
          to: body?.to,
        }));
      case 'POST /pet-publish':
        return sendJson(res, 200, await service.publish({ pet: String(body?.pet ?? ''), file: body?.file }));
      // 试一句：按当前人设生成回复，不发送（调提示词用）
      case 'POST /reply-preview':
        return sendJson(res, 200, await service.previewReply({ peer: body?.peer, text: body?.text }));
      // 网页发布：上传 + 填标题（+ 可选点发布）。会跑几十秒到几分钟（转码），
      // 调用方必须给足超时——设置页那边用的是 5 分钟。
      case 'POST /publish-web':
        return sendJson(
          res,
          200,
          await service.publishToDouyin({
            pet: String(body?.pet ?? ''),
            file: body?.file,
            title: body?.title,
            autoPublish: typeof body?.autoPublish === 'boolean' ? body.autoPublish : undefined,
          }),
        );

      /* ---- 一句话入口：给桌宠 / 对话面板用 ---- */
      case 'POST /say': {
        const r = await service.say({ pet: String(body?.pet ?? ''), text: String(body?.text ?? '') });
        // 认不出意图 / 没授牌都不算服务端故障，用 200 带 ok:false 更省事（调用方看 ok）
        return sendJson(res, 200, r);
      }
      // 宠物对话框里的一句话：pet 的扩展能力位会先问到这里。
      // 立刻回执（claimed + ack），执行放后台——超时预算在 pet 那边只有 1.2s，不能在这里等出结果。
      case 'POST /pet-say':
        return sendJson(res, 200, await service.petSay({ pet: String(body?.pet ?? ''), text: String(body?.text ?? '') }));
      case 'GET /pets':
        return sendJson(res, 200, { ok: true, pets: await service.refreshPets() });
      case 'GET /web/status':
        return sendJson(res, 200, await service.webStatus());
      case 'GET /llm-probe':
        return sendJson(res, 200, await service.probe());

      /* ---- 发布包（人工路径，不受授牌约束） ---- */
      case 'GET /candidates':
        return sendJson(res, 200, await service.scan());
      case 'POST /prepare': {
        const r = await service.prepare({ file: body?.file, reason: body?.reason ?? '设置页手动' });
        return sendJson(res, r.ok ? 200 : 409, r);
      }
      case 'GET /packs':
        return sendJson(res, 200, { packs: await service.listPacks(Number(url.searchParams.get('limit')) || 20) });
      case 'POST /packs/mark': {
        const id = String(body?.id ?? '');
        const status = String(body?.status ?? '');
        if (!['published', 'skipped', 'packed'].includes(status)) return sendJson(res, 400, { error: '状态只能是 published/skipped/packed' });
        const updated = await service.mark(id, status);
        return sendJson(res, updated === null ? 404 : 200, { ok: updated !== null, entry: updated });
      }
      case 'POST /open-upload':
        return sendJson(res, 200, await openUrl(service.getConfig().pack.uploadPage));

      /* ---- 试验台与杂项 ---- */
      case 'POST /peek':
        return sendJson(res, 200, await service.peekVideos());
      case 'POST /caption-preview': {
        const cfg = service.getConfig();
        const captionCfg =
          body?.caption !== null && typeof body?.caption === 'object' ? normalizeConfig({ caption: body.caption }).config.caption : cfg.caption;
        return sendJson(
          res,
          200,
          composeCaption(captionCfg, {
            name: String(body?.name ?? '示例视频'),
            mtime: new Date(),
            index: 1,
            total: 1,
            durationSec: Number(body?.durationSec) || 15,
            dir: '待发目录',
          }),
        );
      }
      case 'POST /clipboard':
        return sendJson(res, 200, await copyToClipboard(String(body?.text ?? '')));
      case 'POST /open-url':
        return sendJson(res, 200, await openUrl(String(body?.url ?? '')));
      case 'POST /open-path':
        return sendJson(res, 200, openPath(String(body?.path ?? '')));
      case 'POST /pet-test':
        return sendJson(res, 200, await service.petTest());
      case 'GET /log':
        return sendJson(res, 200, {
          file: service.paths.logFile,
          entries: log.list().slice(0, Math.min(200, Number(url.searchParams.get('limit')) || 60)),
        });

      default:
        return sendJson(res, 404, { error: `未知接口：${route}` });
    }
  }

  /**
   * 总入口。
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {import('node:http').ServerResponse} res 响应
   * @returns {Promise<void>} 完成
   */
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : url.pathname;
    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url);
      if (req.method === 'GET' && (await serveStatic(res, pathname))) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh-pet-douyin: 404');
    } catch (error) {
      if (!res.headersSent) sendError(res, error, log);
      else if (!res.writableEnded) res.end();
    }
  };
}
