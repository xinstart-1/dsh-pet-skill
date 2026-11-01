/**
 * 运行时状态（`GET /runtime` 的数据源）：桌面运行时（Electron）的就位 / 下载中 / 失败原因。
 *
 * 只记三件事——当前就位情况（实时读盘判定，不信缓存）、是否正在下载、最后一次失败的原文与时间。
 * 其余一律不记：helper 进程的死活归 ./plugin/desktop（有退避熔断，快照不该复制第二份真相），
 * 模型可用性归 LLM 调用方（探测一次的代价是一次真实生成）。
 *
 * 内存态，不落盘：插件重启即重置，这与「重启后马上会重新探测 / 重试下载」的实际行为一致。
 * @module dsh-pet/src/host/runtime-status
 */
import type { FileLogger } from './log-file.ts';

/** Electron 运行时的当前状态。 */
export interface ElectronStatus {
  /** 可执行文件已就位（实时探测，不缓存）。 */
  ready: boolean;
  /** 就位时的可执行文件路径；未就位为 null。 */
  path: string | null;
  /** 目标版本（默认 43.3.0，可被 DSH_PET_ELECTRON_VERSION 覆盖）。 */
  version: string;
  /** 是否正在下载。 */
  downloading: boolean;
  /** 最后一次下载失败的原文；从未失败过为 null。成功下载不清除它——历史失败仍然值得被看见。 */
  lastError: string | null;
  /** 最后一次失败的时间（epoch ms）；从未失败过为 null。 */
  lastErrorAt: number | null;
}

/** 运行时快照（`GET /runtime` 的响应体）。 */
export interface RuntimeSnapshot {
  electron: ElectronStatus;
  /** 日志文件路径（桌面版没有控制台，排障只看它）。 */
  logPath: string;
  /** Electron 下载落地目录。 */
  electronDir: string;
  /** 应用模式（DSH_PET_IN_PROCESS=1）：窗口由本进程建，永不下载 Electron，前端据此隐藏下载项。 */
  inProcess: boolean;
}

/** 运行时状态存储：spawn 埋点写入，路由读取。 */
export interface RuntimeStatusStore {
  /** 下载开始（同一次下载只计一次；重复 begin 幂等）。 */
  beginElectronDownload(): void;
  /** 下载收尾（成功或失败都算收尾）；`message` 失败时给原因。 */
  endElectronDownload(ok: boolean, message?: string): void;
  /** 组装当前快照；Electron 就位情况实时探测。 */
  snapshot(): RuntimeSnapshot;
}

/** createRuntimeStatus 的输入。 */
export interface RuntimeStatusOptions {
  /** 实时解析 Electron 可执行文件（传入 resolveElectronPath；为 null 的参数化是为了测试注入）。 */
  resolve: () => string | undefined;
  /** 目标版本号（与下载器同一份来源）。 */
  version: () => string;
  /** 下载落地目录（展示用）。 */
  electronDir: () => string;
  /** 日志文件路径（展示用）。 */
  logPath: () => string;
}

/**
 * 创建运行时状态存储。
 *
 * @param options - 探测函数与展示路径的来源；全部显式传入，模块内不读全局。
 * @returns 写入接口 + 快照读取。
 */
export function createRuntimeStatus(options: RuntimeStatusOptions): RuntimeStatusStore {
  let downloading = false;
  let lastError: string | null = null;
  let lastErrorAt: number | null = null;

  return {
    beginElectronDownload(): void {
      downloading = true;
    },

    endElectronDownload(ok: boolean, message?: string): void {
      downloading = false;
      if (!ok) {
        lastError = message ?? '下载失败（原因未知）';
        lastErrorAt = Date.now();
      }
    },

    snapshot(): RuntimeSnapshot {
      const path = options.resolve() ?? null;
      return {
        electron: {
          ready: path !== null,
          path,
          version: options.version(),
          downloading,
          lastError,
          lastErrorAt,
        },
        logPath: options.logPath(),
        electronDir: options.electronDir(),
        inProcess: process.env.DSH_PET_IN_PROCESS === '1',
      };
    },
  };
}

/**
 * 从文件日志器取路径的便捷重载：给装配处一行写完用。
 * `log` 缺 file（理论上不会）时退回空串，调用方按空串隐藏。
 *
 * @param log - 插件文件日志器。
 */
export function logPathOf(log: FileLogger): string {
  return log.file ?? '';
}
