/**
 * 运行时状态路由：`GET /runtime` 快照与 `POST /runtime/electron` 重新拉起桌面运行时。
 *
 * 只读快照 + 一个动作端点；状态的生产归 ./runtime-status（spawn 埋点写入），这里不生成。
 * POST 的语义是「照重启的路径再来一次」——restartDesktop 会停旧拉新，startHelper 发现
 * Electron 缺失时自动进入下载；下载是否真的发生由快照的 `downloading` 告诉前端。
 * @module dsh-pet/src/host/routes/runtime
 */
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** 运行时状态领域：未命中返回 undefined，命中返回应答。 */
export async function handleRuntimeRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { requestRestart, runtime } = deps;
  const { method, rest } = input;

  // 运行时快照（设置页「运行状态」卡的数据源）：只读、无副作用。
  if (rest === 'runtime') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult(runtime.snapshot());
  }

  // 重新拉起桌面运行时：Electron 已就位 = 直接拉起 Helper；缺失 = 走同一条路径进入下载。
  // 异步执行、立刻回 200（与 /reload 同一处境——发起者可能就是即将被重启的 helper 自己）；
  // 进展用 GET /runtime 的 `downloading` / `ready` 轮询，这里不给即时结果。
  if (rest === 'runtime/electron') {
    if (method !== 'POST') return methodNotAllowed();
    if (runtime.snapshot().electron.downloading) {
      return failResult('busy', '已经在下载中，等这一轮结束再看快照');
    }
    void requestRestart();
    return okResult({ triggered: true });
  }

  return undefined;
}
