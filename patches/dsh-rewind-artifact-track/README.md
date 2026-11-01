# dsh-rewind-plugin 补丁：命令产物追踪

给已安装的 `dsh-rewind-plugin@0.19.1` 加一条“**非 write/edit 产物也要跟着回退**”的通路。

原版插件只认 `write` / `edit` 两个工具写过的文件（`TRACKED_TOOLS = {write, edit}`），
且单文件上限 8MB；用 `node render.mjs` / ffmpeg 渲染出来的成片既不经过这两个工具、又远超 8MB，
所以「回退对话和文件」时 MP4 完全不受影响——这就是“回退了对话，成片没回退”的根因。

## 证据（2026-11-01，检察AI四篇_第五版 / session-15b045d9…）

| 事实 | 出处 |
| --- | --- |
| 22:03:34 回退到 seq 2292，结果文本 `restored 2 file(s)` | 会话日志 `command/done` |
| 快照目录 40+ 条记录全是 `_tmp/*.mjs`、`README.md`、`timeline_office.js`，**没有一条 mp4** | `~/.dsh/rewind-snapshots/session-15b045d9…/3260/` |
| 成片由 `node render.mjs … --out 成品\…\检察办公.mp4` 经 pwsh 生成 | 会话日志 `tool/call`（seq 3206 等） |
| 成片 20–50MB（示例 31.2MB），远超 8MB 上限 | `成品/` 目录实测 |

## 补丁做了什么

1. **回合边界清单**：每个回合结束（`turn/end`）扫描一次工作区，记录
   `相对路径 → size + mtime + 内容哈希`，写到
   `~/.dsh/rewind-snapshots/<session>/artifacts/manifests/<seq>.json`；
   会话开始时的基线是 `0.json`。
2. **内容缓存**：只对“跟上一次清单比变了”的文件备份内容，按 sha256 去重，存
   `…/artifacts/blobs/<sha256>`；单文件超过上限（默认 64MB）的只记状态不存内容。
3. **回退执行**（「回退对话和文件」模式）：
   - 目标时刻存在、现在被改过/缺失，且有内容备份 → 还原字节；
   - 目标时刻不存在、现在存在（命令新建的产物）→ **移入隔离区**；
   - 被改过却没有内容备份（补丁安装前就存在的成片、或超过上限）→ 移入隔离区，
     并计入“无内容备份”，需要重新渲染得到旧版本。
4. **影响清单**：回退前的浮层里会一并列出这些产物（还原 / 删除），确认前可见。
5. 回退后向宿主同步 `fs/observed`，避免会话继续用旧的读取缓存。

## 隔离区

```
~/.dsh/rewind-snapshots/<session>/artifacts/quarantine/<opId>/<原相对路径>
~/.dsh/rewind-snapshots/<session>/artifacts/quarantine/<opId>/index.json
```

`index.json` 记录每份文件的原始绝对路径、移动后位置、原因（`created` / `changed-no-backup`）。
**不硬删**，取回把文件搬回原路径即可。

## 配置（DSH 设置里的插件配置项）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `artifactTrackingEnabled` | `true` | 关掉则完全不追踪 |
| `artifactMaxFileBytes` | 64MB | 单文件内容缓存上限（超过只记状态）；设 0 = 只做隔离不备份内容 |
| `artifactBaselineContent` | `false` | 基线也缓存内容；打开后“装补丁前就存在的文件”第一次被改也能按字节还原，代价是首次整树复制（本项目约 9GB，不建议） |
| `artifactExclude` | `node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,coverage,__pycache__,venv,.venv,target` | 逗号分隔的排除目录名（另有规则：`.` 开头目录一律跳过） |
| `artifactKeepManifests` | `20` | 每会话保留清单份数（基线永久保留）。本项目约 1.9 万文件，单份清单约 2MB |

## 已知限制

- **第一次改动拿不到旧字节**：装上补丁后某文件第一次被改时，旧内容不在缓存里（基线默认不存内容），
  只能把新版本移进隔离区 → 重新渲染。从第二次改动起就能逐字节还原。
- 只在**回合结束**取样：同一回合内多次渲染只留最后一版状态。
- 子代理（subagent）不追踪（与原插件一致）。
- 回合中途插入的 steering 消息，边界归到该回合最后一条用户消息，粒度略粗。
- 磁盘占用随“改动次数 × 文件大小”增长。清理：删
  `~/.dsh/rewind-snapshots/<session>/artifacts/blobs`（清单还在，只是那些版本不再可还原），
  或用插件的 `/snapshot-auto-cleanup`。

## 应用 / 回滚

```powershell
# 应用（幂等：始终以 lib/index.js.orig 为基底重新打补丁）
node apply-patch.mjs                     # 默认 ~/.dsh/profiles/desktop
node apply-patch.mjs --profile verify2    # 其他 profile
node apply-patch.mjs --pkg <插件目录>      # 指定任意插件目录（演练）

# 回滚
node apply-patch.mjs --revert
```

打完**必须重启 DSH**（宿主半侧代码只在启动时加载）。

> 插件升级（`dsh plugin add` / npm 覆盖安装）会覆盖 `lib/index.js` 与 `lib/artifact-track.js`，
> 升级后重跑一次 `node apply-patch.mjs` 即可。

## 自检

```powershell
node artifact-track.test.mjs   # 4 条单测：基线无内容 / 基线有内容 / 中间边界 / 排除目录

# 冒烟（用假 ctx 跑真实 bundle，验证 agent/created 建基线 + turn/end 记清单）：
#   把安装目录的 lib/index.js、lib/artifact-track.js 拷到 .scratch/smoke 再 node smoke.mjs
```

已验证：单测 4/4 通过；`node --check` 通过；在真实 bundle 上跑 `apply()` → 基线清单
`000000000000.json` + 回合清单 `000000000100.json` 正确落盘，成片变化体现为不同哈希、
新产物 `成品/b.mp4` 进入清单、内容 blob 去重正确。