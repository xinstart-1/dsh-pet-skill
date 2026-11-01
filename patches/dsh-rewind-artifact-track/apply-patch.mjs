#!/usr/bin/env node
// 给已安装的 dsh-rewind-plugin 打上“命令产物追踪”补丁。
//
//   node apply-patch.mjs                 # 默认打到 ~/.dsh/profiles/desktop 下的插件
//   node apply-patch.mjs --profile xxx   # 指定 profile
//   node apply-patch.mjs --pkg 目录       # 指定插件目录（演练用）
//   node apply-patch.mjs --revert        # 用备份 lib/index.js.orig 还原
//
// 幂等：始终以 lib/index.js.orig（首次运行时的原版）为基底重新打补丁。
// 打完后需要重启 DSH（宿主半侧代码只在启动时加载）。
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const profile = flag('--profile') ?? 'desktop';
const revert = argv.includes('--revert');

const pkg = flag('--pkg') ?? join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-rewind-plugin');
const indexFile = join(pkg, 'lib', 'index.js');
const backupFile = join(pkg, 'lib', 'index.js.orig');
const moduleSrc = join(here, 'artifact-track.js');
const moduleDest = join(pkg, 'lib', 'artifact-track.js');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function replaceOnce(source, search, insert, mode = 'before') {
  const at = source.indexOf(search);
  if (at === -1) throw new Error(`anchor not found:\n${search.slice(0, 160)}`);
  if (source.indexOf(search, at + 1) !== -1) throw new Error(`anchor is not unique:\n${search.slice(0, 160)}`);
  if (mode === 'replace') return source.slice(0, at) + insert + source.slice(at + search.length);
  if (mode === 'after') return source.slice(0, at + search.length) + insert + source.slice(at + search.length);
  return source.slice(0, at) + insert + source.slice(at);
}

if (!(await exists(indexFile))) {
  console.error(`plugin not found: ${indexFile}`);
  process.exit(1);
}

if (revert) {
  if (!(await exists(backupFile))) {
    console.error(`no backup to revert from: ${backupFile}`);
    process.exit(1);
  }
  await copyFile(backupFile, indexFile);
  console.log(`reverted ${indexFile} from backup`);
  process.exit(0);
}

const alreadyBackedUp = await exists(backupFile);
const base = await readFile(alreadyBackedUp ? backupFile : indexFile, 'utf8');
if (!alreadyBackedUp) {
  await copyFile(indexFile, backupFile);
  console.log(`backup written: ${backupFile}`);
}

let out = base;

// 1) 引入补丁模块
out = replaceOnce(out, 'import z from "@deepseek-ai/schemastery";', '\nimport { ArtifactTracker } from "./artifact-track.js";', 'after');

// 2) 配置项
out = replaceOnce(
  out,
  '  autoCleanupMaxAgeDays: z.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays).volatile()\n});',
  '  autoCleanupMaxAgeDays: z.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays).volatile(),\n' +
    '  // [dsh-artifact-patch] 命令产物追踪（渲染/ffmpeg 等非 write/edit 产物）\n' +
    '  artifactTrackingEnabled: z.boolean().default(true),\n' +
    '  artifactMaxFileBytes: z.number().step(1).min(0).default(64 * 1024 * 1024),\n' +
    '  artifactBaselineContent: z.boolean().default(false),\n' +
    '  artifactExclude: z.string().default("node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,coverage,__pycache__,venv,.venv,target"),\n' +
    '  artifactKeepManifests: z.number().step(1).min(1).default(20)\n});',
  'replace',
);

// 3) 模块级实例
out = replaceOnce(out, 'var cleanupStore;', '\nvar artifactTracker;', 'after');

// 4) 本地化文案
const locales = {
  en: `
  "artifact.prefix": "artifacts: ",
  "artifact.moved": "{count} file(s) moved to quarantine ({dir})",
  "artifact.unbacked": "{count} file(s) without content backup (re-generate if needed)",
  "artifact.failed": "{count} artifact file(s) failed",`,
  zh: `
  "artifact.prefix": "产物：",
  "artifact.moved": "{count} 个文件移入隔离区（{dir}）",
  "artifact.unbacked": "{count} 个文件无内容备份（如需旧版本请重新生成）",
  "artifact.failed": "{count} 个产物文件处理失败",`,
  ja: `
  "artifact.prefix": "生成物：",
  "artifact.moved": "{count} 件を隔離ディレクトリへ移動（{dir}）",
  "artifact.unbacked": "{count} 件は内容バックアップなし（必要なら再生成してください）",
  "artifact.failed": "{count} 件の生成物処理に失敗",`,
};
for (const [lang, block] of Object.entries(locales)) {
  out = replaceOnce(out, `var ${lang} = {`, block, 'after');
}

// 5) 实例化
out = replaceOnce(
  out,
  '  const trackedBySession = /* @__PURE__ */ new Map();',
  `
  const artifactCwds = /* @__PURE__ */ new Map();
  artifactTracker = config?.artifactTrackingEnabled === false
    ? void 0
    : new ArtifactTracker({
        rootDir: () => store.root,
        cwdOf: (sessionId) => artifactCwds.get(sessionId),
        maxFileBytes: config?.artifactMaxFileBytes,
        baselineContent: config?.artifactBaselineContent === true,
        exclude: config?.artifactExclude,
        keepManifests: config?.artifactKeepManifests,
        logger: ctx.logger
      });`,
  'after',
);

// 6) 记录会话工作区 + 基线
out = replaceOnce(
  out,
  '        const result = await store.reconcileFormatVersion(session.id, session.header.version);\n' +
    '        if (result.cleared) {\n' +
    '          ctx.logger.warn(`[dsh-rewind] cleared snapshots for ${session.id}: session format changed (v${session.header.version})`);\n' +
    '        }',
  `
        if (typeof session.header.cwd === "string") artifactCwds.set(session.id, session.header.cwd);
        if (artifactTracker !== void 0) {
          void artifactTracker.ensureBaseline(session.id);
        }`,
  'after',
);

// 7) 回合结束时记一份产物清单
out = replaceOnce(
  out,
  '  ctx.on("session/event", (session, event) => {\n',
  `    if (event.type === "turn/end") {
      if (isSubagentSession(session) || artifactTracker === void 0 || !isFileCheckpointingEnabled(config)) return;
      const events2 = session.snapshotEvents();
      let keySeq2 = 0;
      for (let i = events2.length - 1; i >= 0; i--) {
        if (events2[i].type === "user/message") {
          keySeq2 = events2[i].seq;
          break;
        }
      }
      if (keySeq2 > 0) void artifactTracker.onTurnEnd(session.id, keySeq2);
      return;
    }
`,
  'after',
);

// 8) 工具执行时刷新工作区路径
out = replaceOnce(
  out,
  '    scope.on("tools/execute", async (exec, next) => {\n      try {\n        if (isFileCheckpointingEnabled(config)) {\n          await captureBefore(fs, workingDirectory, store, exec, pending);\n        }',
  `
        if (artifactTracker !== void 0 && exec.agent !== void 0) {
          try {
            artifactCwds.set(exec.agent.session.id, await workingDirectory.ensure(exec.agent, exec.signal));
          } catch {
          }
        }`,
  'after',
);

// 9) 影响清单合并
out = replaceOnce(
  out,
  '  const uncovered = await store.uncoveredPaths(session.id).catch(() => []);\n  return { files: impacts, uncovered, backupOff: !checkpointingEnabled };',
  `  const uncovered = await store.uncoveredPaths(session.id).catch(() => []);
  let artifactImpacts = [];
  if (artifactTracker !== void 0) {
    try {
      artifactImpacts = await artifactTracker.preview(session.id, plan.targetSeq);
    } catch (error) {
      artifactImpacts = [];
    }
  }
  const known = new Set(impacts.map((item) => item.path));
  const mergedImpacts = impacts.concat(artifactImpacts.filter((item) => !known.has(item.path)));
  mergedImpacts.sort((a, b) => a.path.localeCompare(b.path));
  return { files: mergedImpacts, uncovered, backupOff: !checkpointingEnabled };`,
  'replace',
);

// 10) 回退时执行产物回滚
out = replaceOnce(
  out,
  '    return {\n      kind: "success",\n      text: t("success", { targetSeq: plan.targetSeq, restore }),',
  `    if (mode === "both" && artifactTracker !== void 0) {
      try {
        const q = await artifactTracker.restore(agent.session.id, plan.targetSeq, event.seq);
        if (fs !== void 0 && (q.restoredPaths.length > 0 || q.quarantinedPaths.length > 0)) {
          await syncRestoreObservations(ctx, fs, agent, { restored: q.restoredPaths, deleted: q.quarantinedPaths });
        }
        const bits = [];
        if (q.restored > 0) bits.push(t("restore.count", { count: q.restored }));
        if (q.quarantine > 0) bits.push(t("artifact.moved", { count: q.quarantine, dir: q.dir ?? "" }));
        if (q.skipped > 0) bits.push(t("artifact.unbacked", { count: q.skipped }));
        if (q.failed > 0) bits.push(t("artifact.failed", { count: q.failed }));
        if (bits.length > 0) {
          const line = \`\${t("artifact.prefix")}\${bits.join(t("sep.list"))}\`;
          restore = restore === "" ? line : \`\${restore}\${t("sep.clause")}\${line}\`;
        }
      } catch (error) {
        ctx.logger.warn(\`[dsh-rewind] artifact restore failed: \${error instanceof Error ? error.message : String(error)}\`);
      }
    }
`,
  'before',
);

await writeFile(indexFile, out, 'utf8');
await copyFile(moduleSrc, moduleDest);
console.log(`patched: ${indexFile}`);
console.log(`module:  ${moduleDest}`);
console.log('restart DSH to load the host-side patch.');