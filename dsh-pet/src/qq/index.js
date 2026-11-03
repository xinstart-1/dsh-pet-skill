/**
 * dsh-pet-qq 宿主半侧：把 QQ 接管挂进 Cordis（由 `host/index.ts` 调用，不是独立插件包）。
 *
 * 和抖音那份（`douyin/index.js`）同一套接法，只是更薄——QQ 没有 OAuth、没有发布包，
 * 只有一条长连接和一套闸门：
 * 1. `/dsh-qq-7342` 前缀路由（设置页 + HTTP API，一个端口管全部）
 * 2. `/qq` 斜杠命令（状态 / 连断 / 手动发一条）
 * 3. 启动：读配置 → 读账本 → 按总开关决定是否连网关
 *
 * **只连接，不启动、不注入任何 QQ 进程**：网关（NapCat / LLBot / SnowLuma）由用户自己装、
 * 自己登录。这条边界是刻意的——代替用户点协议、托管登录态，等于替他承担封号风险。
 *
 * @module dsh-pet-qq
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, pathsFor } from './config.js';
import { createHostLlm } from './llm.js';
import { ROUTE_PREFIX, createRouter } from './router.js';
import { createNapcat } from './napcat.js';
import { createService } from './service.js';
import { createLog, dshHome } from './util.js';

/** 诊断名 */
export const name = 'dsh-pet-qq';

/**
 * 依赖的宿主服务。由 `dsh-pet` 的 ctx 转递（它自己已 inject 这些），
 * 单独挂载时也成立：没有 `llm` 就只回不了话，连接与设置页照常。
 */
export const inject = ['webServer', 'agentDefaultModel', 'llm'];

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文
 * @param {{personaOf?: (petId: string) => string}} [deps] 宿主递来的能力（人设真源在宠物那边）
 * @returns {void}
 */
export function apply(ctx, deps = {}) {
  const home = dshHome();
  const paths = pathsFor(dataDir(home));
  /** DSH Web 端口：桌宠桥与人设兜底都要用 */
  let port = 0;

  const log = createLog({ file: paths.logFile });
  void mkdir(paths.dir, { recursive: true }).catch(() => {
    /* 建不出来时后续写入各自报错，这里只保证日志不炸 */
  });

  const service = createService({ home, log, getPort: () => port });

  // 网关安装器：解压随包分发的 NapCat OneKey、预置 OneBot 配置、启停进程。
  // 它是"安装助手"，不参与收发消息——消息永远只走 service 那条 OneBot 长连接。
  const napcat = createNapcat({ root: join(paths.dir, 'napcat'), log });

  // 宿主 LLM：唯一生成通路（免 Key）。拿不到就如实失败，上层不发，没有模板兜底。
  service.setHostLlm(createHostLlm({ ctx }));

  // 人设：宿主递过来的就是唯一真源；没递就退回 HTTP 借一次，再借不到只有场景约束。
  service.setPersonaProvider(typeof deps?.personaOf === 'function' ? deps.personaOf : null);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createRouter({ service, log, napcat }),
      }),
    'dsh-pet-qq: 设置页与 HTTP API',
  );

  ctx.effect(() => {
    let disposed = false;
    port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    void (async () => {
      await service.init();
      if (disposed) return;
      const r = await service.start();
      log.info(
        `设置页：http://127.0.0.1:${port}${ROUTE_PREFIX}/${r.connected ? '（已开始连网关）' : '（总开关关着）'}`,
      );
    })().catch((error) => {
      log.error(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      disposed = true;
      void service.stop();
      // 插件移除/禁用/宿主退出时：
      // 1. 不把我们拉起的网关变成孤儿；
      // 2. 顺手清掉 napcat/ 目录（安装器 + 已装网关，约 1.2GB，随时可重下）——
      //    ctx.effect 无法区分「移除」与「禁用」，所以这里只删可再生、无隐私的产物；
      //    配置与 QQ 登录态不在这里删（那要走设置页「彻底卸载并清理」，见 uninstall.js）。
      // 用同步版：清理函数返回后 DSH 可能立刻销毁进程，异步删除会被截断、白删。
      try {
        napcat.wipeSync();
      } catch (error) {
        log.warn(`卸载时清理网关目录失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }, 'dsh-pet-qq: 初始化与清理');

  // /qq：一眼看清"连没连上、回了几条"，或者手动连断/发一句
  ctx.effect(() => {
    const commands = ctx.get?.('commands');
    if (commands === null || typeof commands !== 'object' || typeof commands.register !== 'function') {
      log.info('commands 服务不可用，/qq 命令未注册（其余功能不受影响）');
      return;
    }
    return commands.register({
      name: 'qq',
      description: 'QQ 接管：看状态 / 连断 / 发一句话',
      input: { hint: '[留空=状态 | connect | disconnect | to <QQ号> <内容> | group <群号> <内容>]' },
      handler: ({ rawInput }) => {
        const raw = String(rawInput ?? '').trim();
        const arg = raw.toLowerCase();
        const st = service.state();
        const dryRun = service.getConfig().chat.dryRun;

        if (raw === '' || arg === 'status') {
          const s = st.bot;
          const self = s.selfId === '' ? '未登录' : `${s.nickname || '（无昵称）'}（${s.selfId}）`;
          return {
            kind: 'success',
            text:
              `${st.enabled ? '总开关开着' : '总开关关着'} · 网关${s.ok ? '在线' : `离线（${s.state}）`} · ${self}` +
              ` · 试运行${dryRun ? '开' : '关'}` +
              ` · 收 ${st.stats.inbound} / 回 ${st.stats.replied} / 跳过 ${st.stats.skipped} / 失败 ${st.stats.failed} / 试运行 ${st.stats.dryRun}` +
              ` · 今日 ${st.usage.dayTotal} 条`,
          };
        }

        if (arg === 'connect') {
          service.connect();
          return { kind: 'success', text: '开始连网关（连上后设置页会显示登录的号）' };
        }
        if (arg === 'disconnect') {
          service.disconnect();
          return { kind: 'success', text: '已断开' };
        }

        const send = /^(?:to|group)\s+(\d{4,12})\s+([\s\S]+)$/i.exec(raw);
        if (send !== null) {
          const kind = arg.startsWith('group') ? 'group' : 'private';
          void service
            .say({ to: send[1], kind, text: send[2].trim() })
            .then((r) => log.info(`/qq ${kind} ${send[1]}：${r.ok ? '已发' : r.reason}`))
            .catch((e) => log.warn(`/qq 发送失败：${e instanceof Error ? e.message : String(e)}`));
          return { kind: 'success', text: `正在发给 ${send[1]}（${kind === 'group' ? '群' : '私聊'}）` };
        }

        return { kind: 'error', text: '用法：/qq [status | connect | disconnect | to 12345 内容 | group 12345 内容]' };
      },
    });
  }, 'dsh-pet-qq: /qq 命令');
}
