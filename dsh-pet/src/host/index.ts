/**
 * 插件入口：Cordis 插件，把 host 半侧的配置、路由、斜杠命令、轮询与桌面 Helper 装配到 ctx。
 * 装配顺序不能改：`getHandlePetRoute` 惰性取用（`httpRoute` 在本函数后段才创建），`startHelper` 必须最后调用。
 * @module dsh-pet/src/host/index
 */
import { createHostSetup } from './plugin/setup.ts';
import { createHttpRoute, registerHttpRoute } from './plugin/http-route.ts';
import { registerLifecycle } from './plugin/lifecycle.ts';
import { registerChatCommand } from './plugin/command-chat.ts';
import { registerPetCommand } from './plugin/command-pet.ts';
import { registerLoops } from './plugin/loops.ts';
import { registerBalanceCommand } from './plugin/command-balance.ts';
import { registerSessionWatch } from './plugin/session-watch.ts';
import { createDesktopHelper } from './plugin/desktop-helper.ts';
import { createBalancePoll } from './plugin/balance-poll.ts';
import { createChatMemory } from './plugin/chat-memory.ts';
import { createSessionNotify } from './plugin/session-notify.ts';
import { createPetLookup } from './plugin/pet-lookup.ts';
import { createDownloadReport } from './plugin/download-report.ts';
import { createWorkStatusBridge } from './plugin/work-status-bridge.ts';
import { findPetInstance, readAllConfig } from './config.ts';
import { composeSystemPrompt, petPersona } from './persona.ts';
import { createRuntimeStatus } from './runtime-status.ts';
import { electronLandingDir, resolveElectronPath } from './helper-process.ts';
import { apply as applyDouyin } from '../douyin/index.js';
import { apply as applyQQ } from '../qq/index.js';
import type { PetRouteDeps } from './routes/types.ts';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ llm（对话模型调用）+ commands（/balance 斜杠命令）+ connection（桌面 Helper「打开网站」用的已鉴权站点 URL） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands', 'connection'];

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由与斜杠命令（/balance /pet /chat）；ctx 暂用 any（peer 类型包本地不可解析）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  const setup = createHostSetup(ctx);
  const {
    userRoot,
    log,
    configPaths,
    thumbUserRoot,
    memeDirsFor,
    standaloneAiPolicy,
    state,
    playback,
    workStatus,
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
    optionalService,
  } = setup;
  const workStatusBridge = createWorkStatusBridge({ state, workStatus });
  const { publishWorkStatus, stopWorkStatusFlush } = workStatusBridge;
  const downloadReport = createDownloadReport({
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
    publishWorkStatus,
    workStatus,
  });
  const { reportDownload, stopDownloadSlotTimer } = downloadReport;
  const petLookup = createPetLookup({ state });
  const { lock } = petLookup;
  const sessionNotify = createSessionNotify({ ctx, publishWorkStatus, state, workStatus });
  const {
    pushNotifyFrame,
    turnFlags,
    terminalTimers,
    lastTodoText,
    toolsInFlight,
    bumpToolsInFlight,
    cancelTerminalCleanup,
    scheduleTerminalCleanup,
    notifyActivityTimers,
    scheduleCompletionNotify,
  } = sessionNotify;
  const chatMemory = createChatMemory({ ctx, configPaths, log, memeDirsFor, state, userRoot, optionalService });
  const { lastWhisperAt, publishWhisper, chatWithPet, getActivePetId, setActivePetId } = chatMemory;

  // 运行时状态（/runtime 的数据源）：Electron 就位情况实时探测，下载开始 / 结束由 spawn 埋点写入。
  // 在 createDesktopHelper 之前创建——埋点出口要递进去，快照又只依赖纯探测函数，先后顺序天然成立。
  const runtimeStatus = createRuntimeStatus({
    resolve: () => resolveElectronPath(),
    version: () => process.env.DSH_PET_ELECTRON_VERSION || '43.3.0',
    electronDir: () => electronLandingDir(),
    logPath: () => log.file ?? '',
  });

  const balancePoll = createBalancePoll({ ctx, configPaths, getActivePetId, log, state });
  const { effectivePetList, balancePeriodSec, whisperPeriodSec, refreshBalance, resolveActivePetId, petDisplayName } =
    balancePoll;

  const desktopHelper = createDesktopHelper({
    ctx,
    configPaths,
    effectivePetList,
    log,
    reportDownload,
    thumbUserRoot,
    runtimeStatus,
    // 惰性取用：handlePetRoute 在下方装配，Helper 只在启动/收请求时才真正调用它
    getHandlePetRoute: () => httpRoute.handlePetRoute,
  });
  const { startHelper, stopHelper, markDisposed } = desktopHelper;

  const deps: PetRouteDeps = {
    ...setup,
    ...petLookup,
    ...workStatusBridge,
    ...chatMemory,
    ...balancePoll,
    ...desktopHelper,
    ...sessionNotify,
    runtime: runtimeStatus,
    ctx,
  };
  const httpRoute = createHttpRoute(deps);
  registerHttpRoute(ctx, httpRoute.handlePetRoute);

  registerSessionWatch({
    ctx,
    bumpToolsInFlight,
    cancelTerminalCleanup,
    lastTodoText,
    notifyActivityTimers,
    publishWorkStatus,
    pushNotifyFrame,
    scheduleCompletionNotify,
    scheduleTerminalCleanup,
    terminalTimers,
    toolsInFlight,
    turnFlags,
    workStatus,
  });

  registerBalanceCommand({ ctx, refreshBalance });

  registerLoops({
    ctx,
    balancePeriodSec,
    configPaths,
    lastWhisperAt,
    lock,
    log,
    publishWhisper,
    refreshBalance,
    standaloneAiPolicy,
    whisperPeriodSec,
  });

  registerPetCommand({ ctx, effectivePetList, petDisplayName, resolveActivePetId, setActivePetId });

  registerChatCommand({ ctx, chatWithPet, log, publishWhisper, resolveActivePetId });

  registerLifecycle({
    ctx,
    lock,
    markDisposed,
    playback,
    state,
    stopDownloadSlotTimer,
    stopHelper,
    stopWorkStatusFlush,
  });

  // 人设出口（给内置技能用）：真源只有一份——宠物设置页里那只宠物的人设，这里按 id 现取现拼。
  // 与 `GET /persona` 走同一个拼装点（`persona.ts`），只是省掉一次 HTTP 与缓存：
  // 技能要人设时问这一个函数即可，谁都不许自己再写一份人格。
  const personaOf = (petId: string): string => {
    const id = String(petId ?? '').trim() || 'main';
    const found =
      findPetInstance(readAllConfig(configPaths), id) ?? findPetInstance(readAllConfig(configPaths), 'main');
    if (!found) return '';
    return composeSystemPrompt({
      prompt: petPersona(found.conf, found.pet),
      name: String(found.pet.name ?? ''),
      id: String(found.pet.id ?? id),
      now: new Date(),
    });
  };

  // 抖音能力（2026-10-28 合并进来，不再是独立插件）。
  // 它自带路由前缀 /dsh-douyin-7341、自己的数据目录与设置页，和桌宠这边只靠 HTTP 互相说话。
  // 合并的理由：两份副本并存才是当年腐烂的根源；只留一份之后，"改哪儿去改哪儿"不再需要纪律约束。
  // 注意它需要 llm / agentDefaultModel / webServer —— 本插件的 inject 已经包含，不需要额外声明。
  // 人设直接以函数形式递过去（进程内直取，不再绕 HTTP、不再有 5 分钟缓存）。
  applyDouyin(ctx, { personaOf });

  // QQ 接管（2026-10-29）：OneBot v11 网关 + 自己的路由前缀 /dsh-qq-7342 与数据目录。
  // 与抖音同一条边界——只借人设（personaOf）与 HTTP 通道，不碰桌宠内部状态。
  // 默认总开关关、试运行开：装完什么都不做，除非用户在设置页里亲手打开。
  applyQQ(ctx, { personaOf });

  // 路由就绪后拉起桌面 Helper（Electron 缺失时仅告警，不影响 DSH 与浏览器 overlay）
  startHelper();
}
