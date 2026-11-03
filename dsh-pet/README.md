# dsh-pet-skill 🐾

一只住在 DeepSeek Harness 里的桌面宠物，一百余个透明动画，可多开、能上桌面；**宠物带一双手**——同包带两个可选技能：

- **抖音**：扫码授权后宠物可浏览推荐流并播报、生成分享卡、写私信草稿（个人号无发送接口，如实做草稿 + 唤起 App）、后台监听会话自动回复（大模型现写，可先试运行）、把素材目录扫成竖版发布包（转码 + 文案 + 节奏闸门）。宠物侧全部动作过授牌闸门 + 审计。
- **QQ**：接任何 OneBot v11 网关（NapCat / LLBot / SnowLuma，插件只连接、不碰你的 QQ 进程），私聊群聊自动回复；黑白名单、静默时段、频率配额、试运行模式层层把关。

装不装、开不开由你——两个技能默认全关。

## 安装

- 桌面应用：「插件」页 →「+ 添加插件」→ 填 `dsh-pet-skill`
- 命令行：`dsh plugin --profile <profile> add dsh-pet-skill`

## 装完先看这里

1. 宠物直接出现在**界面右上角**，不用手动开。右键它可换位置、点播动画、对话。
2. 设置入口不在「插件」页（那里只有开关），在 **设置（`Ctrl`+`Alt`+`,`）→ 桌宠配置**：宠物列表、显示位置、人设、模型、物理手感、抖音 / QQ 技能都在这里。
3. 默认 `display: "both"`，想上桌面需要 Electron 运行时：本机没有时插件会**自动下载**一份（约 104MB，走 npmmirror），进度显示在宠物头顶气泡，日志在 `~/.dsh/dsh-pet/logs.txt`。下载失败只影响桌面形态，浏览器里的宠物照常可用。

安装细节与完整文档：**<https://github.com/xinstart-1/dsh-pet-skills>**

许可：代码 MIT；素材禁止商用；二创在公开渠道须署名（同上链接）。

## 包里带的第三方组件

`assets/napcat/` 内是 **NapCat 官方 OneKey 安装器**（v4.18.41，原样副本，SHA-256 与 GitHub Release 一致），
用于 QQ 技能页的「一键装网关」。它**只含安装器，不含 QQ 客户端**——腾讯 QQ 是专有软件，由安装器在你的机器上
从官方渠道下载。NapCat 使用它自己的 Limited Redistribution License（允许再分发、禁止商用），
全文见 `assets/napcat/LICENSE-NapCat.txt`，来源与校验值见 `assets/napcat/README.md`。

随包这份可能过期；QQ 设置页另提供「**下载最新安装器**」按钮，从 GitHub `releases/latest`
拉最新版并校验 SHA-256 后落到用户数据目录（优先级高于随包内置），免重装即可更新。

## 卸载清理

**推荐的卸载顺序：先在 QQ 设置页「说明 → 卸载与清理」点「彻底卸载并清理」，再去 DSH 插件页移除插件。**

- 那个按钮（二次确认）会删除 `%DSH_HOME%/dsh-pet-qq`（QQ 网关、**登录态**、配置）、
  `%DSH_HOME%/dsh-pet`（宠物配置与素材），并可选删除 `%DSH_HOME%/electron`（约 104MB 运行时，可重下）。

**直接在 DSH 插件页删了插件（没点上面的按钮）会怎样：**

| 内容 | 是否自动清掉 |
| --- | --- |
| `dsh-pet-qq/napcat/`（安装器 + NapCat Shell + **QQ 客户端本体**，装好后约 1.2GB，可重下） | ✅ 卸载时自动同步清掉 |
| 其他插件目录、`%DSH_HOME%` 本身 | 不碰 |
| `dsh-pet-qq/` 的配置与 **QQ 登录态**、`dsh-pet/` 配置与素材 | ❌ 会残留，需手动删 |

> 实测说明：NapCat 的 OneKey 安装器是把 QQ 客户端**解压进 Shell 目录**（`napcat/app/NapCat.*.Shell/`，约 1.2GB），
> 不是装到 `C:\Program Files\Tencent\QQNT`。所以「删插件 → 自动清 `napcat/`」会把这份 QQ 一起清掉，
> 不会在系统里留一个陌生 QQ。你日常用的 QQ 是另外装的，不受影响。

**QQ 客户端本体（NTQQ）不归插件管**：它由安装器弹出的 QQ 安装界面装到用户自选位置
（常见 `C:\Program Files\Tencent\QQNT`），插件不读也不删那个位置。想卸 QQ 客户端请走
Windows「设置 → 应用」的 QQ 卸载入口。

手动兜底（PowerShell）：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsh-pet-qq"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsh-pet"
# 可选：Electron 运行时（约 104MB，下次需要桌面形态时会重下）
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\electron"
```

> 如果设了 `$env:DSH_HOME`，把上面路径里的 `.dsh` 换成它的值。

**为什么不在卸载钩子里静默全删**：Cordis 的 `ctx.effect` 在「移除插件」和「禁用插件」时**都会触发**，
两者无法区分。在里面全删等于"禁用一下就丢配置和 QQ 登录态"。所以卸载钩子只清**可再生、无隐私**的
`napcat/` 网关目录；真删用户数据必须由用户在设置页主动确认。
