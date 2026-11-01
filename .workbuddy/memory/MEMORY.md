# 项目长期记忆（2026-10-28 整理）

## 用户强调的原则（最高优先，别违反）

1. **发布最后一步必须人工确认**。上传、转码、填标题可以自动，最后那个「发布」由 `web.autoPublish` 决定，且**默认关**。理由：视频一发出去就是公开内容、不可撤销，而封面/权限/定时这些字段还值得人看一眼。
2. **不许抢用户的浏览器页面**。任何自动操作（轮询、展开侧栏）失败后必须退避，不许反复点击。曾经 autoReply 每 10 秒点 3 次「消息」把页面切来切去——用户明确反感。
3. **以 pet 为主体**。设置入口在宠物设置页；人格/设定的**真源只有一份**，在 pet 的 `whisperPrompt`。能力插件向 pet 借人设（进程内 `personaOf` / `GET /persona`），不自己存副本。
4. **不要为了架构纯洁性给用户加限制**（原话："限制太多了，要求全部合并成一个插件"）。单人单宠物的场景下，diff 清单 / 防退化判据 / 升级重放这类纪律的成本高于收益。想改就改。
5. **不编造，用证据说话**。失败要如实报，不假装成功；交付前要有实测（接口返回值或截图），不能只说"改好了"。

## 当前架构（2026-10-28 合并 + 改名后）

- **单插件，包名 `dsh-pet-skill`**（目录仍是 `dsh-pet-main/dsh-pet`）。抖音在 `src/douyin/`（约 1.2 万行），原独立包已归档 `archive/douyin-plugin-snapshot-20261028/`。
- 两条路由前缀：`/dsh-pet-7340`（桌宠）、`/dsh-douyin-7341`（抖音 + 设置页）；数据目录 `~/.dsh/dsh-pet`、`~/.dsh/dsh-pet-douyin`。**改名时刻意都没动**（动了＝让用户重配桌宠、重扫授权码）。
- **改名要动四处**：`package.json.name`、`cordis.patch.yml` 的 id/name、`src/client/index.ts` 的 `__ModuleLoader__.load({id})`、profile 的依赖键 + `bundles` + `node_modules` 软链名。
- 设置页左导航**只有「桌宠配置」一项**；抖音是「桌宠配置」里**技能标签行**上的一个页签（`内置 (n) | 抖音`），点它整块换成 iframe，宠物表单与全局开关收起。「扩展」分区已删（含 `extension-card.ts` 与 `GET /extensions` 路由），但后台 `extensions.json` + `extension-say` 那条递话通道保留。加技能只改 `src/client/settings/skills.ts`。
- **人设只有一份真源**：条目级 `whisperPrompt` ← 实例级 `pets[].whisperPrompt` 取代（不拼接）；拼装点唯一 `src/host/persona.ts`；碎碎念 / 日常对话 / 抖音回复共用。抖音走**进程内直取**（`personaOf` 直递 `applyDouyin`，无缓存、下一条生效；宿主没递才退回 `GET /persona` 兜底）。`DEFAULT_REPLY_PERSONA` 与「回复人设补充」`web.replyPersona` 均已删除——插件不许有第二份人格，宠物没写人设就是没有人格（只留场景约束）。设置页人设框空时显示的是条目级人设的 placeholder，字数按实例级算（会显示 0 字，不是 bug）。
- **身份 ≠ 人设**（2026-10-29）：`web.knownPeers` 拼出的「现在谁在跟我说话」是 system 里的**动态段**（抖音侧三段：人设 → 身份声明 → 场景约束），每轮现算、不落盘；名单空 = 不注入（老用户语气不变）。别把身份写进 `whisperPrompt`。匹配逻辑在 `src/douyin/peers.js`（包含匹配只认两字符以上的名字）。
- **人设必须作为 system 消息送进模型**（2026-10-29 实测）：`ctx.llm.stream({ system })` 的顶层 `system` 字段**宿主不认**，人设一条都不会生效（问它身份会自称底层模型）。正确写法：`createSystemMessage(text)` → `{role:'system',content:[{type:'text',text}],source:{kind:'system-prompt'}}` 放进 `messages`。三处已改：`host/chat.ts`、`host/whisper.ts`、`douyin/llm.js`；独立模式 shim（`src/standalone/shims/dsh-llm.ts`）必须补同名导出，否则构建 MISSING_EXPORT。
  验证手段：把人设临时换成「回复必须以【XYZ】开头」，跑一次真实生成看正文有没有标记（`.scratch/verify-persona-fix.mjs`）。
  **注意**：带 5 轮旧聊天记忆时弱模型会顺着旧口吻聊、无视人设里的格式指令（空历史 100% 服从）——是模型行为不是链路 bug，嫌人设弱就把 `chatMemoryRounds` 调小。
- **system 消息会被宿主改写成 developer 角色 → sensenova 丢弃整段人设**（2026-10-29 抓包定位，桌面专属）。宿主 pi-ai 的 `openai-completions` 序列化里有一行：
  `const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";`
  模型**一旦在 provider 配置里声明了 `reasoningEfforts`**，就被 `resolveModelReasoning` 标成推理模型（`reasoning: true`）→ system 消息被改写成 `role: "developer"` → sensenova 的 openai-completions 端点只认 `system`，**整段人设被服务商丢弃**（表现：宠物自称「商量 / SensenNova 模型」，完全没有人设）。
  **修法：从 provider 配置的模型条目里删掉 `reasoningEfforts`**（桌面 profile 的 `cordis.patch.yml` 已改）。代价：DSH 设置里选不了深度思考档位；插件侧已能优雅降级（`llm-reasoning.ts` 的 `supportsReasoningOff` 探测不到元数据就不传 `reasoningEffort`，模型用默认档）。
  **不要试图用 provider 级 `compat: { supportsDeveloperRole: false }` 绕过**——实测会让 pi-ai 走别的服务商路径，请求根本到不了 `baseURL`（假服务端收不到任何请求）。
  诊断手法：把 provider 的 `baseURL` 指向本地假 HTTP 服务，打印收到的 JSON 看 `messages[0].role` 是 `system` 还是 `developer`——一眼定性。
- **不再追上游（fork）**。上游基线：`archive/pet-card-approach/dsh-pet-main/.git`（`d4411ae` = v0.3.8 原版）。
- 详见 `docs/ARCHITECTURE.md`、`docs/UPSTREAM.md`。

## QQ 接管技能（2026-10-29 新增，src/qq/）

- **路线**：OneBot v11 网关（NapCat/SnowLuma 等，用户自装自登录小号，插件**只连不注入**）+ 私聊自动回复 + 群聊"白名单群 + 被@/叫名字"双条件才回。参考 dsh-aurabot-qq 的分层，没抄代码。
- **前缀 `/dsh-qq-7342`、数据目录 `~/.dsh/dsh-pet-qq`、命令 `/qq`、设置页 `src/qq/qq-web/`（iframe 内嵌，高度消息 `dsh-qq-height`）**。
- **闸门纯函数 `policy.js`**（开关→自己→黑名单→静默时段→白名单→频率）；同会话串行、发送前复查、失败不重试；身份不符（网关登录号 ≠ 配置 selfId）一律不回。默认 enabled=false + dryRun=true + 白名单空。
- **token 走 `?access_token=`**（浏览器 WebSocket 不能带自定义头）；不引 `ws` 包，Node 22 自带 WebSocket（与 douyin webchan 同一前提）。
- **验证脚本 `.scratch/qq-e2e.mjs`**：手写 WS 帧协议的假 OneBot 网关跑真 service（28 项断言）；`npm run test:qq` 32 条纯函数单测；截图脚本 `.scratch/qq-shot.mjs`（无头 Edge）。
- **坑**：`body.embed .btn{background:transparent}` 会吃掉 btn-primary 白字，要后置覆盖；`scripts/copy-douyin-web.mjs` 已改名 `copy-web.mjs`（表驱动，加技能往 DIRS 加一条）；`douyin/llm.js` 的 createHostLlm 加了 sessionId 参数（QQ 传 dsh-pet-qq），douyin 行为不变。
- **未做（刻意）**：群发/好友申请/自动加群；图片语音只占位不识图；真机接 NapCat 尚未跑（等用户装网关）。

## 技术坑（会直接失败，别重踩）

- **CDP `objectId` 是会话级句柄**：`DOM.setFileInputFiles` 必须和 `Runtime.evaluate` 共用一条 WebSocket（`cdpSession`）。分两次调用报 `Could not find object with given id`。
- **抖音输入框天然带 `\u200B` 零宽字符**，退格删不掉 → `innerText.length === 0` 永远不成立，判据必须先剔零宽字符。**发送前必须清空**：键盘输入是追加，不清就"旧内容+新内容"拼接 → 读回比对失败 → 那个会话永远发不出去。
- **profile 摘插件要删三处**：`package.json.dependencies`、`node_modules` 软链、`bundles` 数组。少删一处 → 同前缀双注册 → `duplicate prefix route` → pet 整个 apply 失败（所有路由 404）。
- **两套测试必须分开跑**：`npm test`（TS，1529 条）+ `npm run test:douyin`（JS，118 条）。都起本地端口，`node --test` 并发会互踩（混跑挂 82 条）；`test:all` 串行。
- **配置是内存缓存**：直接改磁盘 `config.json` 对运行中的插件无效，走 `PUT /api/config`。
- **调试只能走无头 CLI**：`cmd //c "X:\APP\deepseek-harness\resources\runtime\cli\bin\dsh.cmd" --profile dytest --port 7350 --no-open`（`DeepSeek Harness.exe` 本身**不接受** `--profile`，会报 bad option）。启动约 20 秒路由就绪。
  **副作用**：它会借共享的 ego 浏览器往真实抖音号发自动回复——跑之前先临时关 `~/.dsh/dsh-pet-douyin/config.json` 的 `web.autoReply/allowAutoSend/autoWake`，跑完还原。
- **技能标签的 `skill` state 不能并进 `kind`**：种类那套"条目不在了就退回 main"的逻辑在配置重载时会把用户从技能页踢回内置。
- **pet 写接口三条**：`surface` 必填；持锁后 `lock=` **必须走 query**（放 body 一律 `lock-required`）；`petSay({ pet })` 里的 `pet` 会遮蔽桥对象。
- **抖音能力模型**：`browse` / `share` / `dm` / `publish` 四项同级，统一走 `lib/capabilities.js` 的 `guarded()`，共享配额与审计。**加新能力时别硬编码能力清单**——`store.usageOf` 曾硬编码三项导致新能力读不到用量，须按 `CAPS` 遍历。
- **数据迁移时机**：`service.init()` 里的迁移必须在 `store.load()` **之前**跑，否则本轮读不到刚写的文件。
- **React `h` = `react/jsx-runtime` 的 `jsx()`**：第三个参数是 **key 不是 children**，子节点必须放 `props.children`（写成第三参数会静默丢内容）。
- **抖音设置页是 iframe 内嵌**（`?embed=1` 内嵌模式 + postMessage 高度同步），不是 React 重写。改 html/css 不用重启（每次请求读磁盘）；改 `douyin-card.ts` 要重启。

## DSH 通用约定（改任何插件都要用）

- 一个插件 = Cordis 包：`package.json`（`main` 指宿主入口，`dsh.bundle.patch` 指 `cordis.patch.yml`）+ 可选浏览器半侧。`cordis.patch.yml` 里 **id 必须等于包名且全局唯一**，那行不能有行尾注释。
- 宿主入口导出 `name` / `inject` / `apply(ctx)`；路由 `ctx.effect(() => ctx.webServer.register({ kind:'prefix', path, handler }))`，端口读 `ctx.webServer.port`。
- **宿主 LLM 必须在 `inject` 里声明** `'llm'` + `'agentDefaultModel'`（不声明读 `ctx.llm` 直接抛错）。取模型用 `ctx.agentDefaultModel.currentSelection()`；`ctx.llm.stream({provider,model,sessionId,messages,system,temperature,signal})`；chunk 只认 `text-delta`（`reasoning-delta` 是思考，不算正文）。模型由 harness 统一提供，插件侧不可配。
- 斜杠命令 `ctx.commands.register({name, description, input:{hint}, handler})`，handler 只返回 `{kind:'success'|'error', text}`；可选依赖用 `ctx.get('commands')`，别写进 `inject`。
- `$DSH_HOME` = `process.env.DSH_HOME || ~/.dsh`，用户数据放 `$DSH_HOME/<插件名>/`。
- pet 对外通道 `/dsh-pet-7340`（无鉴权、只监听 127.0.0.1）：菜单 `POST /menu/item` + 长轮询 `GET /menu/events?owner=&wait=`；播报/动画先 `POST /lock?pet=` 再 `/broadcast` 或 `/anim?surface=any`。

## `/ego-browser` 斜杠命令（操作浏览器的推荐入口）

`src/douyin/index.js` 注册，**与抖音业务无关，是通用的浏览器入口**——想在专用浏览器里开任何页面都用它：

- `/ego-browser` 或 `/ego-browser status`：报通道状态（先给缓存、后台刷新），输出 `在线 <browser> · CDP <port> · 抖音标签 N · 已/未登录`
- `/ego-browser open <url>`：在专用浏览器里新开标签
- `/ego-browser douyin`：打开抖音聊天页

底层是 `webchan.openTab(url)`（CDP `PUT /json/new?<url>`，新版 Chromium 只认 PUT，失败退回一次 GET）。**要人手动开浏览器时优先用它**，不要自己 spawn GUI 进程。

## 抖音开放平台能力边界（2026-10 核实，决定什么能做）

- 扫码授权 (`user_info`)：默认开启、无需申请，个人可建「网站应用」拿 client_key/secret。
- **发布** (`video.create.bind`)：仅企业主体（注册资本≥50万、注册≥1年）+ 应用转正 → **个人拿不到** → 走网页发布包/网页上传路线。
- 读自己作品 (`video.list`)：控制台申请后可用；推荐流无公开接口。
- **私信发送**：个人号零接口；企业号需认证 + 过审 + 日耗门槛，且只能被动回复、24h 内最多 6 条。
- 结论：不做私有接口逆向、不做自动群发；私信走「草稿 + 唤起 App」或网页通道。

## 网页通道补充（除上面的坑之外）

- 自动发送已真机打通：抖音网页 IM 无发送按钮，`Input.insertText` + 真实回车即发；回执用气泡 `[class*="MessageItemText"]` + 会话预览 `[data-e2e="conversation-item"]`（**`body.innerText` 是假阳性，禁用**）。发送不重试。
- **同端口"谁先占就是谁"**：换浏览器前必须杀掉旧的专用实例（`Get-CimInstance Win32_Process` 按 `--remote-debugging-port` 精确定位，别杀用户日常 Edge）。
- Edge↔ego 不共用加密 cookie，切换浏览器要重新扫码。
- 回复措辞**只有一条路：宿主 LLM（免 Key）**。`web.replyViaLlm` 总闸与 `web.autoReplyTemplate` 模板兜底、`fillTemplate` 已全部删除（2026-10-29，用户要求"所有回复都走大模型"）；生成失败/空正文就**不发**，只记账不降级。也没有任何备用 API Key/模型名配置。
- 群聊会话名带成员数后缀「…(n)」，`readIncoming` 已剥；@ 就是气泡纯文本。

## 常用

- 调试用无头 CLI：`--profile dytest --port 7350 --no-open`（约 10 秒就绪）。**用完恢复 `~/.dsh/extensions.json`**（它会把端口改成 7350），备份在 `.backup/extensions-before-publish-test.json`。
- 改 `src/` 后 `npm run bundle`（含 `scripts/copy-douyin-web.mjs` 拷设置页资源）。
- 发布包在 `~/.dsh/dsh-pet-douyin/packs/`；私信/群聊类能力需要 ego 在线。
- 平台侧改不了的：新号群聊有限制；电脑端发的群消息 App 端可能收不到（投递策略，非 bug）。
