# ops — 容器日志排障工具链

给 DSH 用的"服务器报错分析"最小工具集。**不需要装任何插件**，用的是本机已有的
`ssh`（Windows OpenSSH 客户端）。

## 为什么需要它

你们的 Linux 服务器上**日志没有落文件**，只有 `docker logs`（容器 stdout/stderr）。
`docker logs` 有两个坑：

1. 受 log driver 轮转限制（`max-size` / `max-file`），旧日志会被丢掉；
2. 容器重建（重新 deploy）后，上一个容器的日志就彻底没了。

所以这里的第一步不是"分析"，而是**把日志定期拉成本地副本**——它同时也是你们的留存。

## 三个文件和一条命令

| 文件 | 作用 |
|---|---|
| `pull-docker-logs.ps1` | SSH 到各主机，按时间窗拉 `docker logs --timestamps --since`，同时抓 `docker ps -a` / `docker inspect`（重启次数、ExitCode、OOMKilled、健康检查）/ 负载 / 内存 / 磁盘告警 / `dmesg` OOM 记录 |
| `log-digest.ps1` | 把本地日志聚成**错误指纹摘要**（计数 + 来源 + 首末样本 + 堆栈上下文），几百 token 就能看懂，避免把整份日志灌进模型 |
| `config.json` | 主机与容器白名单（从 `config.example.json` 复制后填） |

```powershell
# 1. 复制配置并填写
Copy-Item .\config.example.json .\config.json

# 2. 拉日志（先 DryRun 看它到底会在服务器上跑什么）
powershell -NoProfile -ExecutionPolicy Bypass -File .\pull-docker-logs.ps1 -Config .\config.example.json -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\pull-docker-logs.ps1

# 3. 出摘要
powershell -NoProfile -ExecutionPolicy Bypass -File .\log-digest.ps1 -Hours 3 -Top 15 -OutMarkdown .\digest.md
```

## 免密（必须先做一次）

Windows 的 OpenSSH **不能非交互输密码**，所以要先配密钥：

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\dsh_ops -N '""'
type $env:USERPROFILE\.ssh\dsh_ops.pub | ssh opsuser@10.0.0.11 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
ssh -i $env:USERPROFILE\.ssh\dsh_ops opsuser@10.0.0.11 "docker ps >/dev/null && echo ok"
```

- 账号只需在服务器 **`docker` 组**里（能跑 `docker ps` / `docker logs` 即可），**不需要 root**；
- 建议专门建一个只读运维账号，别用你的个人账号。

## 安全边界

- 脚本对服务器**只读**：`docker ps -a`、`docker inspect`、`docker logs`、`dmesg`、`df`、`free`；
- 不做任何 `restart` / `rm` / 配置修改；
- 日志里可能有内网 IP、账号、token —— 进对话前由 `log-triage` 技能按脱敏规则处理（`<ip>` / `<redacted>`）；
- 本地副本落在本目录 `logs/<host>/`，默认保留 7 天（`config.json` 的 `keepDays`）。

## 定时巡检

数据链路就是这个 `pull` + `digest`，巡检只是"定时跑 + 只报增量"：

- 首次：全量指纹集合写入 `state/fingerprints.json`；
- 之后每次：只报**新指纹**、**计数突增**、**容器状态从 Up 变为 Restarting/Exited**；
- 没有变化时只回一行。

规则与输出模板见技能 `log-triage`（`%USERPROFILE%\.agents\skills\log-triage\SKILL.md`）。