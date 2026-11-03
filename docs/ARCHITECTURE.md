# 插件架构（2026-10-28 合并为单插件，包名 `dsh-pet-skill`）

> 这一版推翻了此前"总线 + 多插件"的设计。原因见文末「为什么最终合并」。

## 一句话

**全部功能在 `dsh-pet-skill` 一个包里**：桌宠渲染 + 技能（抖音是第一个）+ 设置页。
以后新功能作为**技能**加进来，不再拆新插件、不再维护跨包契约。

## 命名与身份（2026-10-28 晚改名）

| 项 | 值 | 说明 |
|---|---|---|
| package.json `name` | `dsh-pet-skill` | 桌宠 + 技能；patch 的 `id`/`name`、浏览器模块 `id` 必须同它一致 |
| 路由前缀 | `/dsh-pet-7340`、`/dsh-douyin-7341` | **故意不改**：改了所有客户端配置与书签全废 |
| 数据目录 | `$DSH_HOME/dsh-pet/`、`$DSH_HOME/dsh-pet-douyin/` | **故意不改**：改了等于让用户重配桌宠、重扫抖音授权码 |
| profile 依赖 | `"dsh-pet-skill": "link:…"` | 两个 profile 的依赖键、`dsh.profile.bundles`、`node_modules` 软链名都要同步改 |

## 形状

```
dsh-pet-main/dsh-pet/                    唯一插件
├─ src/host/                             宿主半侧（TS）
│  ├─ index.ts                           入口：装配 pet + 调 applyDouyin(ctx) / applyQQ(ctx)
│  ├─ routes/                            pet 自己的 HTTP（/dsh-pet-7340）
│  │  ├─ extensions.ts                   已装扩展清单（只读，给设置页用）
│  │  └─ persona.ts                      人设拼装（真源出口，技能只能从这里借）
│  ├─ plugin/extension-say.ts            宠物对话 → 把话问给能力插件
│  ├─ douyin/                            抖音能力（原独立插件，整体搬入）
│  │  ├─ index.js                        apply()：路由 / 菜单 / 定时任务
│  │  ├─ service.js                      能力门面（授牌 / 配额 / 审计）
│  │  ├─ webchan.js                      CDP 直连浏览器（读会话 / 发私信 / 发布）
│  │  ├─ router.js                       /dsh-douyin-7341 下的一切
│  │  └─ douyin-web/                     抖音设置页（html/css/js）
│  └─ qq/                                QQ 接管（2026-10-29，OneBot v11）
│     ├─ index.js                        apply()：路由 / /qq 命令 / 启停连接
│     ├─ service.js                      服务门面（事件 → 闸门 → LLM → 发送 → 记账）
│     ├─ onebot.js                       OneBot v11 客户端（WS 收事件 + API 调用，只连不注入）
│     ├─ policy.js                       回不回的闸门（纯函数，单测钉死）
│     ├─ message.js                      事件归一化（数组 / CQ 码两种形态 → 一种形状）
│     ├─ router.js                       /dsh-qq-7342 下的一切
│     └─ qq-web/                         QQ 设置页（html/css/js）
└─ src/client/                           浏览器半侧（React）
   └─ settings/
      ├─ skills.ts                       技能注册表（id / 文案键 / 面板工厂）
      ├─ skill-tabs.ts                   「技能」标签行（宠物种类 + 技能混排）
      ├─ douyin-card.ts                  抖音技能面板（iframe 内嵌 douyin-web）
      └─ qq-card.ts                      QQ 技能面板（iframe 内嵌 qq-web）
```

**三个路由前缀**（同一个 webServer 端口，不同前缀）：

| 前缀 | 归属 | 内容 |
|---|---|---|
| `/dsh-pet-7340` | 桌宠 | `/state` `/chat` `/broadcast` `/menu/*` `/extensions` `/persona` … |
| `/dsh-douyin-7341` | 抖音 | `/api/*`（账号/授牌/网页通道/发布）+ 设置页静态资源 |
| `/dsh-qq-7342` | QQ | `/api/*`（连接/配置/手动发送/审计日志）+ 设置页静态资源 |

设置页导航：**只剩「桌宠配置」一项**（抖音降级为页签、扩展整块撤掉）。

「桌宠配置」页内顶部是一条**技能标签行**（原「种类」行）：`内置 (n) | 抖音 | QQ`，
点「抖音」「QQ」整块换成各自的页面（iframe），宠物表单与全局开关同时收起。
加新技能 = 在 `src/client/settings/skills.ts` 里多登记一条，外壳与标签行都不用改。
技能标签 id 带 `skill:` 前缀，与宠物条目名（main / 角色包前缀）隔开，同名也不撞车。

## 数据目录

| 目录 | 内容 |
|---|---|
| `$DSH_HOME/dsh-pet/` | 宠物配置（`main-config.jsonc`）、对话记忆、日志、表情包 |
| `$DSH_HOME/dsh-pet-douyin/` | 抖音配置、账号、授牌、审计、发布包、网页通道 profile |
| `$DSH_HOME/dsh-pet-qq/` | QQ 配置（`config.json`）、账本（`state.json`：用量+审计）、日志 |
| `$DSH_HOME/extensions.json` | 能力清单位置；**只在后台用**：宠物对话经 `extension-say` 按清单把话递给能力插件（抖音那条仍在，只是不再有 UI 窗口） |

## 为什么撤掉「扩展」分区

那是"总线 + 多插件"时期给人看 `extensions.json` 的窗口：列出已装能力插件、点开内嵌**别人**的设置页。
现在只有一个插件，清单里唯一的条目（抖音）已经是内置技能，没有"别人的页面"可嵌，这一栏只会显示一句
「还没有装能力插件」。所以 UI（`extension-card.ts`）与仅供它使用的 `GET /extensions` 路由一起删掉。
**保留**的是后台那条通道：`extensions.json` + `src/host/plugin/extension-say.ts`——宠物对话把话递给
能力插件仍然走它，只是不再有界面。

## 人设（人格）只有一份真源，所有技能共用

- **真源**：条目级 `whisperPrompt`（`main-config.jsonc` 顶层）或实例级 `pets[].whisperPrompt`
  （设置页那只宠物的「人设」框）。**实例级写了就取代条目级，不是拼接**（`src/host/persona.ts` 的 `petPersona`）。
  设置页里人设框空着时，显示的是"正在跟随的条目级人设"作占位提示，右下角字数按**实例级**算（所以会是 0 字）。
- **拼装点唯一**：`composeSystemPrompt` = 人设正文 + 「你的名字是X。」 + 当前时间背景。不给人名/时间开配置。
- **三个消费点**，改一处全变（下一条就生效）：
  1. 碎碎念（每次生成现读配置）；
  2. 日常对话（`/chat`，`chat-memory.ts` 走同一拼装点）；
  3. **抖音回复**：`host/index.ts` 把 `personaOf`（进程内直取、现读现拼）递给 `applyDouyin(ctx, { personaOf })`，
     `service.petPersonaOf` 优先走它——**无缓存**；宿主没递时才退回 `GET /dsh-pet-7340/persona` 兜底（这条路带 5 分钟缓存）。
- **插件不许有第二份人格（2026-10-29 起）**：抖音原有的 `DEFAULT_REPLY_PERSONA`（内置默认人格）与
  设置页「回复人设补充」`web.replyPersona` 都已删除——同一个人不能有两套性格，宠物没写人设就是"没有人格"，
  只保留一句固定场景约束（"在抖音私信里替主人回一句话，只输出正文…"，管"怎么发"不管"你是谁"）。
  将来加新技能要人格，只准问 `personaOf` / `GET /persona` 借。
- **怎么把人设送进模型（2026-10-29 实测修订）**：必须作为 **system 消息**放进 `messages`
  （`createSystemMessage`： `{role:'system', content:[{type:'text',text}], source:{kind:'system-prompt'}}`）。
  `ctx.llm.stream({ system })` 这个**顶层 `system` 字段宿主不认**——传了等于没传：问它叫什么会自称底层模型、
  人设里的规则一条不生效。三个调用点已统一改掉：`host/chat.ts`、`host/whisper.ts`、`douyin/llm.js`
  （独立模式替身 `standalone/shims/dsh-llm.ts` 也要有同名导出，否则构建报 MISSING_EXPORT）。
  判据：把人设临时换成「回复必须以【XYZ】开头」跑一次真实生成，正文里有没有这个标记。
- **⚠️ 宿主会把 system 消息改成 developer 角色（2026-10-29 抓包定位，桌面版专属）**：
  宿主 pi-ai 的 `openai-completions` 序列化里有一行
  `const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";`
  而 `resolveModelReasoning` 见到模型声明了 `reasoningEfforts` 就返回 `reasoning: true`——
  于是 system 消息被改写成 `role: "developer"`。sensenova 的 openai-completions 端点**只认 `system`**，
  收到 `developer` 就整段丢弃 → **人设完全失效**（宠物自称「商量 / SensenNova 模型」，碎碎念/对话/抖音三条全挂）。
  **修法**：从 provider 配置的模型条目里**删掉 `reasoningEfforts`**（桌面 profile 的 `cordis.patch.yml` 已改）。
  代价是 DSH 设置里选不了深度思考档位；插件侧已能优雅降级（`llm-reasoning.ts` 探测不到元数据就不传
  `reasoningEffort`，模型走默认档）。
  **不要用 provider 级 `compat: { supportsDeveloperRole: false }` 绕过**：实测会让 pi-ai 走别的服务商路径，
  请求根本到不了 `baseURL`；且 `compatProfile` 是全字段必填的 zod 对象，枚举值写错会直接让 provider 不激活。
  诊断手法：把 `baseURL` 指向本地假 HTTP 服务，打印收到的 JSON 看 `messages[0].role` 是 `system` 还是 `developer`。
- **已知边界**：对话历史长时（`chatMemoryRounds`，默认 5 轮），弱模型会顺着旧回复的口吻聊、压过人设里的
  格式指令（2026-10-29 实测：空历史下强制人设 100% 生效；带 5 轮旧记忆时同一条指令被无视，但语气仍是人设的）。
  这是模型行为不是链路问题——想让人设更强势，把该条目的记忆轮数调小。

## 跨模块的两条通道

1. **宠物对话 → 抖音能力**：`chatWithPet()` 先 `extensionSay.claim()` 问一圈清单，认领了就用对方给的回执当回复。合并后这本可以直接函数调用，但保留 HTTP 的好处是「能力插件接口」这个概念还在——将来真接第三方插件时不用改协议。
2. **抖音回复 → 宠物人格**：走**进程内函数**（`personaOf` 直递，见上节），不再绕 HTTP、也没有缓存窗口；
   `GET /dsh-pet-7340/persona` 仍保留，给将来真正独立的第三方插件用，本插件只在宿主没递函数时拿它兜底。

## QQ 接管（2026-10-29 新增技能）

参考 `accomplish07zrh-eng/dsh-aurabot-qq`（OneBot v11 路线）的分层，但没有搬它的代码。链路：

```
QQ ⇄ 网关（OneBot v11：NapCat / SnowLuma / Lagrange，用户自己装、自己登录小号）
  ⇄ src/qq/（WS 收事件 → policy 闸门 → personaOf 借人设 → 宿主 LLM → 发送 → 账本）
```

- **边界刻在代码里**：插件**只连接**，不下载、不启动、不注入任何 QQ 进程，也不替用户点协议；
  没有群发、没有好友申请。理由：代替用户做那一步等于替他承担封号风险。
- **安全默认**：`enabled=false`、`chat.dryRun=true`、白名单为空 → 装完什么都不发生；
  群聊必须「群号在白名单 + 被 @ 或叫了名字」两个条件同时满足。
- **闸门是纯函数**（`policy.js`），判断顺序：开关 → 自己 → 黑名单 → 静默时段 → 白名单/身份 → 频率。
  同会话串行、跨会话并行；回复前**复查一次**（等待期间配置/额度可能变了）；发送失败不重试（宁可不发，不发两遍）。
- **身份 ≠ 人设**（与抖音同一铁律）：主人 = 配置里的 `masterId`（号码级匹配，不靠昵称）；
  熟人名单 `QQ号 | 关系 | 备注` 只进 system 的动态身份段，每轮现算，不落盘、不进 `whisperPrompt`。
- **事件归一化**（`message.js`）：NapCat 等实现给的消息可能是段数组也可能是 CQ 码字符串，归一化只在这一层做。
  WS 令牌走 `?access_token=`（浏览器 WebSocket 不支持自定义头）。
- **端到端验证**：`.scratch/qq-e2e.mjs` 起一个手写帧协议的假 OneBot 网关 + 假 LLM，跑真实 service，
  覆盖主人私聊/陌生人/群 @/试运行/账本/身份不符六条链路；`npm run test:qq` 是纯函数单测。
- **卸载清理两条路径**（`uninstall.js`）：
  1. **插件页直接删插件** → 走 Cordis `ctx.effect`。**关键约束：`ctx.effect` 在「移除」与「禁用」时都会触发，无法区分**，
     所以这里只清**可再生、无隐私**的 `dsh-pet-qq/napcat/`（网关安装器 + 已装网关，约 1.2GB，可重下），
     且用 `wipeSync()`/`wipeDirSync()` **同步删**——清理函数返回后 DSH 可能立刻销毁进程，异步 `rm` 会被截断、白删。
     配置与 QQ 登录态**不**在这里删。
  2. **设置页「彻底卸载并清理」**（二次确认）→ `wipeAll()` 全清：`dsh-pet-qq`（网关、登录态、配置）、
     `dsh-pet`（宠物配置与素材）、可选 `electron`（约 104MB 可重下）。
  - 刻意**不**在卸载钩子里全删：禁用一下就会丢配置与 QQ 登录态，且不可恢复。删盘是用户主动确认的动作。
  - `wipeDir`/`wipeDirSync` 只删明确列出的目录、绝不碰 `DSH_HOME` 本身或其他插件，带 Windows 文件锁重试。

## 为什么不追上游了（fork 声明）

`dsh-pet` 上游是 `dsh-pet@0.3.8`。从 2026-10-28 起本目录是**我们自己的分支**，不再逐版同步：
抖音 1.2 万行已经进树，任何上游更新都要手工 rebase 几千行，成本远超收益。

要恢复上游：`archive/pet-card-approach/dsh-pet-main/.git` 是上游原版基线（提交 `d4411ae`），
`archive/douyin-plugin-snapshot-20261028/` 是合并前抖音独立插件的完整快照。

## 为什么最终合并（两次弯路）

| 阶段 | 做法 | 结果 |
|---|---|---|
| ① 真合并（早期） | 抖音源码 vendored 进 `pet/src/douyin/`，**同时**保留独立插件 | **腐烂**：副本落后 296 行，两边同前缀双注册，"改了 lib 重启却像没生效" |
| ② 总线多插件（10-28 白天） | 抖音独立成包，靠四条契约（前缀/body.ok/降级/反向通道）互联，pet 零业务 | 干净，但每改一处要维护 diff 清单、跑防退化判据、升级要重放 12 个文件——**单人单宠物场景下纪律成本高于收益** |
| ③ 单插件（现在） | 抖音整体搬进 pet，删独立包，只留一份真源 | 想改就改。**教训仍然是"不许两份副本"**，只是这次由"物理上只有一个包"来保证 |

①和③的区别不是"要不要合并"，而是**合并后有没有第二份副本**。①死于副本静默分叉，③没有副本可分叉。

## 升级/维护备忘

- **构建**：`npm run bundle` = `tsdown` + `scripts/copy-web.mjs`（抖音与 QQ 设置页的 html/css 要单独拷进 `lib/douyin-web/`、`lib/qq-web/`，脚本里加目录即可）。
- **测试**：`npm test`（pet，TS）+ `npm run test:douyin`（抖音，JS）+ `npm run test:qq`（QQ，JS）；`npm run test:all` 串起来跑。
  **必须分开跑**：两边测试都会起本地端口/临时服务，`node --test` 并发时会互相踩（混跑会挂 80 多条）。
- **只改 `src/`，不要手改 `lib/`**——`lib/` 是构建产物。
- 抖音的设置在技能标签里点开是一张整页（iframe），不是 React 组件：那 3000 行前端是围绕"独立页面"设计的，改写成 React 的收益远小于风险。
- **改名的连带动作**：`package.json` 的 `name`、`cordis.patch.yml` 的 `id`/`name`、`src/client/index.ts` 里
  `__ModuleLoader__.load({ id })` 三处必须一起改；profile 侧（`~/.dsh/profiles/*/package.json` 的依赖键与
  `bundles`、`node_modules` 软链名）也要同步，否则 DSH 找不到插件。
