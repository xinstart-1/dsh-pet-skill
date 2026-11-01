# dsh-pet-skill 🐾

一只住在 DeepSeek Harness 里的桌面宠物，一百余个透明动画，可多开、能上桌面；同包带两个可选技能（抖音、QQ），装不装、开不开由你。

## 安装

- 桌面应用：「插件」页 →「+ 添加插件」→ 填 `dsh-pet-skill`
- 命令行：`dsh plugin --profile <profile> add dsh-pet-skill`

## 装完先看这里

1. 宠物直接出现在**界面右上角**，不用手动开。右键它可换位置、点播动画、对话。
2. 设置入口不在「插件」页（那里只有开关），在 **设置（`Ctrl`+`Alt`+`,`）→ 桌宠配置**：宠物列表、显示位置、人设、模型、物理手感、抖音 / QQ 技能都在这里。
3. 默认 `display: "both"`，想上桌面需要 Electron 运行时：本机没有时插件会**自动下载**一份（约 104MB，走 npmmirror），进度显示在宠物头顶气泡，日志在 `~/.dsh/dsh-pet/logs.txt`。下载失败只影响桌面形态，浏览器里的宠物照常可用。

安装细节与完整文档：**<https://github.com/PC2005-cloud/dsh-pet>**

许可：代码 MIT；素材禁止商用；二创在公开渠道须署名（同上链接）。

## 包里带的第三方组件

`assets/napcat/` 内是 **NapCat 官方 OneKey 安装器**（v4.18.41，原样副本，SHA-256 与 GitHub Release 一致），
用于 QQ 技能页的「一键装网关」。它**只含安装器，不含 QQ 客户端**——腾讯 QQ 是专有软件，由安装器在你的机器上
从官方渠道下载。NapCat 使用它自己的 Limited Redistribution License（允许再分发、禁止商用），
全文见 `assets/napcat/LICENSE-NapCat.txt`，来源与校验值见 `assets/napcat/README.md`。
