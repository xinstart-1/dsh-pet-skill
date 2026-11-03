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

- `NapCatInstaller.exe` —— 安装器（图形界面）。它会在**用户自己的机器上**去下载腾讯 QQ 客户端（NTQQ）与 NapCat Shell 本体
- `7z.exe` / `7z.dll` —— 7-Zip（LGPL，随 NapCat 发行包一同分发，未修改）
- `bootmain/` —— `NapCatWinBootMain.exe`、`NapCatWinBootHook.dll`、`napcat.bat` 等启动脚本

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
