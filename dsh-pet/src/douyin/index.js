/**
 * dsh-pet-douyin 宿主半侧（Cordis 插件入口）——**一个插件，两件事**：
 * 账号（扫码授权 + 按宠物授牌）与发布包（扫目录 → 转码 → 出包）。
 *
 * 与 dsh-pet 的关系：不 import 它任何代码，桌宠能力全走 `/dsh-pet-7340`。
 * 所以 dsh-pet 没装、升级、重启，本插件都照常工作（只是没有宠物说话）。
 *
 * 四件事在这里接线，其余都在各自模块：
 * 1. `/dsh-douyin-7341` 前缀路由（设置页 + HTTP API，一个端口管全部）
 * 2. `/douyin` 斜杠命令（取不到 commands 服务就跳过，不影响其他功能）
 * 3. 启动即：读配置 → 迁移旧目录 → 挂右键菜单（一个 owner 五项）
 * 4. 两个定时器：发布包节奏（30s）+ 自主浏览（60s）
 *
 * @module dsh-pet-douyin
 */
import { mkdir } from 'node:fs/promises';
import { pathsFor } from './config.js';
import { registerSelf, unregisterSelf } from './extensions.js';
import { createHostLlm } from './llm.js';
import { ROUTE_PREFIX, createRouter } from './router.js';
import { createService } from './service.js';
import { CAP_LABEL } from './store.js';
import { createLog, dshHome, pluginDir } from './util.js';

/** 插件名（诊断与日志里显示） */
export const name = 'dsh-pet-douyin';

/**
 * 宿主服务清单。`llm` / `agentDefaultModel` 是 DSH 核心服务（dsh-pet 同款接法）：
 * 前者做模型生成（回复话术），后者告诉我们要用哪个 provider/model。
 * Cordis 是「不声明就摸不到」——运行时不写 inject 直接读 ctx.llm 会抛错。
 * `commands` 走 `ctx.get()` 可选取——写进 inject 会在命令服务缺失时让插件永远不 apply，代价太大。
 */
export const inject = ['webServer', 'agentDefaultModel', 'llm'];

/**
 * Cordis 入口。
 * @param {any} ctx Cordis 上下文
 * @param {{personaOf?: (petId: string) => string}} [deps] 宿主递过来的能力：人设（真源在 pet，进程内直取）
 * @returns {void}
 */
export function apply(ctx, deps = {}) {
  const home = dshHome();
  const paths = pathsFor(pluginDir(home));
  /** DSH Web 服务端口：路由、桌宠桥、设置页地址都要用 */
  let port = 0;

  const log = createLog({ file: paths.logFile });
  void mkdir(paths.dir, { recursive: true }).catch(() => {
    /* 建不出来时后续写入各自报错，这里只保证日志不炸 */
  });

  const service = createService({ home, log, getPort: () => port });

  // 宿主 LLM：dsh-pet 同款接法（ctx.llm.stream + agentDefaultModel），免 API Key。
  // 旧宿主没这服务时 createHostLlm 返回 null，composeReply 直接返回失败（没有模板兜底，不发）。
  service.setHostLlm(createHostLlm({ ctx }));

  // 人设：宿主递过来的就是唯一真源（pet 那只宠物的人设），本插件不存、也不自己写一份。
  // 传 null（宿主没给）时，service 里的回复链路会自动退回 HTTP 借一次；再借不到就只有场景约束，
  // 绝不临时编一个"抖音AI助手"的人格出来——那等于同一个人有两套性格。
  service.setPersonaProvider(typeof deps?.personaOf === 'function' ? deps.personaOf : null);

  // 附件服务（可选）：看图这条路要把截下来的画面存成附件——模型消息里收的是 attachmentId 引用，不是裸字节。
  // 宿主没这个服务（旧版 / 独立模式）时留 null，scanFeed 会自动退回"只读文案"。
  // 用 ctx.get(name, false) 软取：不写进 inject，服务缺失时插件仍然正常 apply。
  service.setAttachments(typeof ctx?.get === 'function' ? (ctx.get('attachments', false) ?? null) : null);

  // 临时探针：摸清宿主 LLM 能力面（ctx.llm / agentDefaultModel / @deepseek-ai/dsh-llm 可达性与 chunk 形状）。
  // 放在入口是因为只有这里摸得到 cordis ctx；service 与 HTTP 层都不该知道 ctx 的存在。
  service.setProbeRunner(async () => {
    const out = {
      ctxKeys: Object.keys(ctx ?? {}),
      llmType: typeof ctx?.llm,
      agentDefaultModelType: typeof ctx?.agentDefaultModel,
    };
    try {
      const adm = ctx?.agentDefaultModel;
      out.modelSelection = typeof adm?.currentSelection === 'function' ? adm.currentSelection() : null;
    } catch (e) {
      out.modelSelectionErr = e instanceof Error ? e.message : String(e);
    }
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      out.dshLlmExports = Object.keys(mod).slice(0, 50);
      out.hasBlockAssembler = typeof mod.BlockAssembler;
      out.hasCreateUserMessage = typeof mod.createUserMessage;
    } catch (e) {
      out.dshLlmErr = e instanceof Error ? e.message : String(e);
    }
    if (typeof ctx?.llm?.stream === 'function') {
      const sel = out.modelSelection && out.modelSelection.provider ? out.modelSelection : null;
      if (sel === null) {
        out.streamSkipped = 'no model selection';
      } else {
        try {
          const chunks = [];
          for await (const ch of ctx.llm.stream({
            provider: sel.provider,
            model: sel.model,
            sessionId: 'dsh-pet-douyin-probe',
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: '只回两个字：通了' }],
                source: { kind: 'user' },
              },
            ],
            system: '你是测试助手。',
            temperature: 1,
            signal: AbortSignal.timeout(30_000),
          })) {
            if (chunks.length < 6) chunks.push(ch);
          }
          out.streamOk = true;
          out.chunkSamples = chunks;
        } catch (e) {
          out.streamErr = e instanceof Error ? e.message : String(e);
        }
      }
    } else {
      out.streamSkipped = 'ctx.llm.stream missing';
    }
    return out;
  });

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createRouter({ service, log }) }),
    'dsh-pet-douyin: 设置页与 HTTP API',
  );

  ctx.effect(() => {
    let disposed = false;
    /** 扩展清单重试定时器（端口可能比 apply 晚一拍才就绪） */
    let registerTimer = null;
    port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;

    /**
     * 把自己登记进 `$DSH_HOME/extensions.json`，宠物对话框里说的话才会问过来。
     *
     * 端口是动态的（桌面版每次启动都换），所以每次启动都要重写；拿不到端口时退避重试，
     * 全部失败也只是"宠物不把话转过来"，抖音本身的功能一条不少。
     * @param {number} attempt 第几次尝试
     * @returns {Promise<void>}
     */
    const registerExtension = async (attempt = 0) => {
      if (disposed) return;
      const current = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : port;
      if (current > 0) port = current;
      const reg = await registerSelf({ port: current, prefix: `${ROUTE_PREFIX}/api`, log });
      if (reg.ok === true) {
        log.info(`扩展清单：已登记 ${reg.api}`);
        return;
      }
      if (attempt >= 6) {
        log.warn(`扩展清单：登记失败，宠物对话不会转话过来（${reg.reason ?? '未知原因'}）`);
        return;
      }
      registerTimer = setTimeout(() => void registerExtension(attempt + 1), 1000);
    };

    void (async () => {
      await service.init();
      if (disposed) return;
      const menuOk = await service.startMenu();
      service.startPublishSchedule();
      service.startAutonomy();
      service.startAutoReply();
      void registerExtension();
      log.info(`设置页：${service.pageUrl()}（右键菜单${menuOk ? '已挂上' : '等待 dsh-pet 就绪（会自动重试）'}）`);
    })().catch((error) => {
      log.error(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      disposed = true;
      if (registerTimer !== null) clearTimeout(registerTimer);
      // 退出时摘掉自己那条：留着会让宠物每次对话都去连一个已经没人监听的端口
      void unregisterSelf({ log });
      void service.stop();
    };
  }, 'dsh-pet-douyin: 初始化与清理');

  // /douyin：一眼看清"账号通不通、宠物能干什么、今天出了几个包"
  ctx.effect(() => {
    const commands = ctx.get?.('commands');
    if (commands === null || typeof commands !== 'object' || typeof commands.register !== 'function') {
      log.info('commands 服务不可用，/douyin 命令未注册（其余功能不受影响）');
      return;
    }
    return commands.register({
      name: 'douyin',
      description: '抖音插件：看状态 / 列授牌 / 出发布包 / 让宠物刷一次 / 直接说一句话',
      input: { hint: '[list|publish|browse | 一句话，例如「给星⭐心发条消息：在吗」]' },
      handler: ({ rawInput }) => {
        // raw 保留原话（名字不能被 toLowerCase 改掉），arg 只用于匹配子命令
        const raw = String(rawInput ?? '').trim();
        const arg = raw.toLowerCase();
        const state = service.state();
        const who =
          state.account === null
            ? '未绑定账号'
            : `已绑「${state.account.nickname || state.account.openId.slice(0, 6)}」`;

        if (arg === 'list') {
          const grants = state.grants;
          if (grants.length === 0) return { kind: 'success', text: '还没有任何授牌（设置页 → 授牌）' };
          return {
            kind: 'success',
            text: grants
              .map((g) => {
                const caps =
                  Object.keys(g.caps ?? {})
                    .map((c) => CAP_LABEL[c] ?? c)
                    .join('、') || '无';
                const used = g.usage
                  ? `（今日 浏${g.usage.browse}/享${g.usage.share}/信${g.usage.dm}/发${g.usage.publish}）`
                  : '';
                return `${g.pet}：${caps}${g.alive ? '' : '（已过期）'}${used}`;
              })
              .join('；'),
          };
        }

        if (arg === 'publish') {
          void service
            .prepare({ reason: '命令 /douyin publish' })
            .then((r) => log.info(`/douyin publish：${r.ok ? r.pack.dir : r.reason}`));
          return { kind: 'success', text: '开始扫目录出发布包，好了桌宠会说一声' };
        }

        if (arg === 'browse') {
          const able = state.grants.filter((g) => g.alive && g.caps?.browse === true);
          if (able.length === 0) return { kind: 'error', text: '没有宠物被授予「浏览作品」——去授牌页勾一下' };
          const pet = able[0].pet;
          void service
            .browse({ pet, force: true })
            .then((r) => log.info(`/douyin browse 完成：${r.summary}`))
            .catch((e) => log.warn(`/douyin browse 失败：${e instanceof Error ? e.message : String(e)}`));
          return { kind: 'success', text: `让「${pet}」翻作品去了，结果它会说一声` };
        }

        // 兜底：不是内置子命令，就当成一句话交给宠物。
        // 这里必须"立刻返回"——DSH 的命令 handler 是同步的，等结果会把界面卡住。
        if (raw !== '') {
          const dmPet = state.grants.find((g) => g.alive && g.caps?.dm === true)?.pet;
          const petId = dmPet ?? state.grants.find((g) => g.alive)?.pet ?? 'main';
          void service
            .say({ pet: petId, text: raw })
            .then(async (r) => {
              log.info(`/douyin say → ${r.ok ? 'ok' : 'fail'}：${r.reply}`);
              await service.announce(r.reply, petId);
            })
            .catch((e) => log.warn(`/douyin say 失败：${e instanceof Error ? e.message : String(e)}`));
          return { kind: 'success', text: `交给「${petId}」了：${raw}` };
        }

        return {
          kind: 'success',
          text: `${who}；今日发布包 ${state.ledger.todayCount}/${state.config.schedule.maxPerDay}；授牌 ${state.grants.length} 只；右键菜单${state.link.petMenu ? '已挂上' : '未挂上'}`,
        };
      },
    });
  }, 'dsh-pet-douyin: /douyin 命令');

  // /ego-browser：专用浏览器（ego lite）的手动入口。抖音之外的东西也能用——
  // 它只是"把链接丢进那个常驻浏览器"，不涉及任何抖音业务逻辑。
  // handler 必须同步返回：状态先给上一次探测结果，同时后台刷新一次。
  ctx.effect(() => {
    const commands = ctx.get?.('commands');
    if (commands === null || typeof commands !== 'object' || typeof commands.register !== 'function') return;
    return commands.register({
      name: 'ego-browser',
      description: '专用浏览器（ego lite）：看状态 / 打开任意链接 / 打开抖音聊天页',
      input: { hint: '[留空=状态 | open <url> | douyin]' },
      handler: ({ rawInput }) => {
        const raw = String(rawInput ?? '').trim();
        const arg = raw.toLowerCase();

        if (raw === '' || arg === 'status') {
          void service
            .webStatus()
            .then((s) =>
              log.info(
                `/ego-browser：${s.ok === true ? `在线 ${s.browser} · CDP ${s.port} · 抖音标签 ${s.douyinTabs} · ${s.loggedIn ? '已登录' : '未登录'}` : `离线（${s.reason}）`}`,
              ),
            )
            .catch((e) => log.warn(`/ego-browser 状态查询失败：${e instanceof Error ? e.message : String(e)}`));
          const c = service.webStatusCached();
          if (c === null) return { kind: 'success', text: '正在检查专用浏览器…再发一次 /ego-browser 就有结果' };
          return {
            kind: 'success',
            text:
              c.ok === true
                ? `在线 · ${c.browser} · CDP ${c.port} · 抖音标签 ${c.douyinTabs} 个 · ${c.loggedIn === true ? '已登录' : '未登录（去那个窗口扫码）'}`
                : `不在线：${c.reason}`,
          };
        }

        const target =
          arg === 'douyin' ? 'https://www.douyin.com/chat' : arg.startsWith('open ') ? raw.slice(5).trim() : raw;
        if (!/^https?:\/\//i.test(target)) {
          return { kind: 'error', text: '给一个 http(s) 链接，或者 /ego-browser douyin' };
        }
        void service
          .openBrowserTab(target)
          .then((r) => log.info(`/ego-browser 打开 ${target}：${r.ok === true ? 'ok' : r.reason}`))
          .catch((e) => log.warn(`/ego-browser 打开失败：${e instanceof Error ? e.message : String(e)}`));
        return { kind: 'success', text: `正在打开：${target}` };
      },
    });
  }, 'dsh-pet-douyin: /ego-browser 命令');
}
