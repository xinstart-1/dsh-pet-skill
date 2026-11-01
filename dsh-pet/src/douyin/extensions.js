/**
 * 扩展清单自注册：让 pet 知道"有我这个能力插件，地址是这个"。
 *
 * **为什么插件自己写、而不是 pet 扫目录猜**：pet 不该知道有哪些插件（否则每加一个功能就要改 pet），
 * 而桌面版 DSH 的 webServer 端口是**动态**的，写死在配置里下次启动就过期。所以唯一可靠的做法是
 * 插件启动时把自己当前的真实端口写进 `$DSH_HOME/extensions.json`，pet 每次要用时现读（带短缓存）。
 *
 * 三条分寸：
 * 1. **只动自己那条**：别人的条目原样保留，哪怕格式不对——我们没有资格替别人重写清单。
 * 2. **写失败不影响插件**：清单是"锦上添花"的通道，写不进去只记一行日志，抖音功能本身照常。
 * 3. **原子写**：用 writeJsonAtomic（临时文件 + rename），避免 pet 读到半截 JSON 就当没有扩展。
 *
 * @module dsh-pet-douyin/extensions
 */
import { join } from 'node:path';
import { PLUGIN_ID, dshHome, readJson, writeJsonAtomic } from './util.js';

/** 本插件在清单里的展示名（pet 的兜底回执文案会用到） */
export const EXTENSION_LABEL = '抖音';

/**
 * 询问顺序。数字小的先问——同一条话可能有多个插件都想管，
 * 抖音动作（发/回消息）比通用动作更具体，所以排在偏前。
 */
export const EXTENSION_ORDER = 20;

/**
 * 清单文件路径。
 * @param {string} [home] DSH 用户根（缺省取 dshHome()，测试可传）
 * @returns {string} 绝对路径
 */
export function manifestPath(home) {
  return join(home ?? dshHome(), 'extensions.json');
}

/**
 * 取出清单里的条目数组（兼容裸数组与 `{extensions:[]}` 两种形状）。
 *
 * 与 pet 侧的 parseExtensions 不同：这里**不校验**别人的条目——只保证自己不会把别人的东西弄丢。
 * @param {unknown} raw 读到的原值
 * @returns {any[]} 条目数组（无法识别时为空数组）
 */
export function entriesOf(raw) {
  if (Array.isArray(raw)) return raw.slice();
  if (raw !== null && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).extensions)) {
    return /** @type {any} */ (raw).extensions.slice();
  }
  return [];
}

/**
 * 把本插件那条写进清单（幂等：先摘掉同 id 的旧条目再放新的）。
 *
 * 纯函数，便于单测；不读盘、不写盘。
 * @param {unknown} raw 现有清单
 * @param {{id: string, api: string, label?: string, order?: number}} self 自己这条
 * @returns {{extensions: any[]}} 新清单
 */
export function upsertSelf(raw, self) {
  const others = entriesOf(raw).filter((item) => {
    // 只按 id 判重；没有 id 的条目（别人的坏数据）一律保留，不替人清理
    return !(item !== null && typeof item === 'object' && item.id === self.id);
  });
  return {
    extensions: [
      ...others,
      {
        id: self.id,
        label: self.label ?? EXTENSION_LABEL,
        api: self.api,
        order: self.order ?? EXTENSION_ORDER,
        // 合并进 dsh-pet 之后：这条只用于「宠物对话把话递过来」，不再作为独立设置页入口，
        // 所以标记 hidden —— 清单一处写，UI 侧通用过滤，不需要谁认识谁
        hidden: self.hidden === true,
      },
    ],
  };
}

/**
 * 从清单里摘掉本插件那条（插件卸载/关闭时用）。
 * @param {unknown} raw 现有清单
 * @param {string} id 自己的 id
 * @returns {{extensions: any[]}} 新清单
 */
export function removeSelf(raw, id) {
  return {
    extensions: entriesOf(raw).filter((item) => !(item !== null && typeof item === 'object' && item.id === id)),
  };
}

/**
 * 注册自己（幂等，可反复调用——端口变了就以最新一次为准）。
 *
 * `prefix` 是**扩展 API 根**（本插件的 API 都在 `/api` 下，所以传 `/dsh-douyin-7341/api`）：
 * 对方只用 `${api}/pet-say` 拼一次，不该知道我们内部的 `/api` 分段。
 *
 * @param {{home?: string, port: number, prefix: string, log?: {warn: Function, info?: Function}}} args 参数
 * @returns {Promise<{ok: boolean, file: string, api?: string, reason?: string}>} 结果
 */
export async function registerSelf({ home, port, prefix, log }) {
  const file = manifestPath(home);
  const api = `http://127.0.0.1:${port}${prefix}`;
  if (!Number.isInteger(port) || port <= 0) return { ok: false, file, reason: '端口还没拿到' };
  try {
    const raw = await readJson(file, null);
    await writeJsonAtomic(file, upsertSelf(raw, { id: PLUGIN_ID, api, hidden: true }));
    return { ok: true, file, api };
  } catch (error) {
    // 写不进去不是致命问题：pet 只会认为"没有扩展"，抖音自己的功能不受影响
    log?.warn?.(`扩展清单写入失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, file, api, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 注销自己（插件 stop 时调，尽力而为）。
 * @param {{home?: string, log?: {warn: Function}}} [args] 参数
 * @returns {Promise<void>} 无
 */
export async function unregisterSelf({ home, log } = {}) {
  const file = manifestPath(home);
  try {
    const raw = await readJson(file, null);
    if (raw === null) return; // 没有清单就没什么可摘的
    await writeJsonAtomic(file, removeSelf(raw, PLUGIN_ID));
  } catch (error) {
    log?.warn?.(`扩展清单注销失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
  }
}
