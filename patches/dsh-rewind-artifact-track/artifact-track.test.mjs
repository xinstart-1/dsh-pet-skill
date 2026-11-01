// artifact-track.js 的离线单测：不依赖 DSH 运行时，用临时目录模拟工作区。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { ArtifactTracker } from './artifact-track.js';

const BASE = join(process.cwd(), '.scratch', 'artifact-test');

async function freshDir(name) {
  const dir = join(BASE, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

async function setup(mode) {
  const root = await freshDir(`root-${mode}`);
  const ws = await freshDir(`ws-${mode}`);
  await writeFile(join(ws, 'a.txt'), 'AAAA');
  await writeFile(join(ws, 'b.txt'), 'BBBBBB');
  await writeFile(join(ws, 'c.txt'), 'CC');
  const tracker = new ArtifactTracker({
    rootDir: () => root,
    cwdOf: () => ws,
    maxFileBytes: 64 * 1024 * 1024,
    baselineContent: mode === 'withBaseline',
    exclude: 'node_modules,.git',
    keepManifests: 10,
    logger: { warn: (m) => console.error('[warn]', m) },
  });
  return { root, ws, tracker, sessionId: 'session-test' };
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

test('baseline 不缓存内容时：改过的大文件进隔离区，新文件被清走，缺文件只报告', async () => {
  const { ws, tracker, sessionId } = await setup('plain');
  await tracker.ensureBaseline(sessionId);

  // 回合 1（从消息 100 开始）：改 a，删 b，新建 d
  await writeFile(join(ws, 'a.txt'), 'AAAA-CHANGED');
  await rm(join(ws, 'b.txt'));
  await writeFile(join(ws, 'd.bin'), 'DDDDDDDD');
  await tracker.onTurnEnd(sessionId, 100);

  // 回退到 100 意味着回到“回合 100 之前”，即基线：a 没有基线内容 → 只能清理
  const preview = await tracker.preview(sessionId, 100);
  const byPath = new Map(preview.map((item) => [item.path, item.action]));
  assert.equal(byPath.get(join(ws, 'a.txt')), 'delete', '无备份的大改文件应计划清理');
  assert.equal(byPath.get(join(ws, 'd.bin')), 'delete', '回合新建的产物应被清走');
  assert.equal(byPath.has(join(ws, 'b.txt')), false, '缺失且无备份的文件不进动作清单');

  // 回合 2：继续改 a、改 d、新建 e
  await writeFile(join(ws, 'a.txt'), 'AAAA-CHANGED-AGAIN');
  await writeFile(join(ws, 'd.bin'), 'DDDD');
  await writeFile(join(ws, 'e.mp4'), 'EEEEEEEEEE');
  await tracker.onTurnEnd(sessionId, 200);

  const summary = await tracker.restore(sessionId, 100, 300);
  assert.equal(await readText(join(ws, 'a.txt')), undefined, 'a 无基线内容，应被移走');
  assert.equal(await readText(join(ws, 'd.bin')), undefined);
  assert.equal(await readText(join(ws, 'e.mp4')), undefined);
  assert.equal(summary.quarantine, 3);
  assert.equal(summary.skipped, 1, 'b 在基线里但无内容备份，只报告');
  assert.ok(summary.dir, '应给出隔离区目录');
  const index = JSON.parse(await readFile(join(summary.dir, 'index.json'), 'utf8'));
  assert.equal(index.items.length, 3);
  assert.ok(index.items.every((item) => item.action === 'quarantine'));
});

test('baseline 缓存内容时：能按目标版还原字节，新文件进隔离区', async () => {
  const { ws, tracker, sessionId } = await setup('withBaseline');
  await tracker.ensureBaseline(sessionId);

  await writeFile(join(ws, 'a.txt'), 'AAAA-CHANGED');
  await rm(join(ws, 'b.txt'));
  await writeFile(join(ws, 'd.bin'), 'DDDDDDDD');
  await tracker.onTurnEnd(sessionId, 100);

  await writeFile(join(ws, 'a.txt'), 'AAAA-CHANGED-AGAIN');
  await writeFile(join(ws, 'd.bin'), 'DDDD');
  await writeFile(join(ws, 'e.mp4'), 'EEEEEEEEEE');

  const summary = await tracker.restore(sessionId, 100, 300);
  assert.equal(await readText(join(ws, 'a.txt')), 'AAAA', 'a 应还原到基线内容');
  assert.equal(await readText(join(ws, 'b.txt')), 'BBBBBB', 'b 应还原');
  assert.equal(await readText(join(ws, 'c.txt')), 'CC', 'c 未变，不应动');
  assert.equal(await readText(join(ws, 'd.bin')), undefined);
  assert.equal(await readText(join(ws, 'e.mp4')), undefined);
  assert.equal(summary.restored, 2);
  assert.equal(summary.quarantine, 2);
});

test('回退到中间边界：按该回合结束时的版本还原', async () => {
  const { ws, tracker, sessionId } = await setup('withBaseline');
  await tracker.ensureBaseline(sessionId);

  await writeFile(join(ws, 'a.txt'), 'V1');
  await tracker.onTurnEnd(sessionId, 100);
  await writeFile(join(ws, 'a.txt'), 'V2-2');
  await writeFile(join(ws, 'a.txt.tmp'), 'TMP');
  await tracker.onTurnEnd(sessionId, 200);
  await writeFile(join(ws, 'a.txt'), 'V3-3-3');

  // 回退到消息 200 = 回到“回合 200 之前” = 回合 100 结束时的状态
  const summary = await tracker.restore(sessionId, 200, 400);
  assert.equal(await readText(join(ws, 'a.txt')), 'V1', '回到 key=100 那份清单');
  assert.equal(await readText(join(ws, 'a.txt.tmp')), undefined, '该版本里没有的临时文件应被清走');
  assert.equal(summary.restored, 1);
  assert.equal(summary.quarantine, 1);

  // 回退后清单被收拾干净，可以继续记录
  const keys = await tracker.listManifestKeys(sessionId);
  assert.ok(keys.includes(400));
  assert.ok(!keys.includes(500));
});

test('排除目录与符号链接不参与追踪', async () => {
  const { ws, tracker, sessionId } = await setup('plain');
  await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(ws, 'node_modules', 'pkg', 'index.js'), 'x');
  await mkdir(join(ws, '.hidden'), { recursive: true });
  await writeFile(join(ws, '.hidden', 'secret.txt'), 'y');
  await tracker.ensureBaseline(sessionId);
  await writeFile(join(ws, 'node_modules', 'pkg', 'index.js'), 'zzz');
  await writeFile(join(ws, '.hidden', 'secret.txt'), 'yyy');
  await tracker.onTurnEnd(sessionId, 100);
  const preview = await tracker.preview(sessionId, 200);
  assert.equal(preview.length, 0, '排除目录不应出现在影响清单里');
});