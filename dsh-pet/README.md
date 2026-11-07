# dsh-pet-skill 🐾

一只住在 DeepSeek Harness 里的桌面宠物，一百余个透明动画，可多开、能上桌面；**宠物带一双手**——同包带两个可选技能：

- **抖音**：扫码授权后宠物可浏览推荐流并播报、生成分享卡、写私信草稿（个人号无发送接口，如实做草稿 + 唤起 App）、后台监听会话自动回复（大模型现写，可先试运行）、把素材目录扫成竖版发布包（转码 + 文案 + 节奏闸门）。宠物侧全部动作过授牌闸门 + 审计。
- **QQ**：接任何 OneBot v11 网关（NapCat / LLBot / SnowLuma，网关自己装自己登录；也可用内置安装器一键装一份便携副本，不碰你系统里的 QQ），私聊群聊自动回复；黑白名单、静默时段、频率配额、试运行模式层层把关。

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
从官方渠道下载一份**便携副本**解压进插件自己的目录（不装进系统、不动你已装的 QQ）。NapCat 使用它自己的
Limited Redistribution License（允许再分发、禁止商用），全文见 `assets/napcat/LICENSE-NapCat.txt`，
来源与校验值见 `assets/napcat/README.md`。

随包这份可能过期；QQ 设置页另提供「**下载最新安装器**」按钮，从 GitHub `releases/latest`
拉最新版并校验 SHA-256 后落到用户数据目录（优先级高于随包内置），免重装即可更新。

## 卸载清理

**推荐的卸载顺序：先在 QQ 设置页「说明 → 卸载与清理」点「彻底卸载并清理」，再去 DSH 插件页移除插件。**

- 那个按钮（二次确认）会删除 `%DSH_HOME%/dsh-pet-qq`（QQ 网关、**登录态**、配置）、
  `%DSH_HOME%/dsh-pet`（宠物配置与素材），并可选删除 `%DSH_HOME%/electron`（约 104MB 运行时，可重下）。

**直接在 DSH 插件页删了插件（没点上面的按钮）会怎样：**

| 内容                                                                                                 | 是否自动清掉          |
| ---------------------------------------------------------------------------------------------------- | --------------------- |
| `dsh-pet-qq/napcat/`（安装器 + NapCat Shell + **QQ 便携副本** + 300MB 安装包，实测约 1.5GB，可重下） | ✅ 卸载时自动同步清掉 |
| 其他插件目录、`%DSH_HOME%` 本身                                                                      | 不碰                  |
| `dsh-pet-qq/` 的配置与 **QQ 登录态**、`dsh-pet/` 配置与素材                                          | ❌ 会残留，需手动删   |

> 实测说明：NapCat 的 OneKey 安装器是把 QQ **解压成一份便携副本**放进插件自己的目录
> （`napcat/app/NapCat.*.Shell/`，解出约 1.15GB；安装包原文件留在 `napcat/QQ.exe`，约 300MB，
> 重跑时靠它跳过下载）。安装器全程不往系统里装：不落 `C:\Program Files`，装完
> `HKCU\Software\Tencent\QQNT` 的版本仍是系统那份（本机 9.9.36），没被便携副本的 9.9.33 顶掉。

**安装失败可以直接重试，坏包会自动清掉**：安装器下载不做断点续传，却只按"文件在不在"决定复用，
所以一个下到一半的包会让之后每次重试都死在同一处（实测 `NapCat.Shell.zip` 停在 10.9MB）。
插件在每次安装前、以及每次失败后都会校验 `napcat/QQ.exe` 与 `napcat/NapCat.Shell.zip` 的完整性
（zip 看 EOCD 声明、PE 看段表声明），**证明截断就删掉重下**；判不准的一律保留，不会误删下好的 300MB。

**网关包由插件先校验再交给安装器，绕开坏镜像**：这是"每次都失败"的真正病根——安装器自己下
`NapCat.Shell.zip` 时**不校验长度**，镜像 `ghfast.top` 直接 403，`ghproxy.net` 把 34MB 截成 4.6MB，
而它照样打印 `[成功] 文件下载完成: 4 MB` / `[成功] NapCat下载成功`，接着 7z 报
`Unexpected end of archive`、`解压NapCat失败，错误码: 2`。所以插件改用 GitHub release 的官方元数据
（`size` + `digest: sha256:<hex>`）自己下一份，**大小与 SHA-256 都对上才放进安装器的工作目录**，
让它走"文件已存在 → 跳过下载"这条路。预取拿不到时如实退回安装器自己的下载路径，不会因此装不了。
（顺带修掉一个真 bug：`digest` 曾被按 base64 解码，而 GitHub 给的是 `sha256:<hex>`，等于校验一直没真正生效。）

**你系统里装的那个 QQ 不归插件管、也不会被碰**：插件全程只在 `%DSH_HOME%/dsh-pet-qq/napcat/`
里操作那份副本，不读也不删 `C:\Program Files\Tencent\QQNT` 之类的位置。本机实测：装在 `C:\APP\QQ`
的 QQ 客户端在整个一键安装过程中没被改动（文件时间仍是他装它那天，注册表版本也没变）。
想卸你日常用的 QQ 请走 Windows「设置 → 应用」的 QQ 卸载入口。

> 一处**已知边界**：登录态落在哪儿由 QQ 客户端自己决定（QQNT 习惯写 `%USERPROFILE%\Documents\Tencent Files`），
> 不在插件的清理范围里。「彻底卸载并清理」只删上面表格列出的目录，需要连 QQ 账号数据一起清的话请手动处理。

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
