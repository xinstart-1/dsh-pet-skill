/**
 * HTTP 层：把服务门面映射到**一个**前缀 `/dsh-qq-7342` 下，并托管设置页。
 *
 * 只监听 127.0.0.1（跟着 DSH 自己的 Web 服务走）、无鉴权——本机任何进程都能调。
 * 所以这里的接口只有"看状态 / 改配置 / 连断 / 手动发一条"，**没有任何批量操作**：
 * 一个无鉴权的本地端口不该具备"一次发给一百个人"的能力。
 *
 * 业务校验（能不能回、额度够不够）不在这层——那在 policy 与 service 里；
 * 这层只负责把参数变成服务调用，把异常翻成状态码。
 *
 * @module dsh-pet-qq/router
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE_PREFIX } from './config.js';

export { ROUTE_PREFIX };

/** 设置页静态资源根（构建时由 scripts/copy-web.mjs 拷到 lib/qq-web/） */
const WEB_ROOT = fileURLToPath(new URL('./qq-web/', import.meta.url));

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
 * 写 JSON。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status 状态码
 * @param {any} body 体
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
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
 * 建路由。
 * @param {{service: object, log: object, napcat: object}} deps 依赖
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 处理器
 */
export function createRouter({ service, log, napcat }) {
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
   * @returns {Promise<void>} 完成
   */
  async function handleApi(req, res, pathname) {
    const route = `${req.method} ${pathname.slice('/api'.length)}`;
    const body = req.method === 'PUT' || req.method === 'POST' ? await readJsonBody(req) : undefined;

    switch (route) {
      case 'GET /state':
        return sendJson(res, 200, {
          ok: true,
          ...service.state(),
          // 模型是异步取的（要问宿主），放在状态里比让前端再打一次接口省事
          model: await service.modelLabel(),
          config: service.publicConfig(),
          meta: service.configMeta(),
        });

      case 'GET /config':
        return sendJson(res, 200, { ok: true, config: service.publicConfig(), meta: service.configMeta() });

      case 'PUT /config': {
        const r = await service.saveConfig(body ?? {});
        return sendJson(res, r.ok ? 200 : 400, {
          ...r,
          ok: r.ok,
          state: service.state(),
          config: service.publicConfig(),
        });
      }

      case 'POST /toggle':
        return sendJson(res, 200, { ...(await service.toggle(body?.enabled === true)), state: service.state() });

      case 'POST /connect':
        return sendJson(res, 200, { ok: true, ...service.connect() });

      case 'POST /disconnect':
        return sendJson(res, 200, { ok: true, ...service.disconnect() });

      case 'POST /test': {
        const r = await service.test();
        return sendJson(res, r.ok ? 200 : 409, r);
      }

      case 'POST /say': {
        const r = await service.say({
          to: String(body?.to ?? ''),
          kind: body?.kind === 'group' ? 'group' : 'private',
          text: String(body?.text ?? ''),
        });
        return sendJson(res, r.ok ? 200 : 400, r);
      }

      case 'GET /logs':
        return sendJson(res, 200, { ok: true, items: service.logs(numberOf(req)) });

      case 'GET /audit':
        return sendJson(res, 200, { ok: true, items: service.audit(numberOf(req)) });

      case 'GET /persona': {
        const text = await service.personaOf('main');
        return sendJson(res, 200, { ok: true, system: text, bytes: text.length });
      }

      // ---------------- 网关（NapCat）安装器 ----------------
      // 这几个接口只操作本机上的文件与子进程，**不涉及任何 QQ 协议操作**，
      // 所以放在无鉴权的本地端口上没有扩大攻击面：能调它的人本来就能直接动磁盘。
      case 'GET /napcat':
        return sendJson(res, 200, { ok: true, ...(await napcat.status()) });

      case 'POST /napcat/unpack': {
        const r = await napcat.unpack();
        return sendJson(res, r.ok ? 200 : 409, { ...r, status: await napcat.status() });
      }

      case 'POST /napcat/config': {
        // 端口取插件配置里的 wsUrl（用户可能改成 3010 之类），token 复用已存的
        const cfg = service.getConfig();
        const port = Number(/:(\d{2,5})/.exec(String(cfg.gateway?.wsUrl ?? ''))?.[1] ?? 0) || 3001;
        const r = await napcat.writeConfig({ port, token: cfg.gateway?.token ?? '' });
        if (r.ok) {
          // 回填：让用户不用手抄 token（抄错是这条链路最常见的失败）
          await service.saveConfig({ gateway: { token: r.token, wsUrl: r.wsUrl } });
        }
        return sendJson(res, r.ok ? 200 : 409, { ...r, status: await napcat.status() });
      }

      case 'POST /napcat/launch': {
        const r = await napcat.launch({ uin: String(service.getConfig().account?.selfId ?? '') });
        return sendJson(res, r.ok ? 200 : 409, { ...r, status: await napcat.status() });
      }

      case 'POST /napcat/stop': {
        const r = await napcat.stop();
        return sendJson(res, 200, { ...r, status: await napcat.status() });
      }

      default:
        return sendJson(res, 404, { ok: false, reason: `没有这个接口：${route}` });
    }
  }

  /** 取 `?limit=`（GET 请求从 URL 里读） */
  function numberOf(req) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    return Number(url.searchParams.get('limit') ?? 0) || undefined;
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(new RegExp(`^${ROUTE_PREFIX}`), '') || '/';
    try {
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return await handleApi(req, res, pathname);
      }
      if (req.method === 'GET' && (await serveStatic(res, pathname))) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh-pet-qq: 404');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`接口出错：${message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, reason: message });
      else if (!res.writableEnded) res.end();
    }
  };
}
