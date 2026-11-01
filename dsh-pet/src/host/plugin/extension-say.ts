/**
 * 扩展能力位：用户对宠物说的一句话，先问一圈登记过的能力插件要不要代劳。
 *
 * **为什么这层必须放在 pet 里**：宠物的对话框是 pet 自己的（`POST /chat` → 生成一句话），
 * 插件没有任何办法旁听那次输入。要"对宠物说人话就能干活"，只能由 pet 主动把话递出去；
 * 而 pet 一旦在代码里写死某个业务，就又变回了"每加一个功能改一次 pet"的老路。
 *
 * 所以这里的定位是**一个纯广播器**，三条硬边界：
 * 1. **pet 不认识任何业务**：只按 `$DSH_HOME/extensions.json` 里的清单逐个问，代码里不出现任何具体能力名。
 * 2. **只发本机**：`api` 必须是 127.0.0.1 / localhost / ::1，用户说的话不出这台机器。
 * 3. **认领必须显式**：插件回 `{ ok:true, claimed:true, ack }` 才算接管；超时、连不上、
 *    字段缺失一律当作"没接管"，宠物照常闲聊。任何插件的故障都不能让对话挂掉或变慢成秒级。
 *
 * 清单格式（插件启动时自己写入实际端口——桌面版 webServer 端口是动态的，写死端口必然会过期）：
 * ```json
 * { "extensions": [ { "id": "dsh-pet-xxx", "label": "某某", "api": "http://127.0.0.1:1234/dsh-xxx-7342", "order": 10 } ] }
 * ```
 * 也接受不带外壳的裸数组。非法条目静默丢弃（一个插件写坏清单，不该拖垮其他插件）。
 *
 * @module dsh-pet/src/host/plugin/extension-say
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 一条登记过的能力插件 */
export interface ExtensionEntry {
  /** 插件 id（清单里唯一） */
  readonly id: string;
  /** 展示名（ack 兜底文案与日志用） */
  readonly label: string;
  /** 该插件的路由前缀完整 URL，尾斜杠已剥 */
  readonly api: string;
  /** 询问顺序（小的先问） */
  readonly order: number;
  /**
   * 只递话、不在设置页列出来。
   *
   * 用于"功能和宿主合并在一起"的情形：它仍需要一个可被问到的地址，
   * 但设置页入口已经由宿主自己提供了，再列一次就成了两个入口。
   */
  readonly hidden: boolean;
}

/** 询问一次需要的信息 */
export interface ClaimRequest {
  /** 说话的是哪只宠物 */
  readonly pet: string;
  /** 用户原话（原样转发，不改写、不截断到语义之外） */
  readonly text: string;
}

/** 认领结果 */
export interface ClaimResult {
  /** 谁认领的 */
  readonly id: string;
  /** 给宠物用的回执（插件给什么说什么） */
  readonly ack: string;
}

/** 日志出口（只用到 warn，收窄到最小面） */
export interface ExtensionSayLog {
  warn(message: string): void;
}

/** 工厂输入 */
export interface ExtensionSayInput {
  /** DSH 用户根（`$DSH_HOME`），清单在它下面的 extensions.json */
  readonly dshHome: string;
  /** 日志 */
  readonly log: ExtensionSayLog;
  /** 注入 fetch 以便单测（缺省用全局 fetch，缺失时整层自动失效） */
  readonly fetchImpl?: typeof fetch;
  /** 单次询问超时，默认 1200ms */
  readonly timeoutMs?: number;
  /** 清单缓存时长，默认 2000ms */
  readonly manifestTtlMs?: number;
  /** 时钟（测试注入） */
  readonly now?: () => number;
}

/** 只允许本机回环地址 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 是不是普通对象（非 null、非数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** api 是否是本机 http(s) 前缀 */
function isLocalHttp(api: string): boolean {
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOCAL_HOSTS.has(url.hostname);
}

/** 剥掉尾斜杠：拼接时不会出现 `//pet-say` */
function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * 把清单原文解析成可用条目（纯函数，可单测）。
 *
 * 校验项全部是"能不用就不用"的口径：任何一项不合格就丢弃该条，不抛错、不猜、不补默认 id。
 * @param raw - 解析后的 JSON（任意形状）
 * @returns 按 order 升序的合法条目
 */
export function parseExtensions(raw: unknown): ExtensionEntry[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.extensions) ? raw.extensions : [];
  const seen = new Set<string>();
  const out: ExtensionEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const api = typeof item.api === 'string' ? trimSlash(item.api.trim()) : '';
    if (id === '' || api === '' || seen.has(id)) continue;
    if (!isLocalHttp(api)) continue;
    const labelRaw = typeof item.label === 'string' ? item.label.trim() : '';
    const order = typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : Number.MAX_SAFE_INTEGER;
    seen.add(id);
    out.push({ id, label: labelRaw === '' ? id : labelRaw, api, order, hidden: item.hidden === true });
  }
  // order 相同按 id 排，保证同一份清单每次问的顺序一致（结果可复现，排障不用猜）
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * 创建扩展能力位。
 * @param deps - 输入（清单目录、日志与可选注入点）
 * @returns `claim()` 询问一次；`readManifest()` 读当前清单（排障用）
 */
export function createExtensionSay(deps: ExtensionSayInput) {
  const { dshHome, log } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 1200;
  const manifestTtlMs = deps.manifestTtlMs ?? 2000;
  const now = deps.now ?? Date.now;
  const manifestPath = join(dshHome, 'extensions.json');

  /** 清单缓存：插件启动才写一次文件，2s 缓存足够躲开连续对话时的重复读盘 */
  let cache: { at: number; entries: ExtensionEntry[] } | null = null;

  /**
   * 读当前清单（带短缓存）。
   * @returns 合法条目；文件缺失 = 没装任何扩展
   */
  const readManifest = async (): Promise<ExtensionEntry[]> => {
    if (cache !== null && now() - cache.at < manifestTtlMs) return cache.entries;
    let entries: ExtensionEntry[] = [];
    try {
      entries = parseExtensions(JSON.parse(await readFile(manifestPath, 'utf8')));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // 文件不存在是常态（没装扩展），不打日志；解析失败要报——那是真写坏了
      if (code !== 'ENOENT') {
        log.warn(`扩展清单读取失败（按无扩展处理）：${manifestPath}（${e instanceof Error ? e.message : String(e)}）`);
      }
      entries = [];
    }
    cache = { at: now(), entries };
    return entries;
  };

  /**
   * 问一个扩展要不要接管这句话。
   * @param entry - 清单条目
   * @param req - 宠物与用户原话
   * @param signal - 外部取消信号（对话被关掉时不必等结果）
   * @returns 认领结果，或 null（没接管 / 任何异常）
   */
  const askOne = async (
    entry: ExtensionEntry,
    req: ClaimRequest,
    signal?: AbortSignal,
  ): Promise<ClaimResult | null> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const merged = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    try {
      const res = await fetchImpl(`${entry.api}/pet-say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pet: req.pet, text: req.text }),
        signal: merged,
      });
      if (!res.ok) {
        // 非 2xx 也记一行：插件路径写错时表现为"宠物就是不搭理它"，没有这行日志根本查不出来
        log.warn(`扩展 ${entry.id} 的 /pet-say 返回 HTTP ${res.status}（按未接管处理）`);
        return null;
      }
      const body: unknown = await res.json();
      if (!isRecord(body) || body.ok !== true || body.claimed !== true) return null;
      const ack = typeof body.ack === 'string' ? body.ack.trim() : '';
      return { id: entry.id, ack: ack === '' ? `交给「${entry.label}」了` : ack };
    } catch (e) {
      // 超时 / 连接被拒 / JSON 坏：都只是"这个扩展没接管"，用户不该看到技术细节，留一行日志够排障
      log.warn(`扩展 ${entry.id} 未接管这句话：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  /**
   * 逐个询问，取第一个认领者。
   *
   * 并发发出但按 order 取结果：先问的扩展即使回得慢，也优先于后问的（顺序即优先级）。
   * @param req - 宠物与用户原话
   * @param signal - 外部取消信号
   * @returns 第一个认领结果；无人认领返回 null
   */
  const claim = async (req: ClaimRequest, signal?: AbortSignal): Promise<ClaimResult | null> => {
    if (req.text.trim() === '') return null;
    // 老运行时没有 fetch：这一层静默失效，宠物照常闲聊（不报错、不降级成假执行）
    if (typeof fetchImpl !== 'function') return null;
    const entries = await readManifest();
    if (entries.length === 0) return null;
    const results = await Promise.all(entries.map((entry) => askOne(entry, req, signal)));
    return results.find((r): r is ClaimResult => r !== null) ?? null;
  };

  return { claim, readManifest, manifestPath };
}
