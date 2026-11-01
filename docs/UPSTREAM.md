# 上游同步（UPSTREAM）—— 已停止

## 现状：本目录是自己的分支，不再跟上游

`dsh-pet-main/dsh-pet/` 基于 `dsh-pet@0.3.8`，从 2026-10-28 起**不再逐版同步上游**，
且包名已改为 **`dsh-pet-skill`**（fork 身份：桌宠 + 技能，不再只是"一只宠物"）。

原因很实际：抖音能力（约 1.2 万行）已经整体搬进这棵树。任何上游更新都要在这 1.2 万行之上
手工 rebase，冲突面覆盖 host 装配、客户端插槽、路由分发——成本远超收益。

**这个决定是用户明确要求的**：此前"总线 + 多插件"那套（pet 零业务、每处改动都要维护 diff 清单、
跑 `grep -ril "douyin"` 防退化判据、升级重放 12 个文件）对单人单宠物的场景纪律成本太高。

## 想回到上游怎么办

两处现成的基线：

```bash
# ① 上游原版（v0.3.8，唯一提交 = 原样）
archive/pet-card-approach/dsh-pet-main/.git    # 提交 d4411ae

# ② 合并前抖音独立插件的完整快照（含它自己的 test/ 与 lib/）
archive/douyin-plugin-snapshot-20261028/
```

恢复步骤（大致）：

1. `git --git-dir=archive/pet-card-approach/dsh-pet-main/.git --work-tree=. checkout -- .` 拿回原版源码；
2. 用 `archive/douyin-plugin-snapshot-20261028/` 重建独立包，按它原来的 `package.json` 装回 profile；
3. 删除 `src/douyin/`、`src/host/routes/persona.ts`、
   `src/client/settings/{douyin-card,skills,skill-tabs}.ts`，
   并回退 `src/host/index.ts` 里那行 `applyDouyin(ctx)`；
   包名与 `cordis.patch.yml`、`src/client/index.ts` 的模块 id 也要改回 `dsh-pet`（三处必须一致），
   profile 的依赖键 / `bundles` / `node_modules` 软链名同理。

## 如果哪天又要同步上游（不推荐，仅供参考）

技术上只剩一条路：把 `src/douyin/` 当成**只增不改**的独立子树，上游更新时只覆盖上游拥有的文件
（`src/host/**` 里除了 `douyin/` 的部分、`src/client/**` 里除 `settings/douyin-card.ts` 的部分）。
但 `index.ts` 的装配、`settings.ts` 的导出、`locales.ts` 的文案这三处必然冲突，还是要手工合。

## 已知坑（迁移后仍然成立）

- **`lib/` 是构建产物，不能手改**，改 `src/` 后 `npm run bundle`。
- **抖音设置页的静态资源必须单独拷**：`scripts/copy-douyin-web.mjs` 把 `src/douyin/douyin-web/` 复制到
  `lib/douyin-web/`；漏了就是设置页 404（路由用 `new URL('./douyin-web/', import.meta.url)` 定位）。
- **两份测试必须分开跑**：`npm test`（pet）与 `npm run test:douyin`（抖音）都会起本地端口，
  `node --test` 并发执行会互相踩，混在一个命令里会挂 80 多条。
- **改 `lib/` 或 `src/` 都必须重启 DSH 才生效**。
- **profile 里要彻底摘干净**：只删 `package.json` 的 `dependencies` 不够，`node_modules` 的软链
  和 `bundles` 数组里都要去掉——否则独立插件仍会加载，与合并进来的同前缀冲突，
  表现为 `duplicate prefix route "/dsh-douyin-7341"`，而 pet 整个 apply 失败（所有路由 404）。
