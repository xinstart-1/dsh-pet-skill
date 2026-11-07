/**
 * 轮询循环：余额定时刷新与碎碎念定时触发，随插件卸载一并停止。
 *
 * 不实现取数与文案（归 balance-poll / chat-memory），只负责节奏与生命周期。
 * @module dsh-pet/src/host/plugin/loops
 */
import { findPetInstance, flattenPetList, readAllConfig } from '../config.ts';
import { automaticWhisperSchedule } from '../whisper-policy.ts';
import {
  collectAwareness,
  collectWindows,
  pickNotableWindows,
  rememberAwareness,
  speakReason,
  type AwarenessSample,
  type Runner,
} from '../awareness.ts';
import { execFile } from 'node:child_process';

/**
 * 桌面窗口探针的命令执行器。
 *
 * 抽成常量是为了可替换：单元测试传假实现就能离线验解析；运行时用 execFile 调系统命令。
 * `windowsHide` 必须开：否则每次采样都会闪一个黑框。
 */
const defaultRunner: Runner = (cmd, args, timeoutMs = 6000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? '') });
    });
  });
import type { BalancePoll } from './balance-poll.ts';
import type { ChatMemory } from './chat-memory.ts';
import type { PetLookup } from './pet-lookup.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';

/** 轮询循环的输入。 */
export type LoopsInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
} & Pick<BalancePoll, 'balancePeriodSec'> &
  Pick<HostSetup, 'configPaths'> &
  Pick<ChatMemory, 'lastWhisperAt'> &
  Pick<PetLookup, 'lock'> &
  Pick<HostSetup, 'log'> &
  Pick<ChatMemory, 'publishWhisper'> &
  Pick<BalancePoll, 'refreshBalance'> &
  Pick<HostSetup, 'standaloneAiPolicy'> &
  Pick<BalancePoll, 'whisperPeriodSec'>;

/** 注册轮询循环；返回的清理函数由 ctx.effect 收集。 */
export function registerLoops(deps: LoopsInput): void {
  const {
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
  } = deps;
  // 余额周期刷新：host 侧唯一定时器。周期每次重新读配置 eventsRefreshSec.balance，改了下一拍跟上。
  // 没有任何启用余额的宠物时跳过查询：尊重配置，不白花外部 API 调用。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    async function tick(): Promise<void> {
      let sec: number;
      try {
        const cfg = readAllConfig(configPaths);
        sec = balancePeriodSec(cfg);
        // 没有任何启用余额的宠物 → 不查（省外部调用）；配置改了下一拍自然跟上
        if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
        else log.info('[dsh-pet] 余额周期跳过：没有启用余额的宠物');
      } catch (e) {
        // 读配置抛错 = 安装损坏（readAllConfig 只在内置默认缺失/损坏时抛，用户层写坏只会告警回退）：
        // 不再重排——每 30 分钟重试一次没有意义，而且会白占一个常驻定时器。留一行 warn：这条路径
        // 会让余额周期永久停摆，不打日志就与「查了但没变化」无法区分。
        log.warn(
          '[dsh-pet] 余额周期读配置失败，周期刷新已停止（重启 DSH 后恢复）：' +
            (e instanceof Error ? e.message : String(e)),
        );
        return;
      }
      arm(sec);
    }
    void tick(); // 启动即拉一次，不等第一个周期
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: balance poll');

  // 碎碎念周期：host 侧调度。一拍 = 读一次配置 + 给「到点」的宠物各生成一句；下一拍按最短周期排。
  // 用固定拍 + 逐宠物比对 lastWhisperAt，而不是每宠一个定时器：宠物随配置增删、周期随条目改，
  // 固定拍天然跟上，不用维护一堆定时器的生命周期。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    function tick(): void {
      let next = 300;
      try {
        const cfg = readAllConfig(configPaths);
        const now = Date.now();
        let min = Infinity;
        // 每一拍的账：检查几只、到点几只、没到点几只、跳过几只（带原因）。只用于日志，调度行为不变。
        let checked = 0;
        let due = 0;
        let notDue = 0;
        const skipped: string[] = [];
        for (const pet of flattenPetList(cfg)) {
          const petId = String(pet.id ?? '');
          if (!petId) continue;
          // petId 就是从同一份 cfg 拍平出来的，所以必然命中（findPetInstance 与 flattenPetList
          // 搜索同一集合）；查不到只可能是两者口径漂移——跳过这一拍，不猜也不兜底 main。
          const found = findPetInstance(cfg, petId);
          if (!found) continue;
          checked += 1;
          const schedule = automaticWhisperSchedule(
            standaloneAiPolicy(),
            pet.whisperEnabled === true,
            whisperPeriodSec(found.conf),
          );
          if (!schedule.enabled) {
            // 两种「没启用」分开记：宠物自己关掉，与独立模式没授权，处理方式完全不同
            skipped.push(
              petId + ': ' + (pet.whisperEnabled === true ? '独立模式未授权自动碎碎念' : 'whisperEnabled=false'),
            );
            continue;
          }
          const sec = schedule.periodSec;
          min = Math.min(min, sec);
          if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1000) {
            notDue += 1;
            continue;
          }
          // 占用锁：这只宠物被占用时跳过这一拍——不生成也不补（碎碎念是瞬时事件，过期即弃），
          // 且不推进 lastWhisperAt：锁一放开，下一拍就该照常说。
          // 只挡这一处 per-pet 来源；全局段（balance / workStatus）由渲染端按宠物忽略——
          // 宿主跳过写入会连带静音别的宠物。
          if (lock.locked(petId)) {
            skipped.push(petId + ': 占用锁跳过');
            continue;
          }
          due += 1;
          log.info(`[dsh-pet] 碎碎念到点 pet=${petId}（周期 ${sec}s），开始生成`);
          lastWhisperAt.set(petId, now);
          // 不 await：生成要几秒，别把调度拍拖住（每只宠物独立生成，互不阻塞）
          void publishWhisper(petId).catch(() => {});
        }
        if (Number.isFinite(min)) next = min;
        // 每拍一行汇总：调度是否还在跑、下一拍多久、为什么跳过，全在这一行里（300s 一条，量可忽略）
        log.info(
          `[dsh-pet] 碎碎念调度：检查 ${checked} 只 → 到点 ${due}、未到点 ${notDue}、跳过 ${skipped.length}` +
            (skipped.length > 0 ? `（${skipped.join('；')}）` : '') +
            `；下一拍 ${next}s`,
        );
      } catch (e) {
        // 读配置抛错 = 安装损坏（同余额定时器）：不再重排，别白占常驻句柄。
        // 但必须留一行 warn：这条路径会让自动碎碎念永久停摆。
        log.warn(
          '[dsh-pet] 碎碎念调度读配置失败，自动碎碎念已停止（重启 DSH 后恢复）：' +
            (e instanceof Error ? e.message : String(e)),
        );
        return;
      }
      arm(next);
    }
    void tick(); // 启动即生成一次，不等第一个周期
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: whisper poll');

  // 环境感知采样：每 awarenessPeriodSec 采一拍（浏览器当前标签 / 桌面窗口），存进内存供提示词现取。
  // **总开关关着（默认）就整块空转**：不连浏览器、不碰桌面，连日志都不写。
  // 为什么用独立定时器而不搭碎碎念那趟：两者周期语义不同（碎碎念是"多久说一句"，
  // 感知是"多久看一眼"），绑在一起会让用户改一个动另一个。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** 上一拍快照（判断"换了窗口/离开又回来"要跟它比） */
    let prevSample: AwarenessSample | null = null;
    /** 上次主动搭话的时刻（冷却用，避免连着几拍都在说） */
    let lastSpeakAt = 0;
    const arm = (sec: number): void => {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(60_000, sec * 1000));
    };
    async function tick(): Promise<void> {
      let sec = 300;
      try {
        const cfg = readAllConfig(configPaths) as Record<string, unknown>;
        sec = Number(cfg.awarenessPeriodSec) || 300;
        if (cfg.awarenessEnabled !== true) {
          // 关掉时要**主动清空**上一次的快照，否则关掉之后宠物还会"记得"你在干嘛
          rememberAwareness(null);
          prevSample = null;
          arm(sec);
          return;
        }
        const sample = await collectAwareness({
          enabled: true,
          browser: cfg.awarenessBrowser === true,
          // 专用浏览器的 CDP 端口：与抖音侧同一个（默认 9334）。连不上就只是没有浏览器信号。
          port: 9334,
          // 桌面窗口：读"开着哪些窗口 + 标题里的文件名"（WPS/Office/编辑器都能认出来）。
          // 拿不到焦点在哪个窗口——只知道开着。
          ...(cfg.awarenessDesktop === true ? { desktop: () => collectWindows(defaultRunner) } : {}),
        });
        rememberAwareness(sample);
        log.info(
          `[dsh-pet] 环境感知：${sample === null ? '这拍没采到东西' : `已采样（窗口 ${sample.windows?.length ?? 0} 个）`}`,
        );

        // 该不该开口：换页面/换窗口/离开回来/盯太久。冷却 30 分钟，避免连着几拍都在说。
        if (sample !== null) {
          const decision = speakReason(prevSample, sample, { stallSec: 1800, awaySec: 900 });
          const now = Date.now();
          if (decision.speak && now - lastSpeakAt >= 30 * 60_000) {
            // 挑一只开着碎碎念的宠物：关掉碎碎念就等于"别主动找我说话"，这里也尊重它
            const pet = flattenPetList(readAllConfig(configPaths)).find((p) => p.whisperEnabled === true);
            if (pet !== undefined) {
              lastSpeakAt = now;
              // 由头：把"此刻的事实"交给模型，它才有话可说（否则只能泛泛念一句碎碎念）
              const notable = pickNotableWindows(sample.windows ?? [], 1)[0];
              const hour = new Date().getHours();
              const late = hour >= 22 || hour < 6;
              const hint =
                notable === undefined
                  ? ''
                  : `现在是${late ? '深夜' : '白天'} ${hour} 点多，主人还在用「${notable.title}」。`;
              log.info(`[dsh-pet] 环境感知触发搭话（${decision.reason}）${hint === '' ? '' : '：' + hint}`);
              // 不 await：生成要几秒，别把采样拍拖住
              void publishWhisper(String(pet.id ?? 'main'), hint).catch(() => {});
            }
          }
          prevSample = sample;
        }
      } catch (e) {
        log.warn('[dsh-pet] 环境感知采样失败：' + (e instanceof Error ? e.message : String(e)));
      }
      arm(sec);
    }
    void tick();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: awareness poll');
}
