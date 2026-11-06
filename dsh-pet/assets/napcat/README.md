# 第三方组件：NapCat 网关安装器

本目录内的 `NapCat.Shell.Windows.OneKey.zip` 是 **NapCat 官方发行包的原样副本**，未做任何修改。

## 来源与版本

| 项 | 值 |
|---|---|
| 项目 | NapCatQQ（NapNeko/NapCatQQ） |
| 版本 | v4.18.41（2026-10-21 发布） |
| 发行页 | https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41 |
| 资产 | `NapCat.Shell.Windows.OneKey.zip` |
| 原始大小 | 994134 字节 |
| SHA-256 | `46c3ec155aa61f12e89bbf97013a21243d00b0019b5565992a88852d7627f39c` |

SHA-256 与 GitHub Release API 上该资产的 `digest` 字段逐位一致，可用于校验副本未被篡改。

## 包内包含什么

解压后约 2.3 MB：

- `NapCatInstaller.exe` —— 安装器（**无界面控制台程序**，PE32+ console）。它会在**用户自己的机器上**下载腾讯 QQ 客户端（NTQQ）安装包与 NapCat Shell 本体，并把两者解压进它自己的当前目录
- `7z.exe` / `7z.dll` —— 7-Zip（LGPL，随 NapCat 发行包一同分发，未修改）
- `bootmain/` —— `NapCatWinBootMain.exe`、`NapCatWinBootHook.dll`、`napcat.bat` 等启动脚本

## 安装器实际怎么干活（实测 v4.18.41）

1. `检查QQ安装包...` —— 看**自己当前目录里有没有 QQ 安装包文件**（下载后会留在原地并改名 `QQ.exe`）。有就跳过下载直接解压；没有就下一个约 300MB 的 `QQ_9.9.x_..._x64_01.exe`。**它不检测本机装没装 QQ**：实测这台机器已经装了 QQ（`HKCU\Software\Tencent\QQNT` 有版本号、`C:\APP\QQ\QQ.exe` 在位），这一步照样去下了完整的 300MB。
2. `开始解压QQ安装包...` —— `.\7z.exe -oNapCat.<build>.Shell x "QQ.exe" -y`，解出约 1.15GB（1868 个文件）。
3. `检查NapCat压缩包...` —— 同理，`NapCat.Shell.zip`（约 34MB）在就复用，不在就从 GitHub / 镜像下。
4. 把 Shell 解到 `NapCat.<build>.Shell\versions\<版本>\resources\app\napcat`，改 `package.json` 的 `main`，写 `napcat.bat`。
5. `===== 安装完成 =====` 后自行退出。

不弹任何窗口、不选目录、不问下一步、不读命令行参数：**装到哪只由 cwd 决定**。所以插件把它 spawn 在 `<数据目录>/napcat` 下跑，`7z.exe` 与 `bootmain/` 必须和它同目录（它按 cwd 找 `.\7z.exe`）。

### 它不会察觉自己被截断（插件为此补了一道）

安装器下载时不做断点续传，网络一抖就留下一个不完整的包；而它**下次启动只判断"文件在不在"**，于是拿着截断包再解压、再失败——每次重试都死在同一处，用户也看不出要先删哪个文件。实测遇到过：`NapCat.Shell.zip` 停在 10.9MB（真包 35.9MB），7z 报 `Unexpected end of archive`，安装器打印 `[错误] 解压NapCat失败，错误码: 2` 后停在 `Press any key`。

插件因此加了两道自愈（`napcat.js` 的 `purgeBrokenPackages` / `inspectPackage`）：

- **跑之前**：检查 `<数据目录>/napcat/QQ.exe` 与 `NapCat.Shell.zip` 是否完整——zip 按 EOCD 声明的中央目录偏移算应有大小、PE 按段表算最小字节数，对不上就判定截断并删除，让安装器只能重新下载；
- **失败之后**：再清一次，下次点「① 一键安装」必然是真·重新下载。

判不准的一律**不删**：认不出格式、或大小对得上的文件都当好的留着——误删一个完整的 300MB `QQ.exe`（那是重跑时跳过下载的唯一依据）代价太大。

因此 QQ 是**解压成一份便携副本**，不是安装进系统：不落 `C:\Program Files`、不改系统 QQ 的注册表项，用户桌面/开始菜单里那份 QQ 不参与也不被改。（实测：装完 `HKCU\Software\Tencent\QQNT` 的版本仍是系统那份 9.9.36，没被副本的 9.9.33 覆盖。）

## 这里**没有**包含什么，以及为什么

**没有 QQ 客户端（NTQQ）。** 腾讯 QQ 是专有软件，未经授权不得再分发。本包只带那个 994 KB 的安装器，QQ 客户端必须由安装器在最终用户的机器上从腾讯官方渠道下载——这正是它的原始设计。

## 许可

NapCat 使用它自己的 **Limited Redistribution License**（全文见同目录 `LICENSE-NapCat.txt`），要点：

1. 允许再分发，但必须附完整许可全文，并明确标注来源与版权
2. **禁止任何商业用途**
3. 修改过的代码不得公开发布（因此这里只有原样副本，没有任何改动）

本插件是个人非商业项目，随包分发满足上述条件。若你要把本插件用于商业用途，必须先取得 NapCat 作者的授权。

## 升级

新版本发布后需要手动替换本目录的 zip、更新 `version.json` 与本文的版本号与 SHA-256。
安装器负责在用户机器上拉取 QQ 与 Shell 本体，因此**替换 zip 的收益主要是"新版安装器修了安装流程的 bug"**，不是内容更新。

复核命令：

```bash
sha256sum assets/napcat/NapCat.Shell.Windows.OneKey.zip
```

### 用户侧的「下载最新安装器」

插件设置页（QQ → 一键装网关）除随包内置安装器外，还提供一个
**「下载最新安装器」**按钮：点它会从 GitHub `releases/latest` 拉取最新版
`NapCat.Shell.Windows.OneKey.zip`，**边下边校验 SHA-256**（取 GitHub 资产自带的
`digest` 字段，base64 解码后与本地逐块计算的哈希比对），校验通过才落盘到用户数据目录
（`<数据目录>/napcat/`，Windows 下即 `%APPDATA%` 同级的 napcat 目录），并写入
`napcat-version.json`；校验不通过的包直接丢弃、绝不落盘。下载的版本会成为解压时的
**优先来源**（高于随包内置），状态里会标注来源是「已下载最新版」还是「随包内置」。

这样即使随包那份安装器过期或解压失败，用户也能在不碰 git、不重装插件的前提下拿到最新版。
