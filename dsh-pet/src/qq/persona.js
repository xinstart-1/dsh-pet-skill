/**
 * 人设取用：**唯一入口**，且只借用、不存第二份。
 *
 * 真源在宠物设置页那只宠物（`whisperPrompt`）。这里两条路：
 * 1. 宿主递来的 `personaOf`（进程内直取，改完人设下一句就生效）；
 * 2. 宿主没递时退回 `GET /dsh-pet-7340/persona`，带缓存（5 分钟）与失败退避（1 分钟）。
 *
 * 拿不到就返回空串——**不许编一个"QQ 助手"的人格出来**。那等于同一个人有两套性格，
 * 而且用户在宠物设置页改人设时永远改不到这边（抖音那边已经踩过这个坑）。
 *
 * @module dsh-pet-qq/persona
 */

/** 兜底路径的缓存有效期：改完人设最多 5 分钟后生效 */
const TTL_MS = 5 * 60 * 1000;
/** 借不到时的退避：1 分钟内不再试，别让每条回复都白等 2.5 秒 */
const RETRY_MS = 60 * 1000;

/**
 * 造人设取值函数。
 * @param {{provider?: ((petId: string) => string)|null, getPort: () => number, log: object, now?: () => number}} deps 依赖
 * @returns {(petId?: string) => Promise<string>} 取人设
 */
export function createPersonaSource({ provider = null, getPort, log, now = () => Date.now() }) {
  let cache = { at: 0, key: '', system: '' };

  return async function personaOf(petId = 'main') {
    const key = String(petId ?? '').trim() || 'main';

    if (typeof provider === 'function') {
      try {
        return String((await provider(key)) ?? '');
      } catch (error) {
        log.warn(`向宠物借人设失败（${key}）：${error instanceof Error ? error.message : String(error)}`);
        return '';
      }
    }

    const at = now();
    if (cache.key === key && at - cache.at < TTL_MS) return cache.system;

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
      cache = { at, key, system };
      return system;
    } catch (error) {
      log.warn(`向宠物借人设失败（${key}）：${error instanceof Error ? error.message : String(error)}`);
      cache = { at: at - TTL_MS + RETRY_MS, key, system: '' };
      return '';
    }
  };
}
