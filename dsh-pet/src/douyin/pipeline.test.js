/**
 * 端到端冒烟：扫描 → 准备发布包 → HTTP API。
 *
 * 刻意在**没有 ffmpeg** 的环境里跑：这条路径正是最容易被忽略的降级分支
 * （原样复制源文件 + 在发布包里写明没转码），必须真的能走通。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ROUTE_PREFIX, createRouter } from './router.js';
import { createService } from './service.js';

/** 静默日志：测试里不需要往控制台刷屏 */
const silentLog = { info() {}, warn() {}, error() {}, list: () => [] };

/**
 * 造一个测试环境：一个待发目录 + 三个文件（一个该发、一个被关键词排除、一个不是视频）。
 * @returns {Promise<{home: string, inbox: string}>} 目录
 */
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pet-douyin-'));
  const inbox = join(home, 'inbox');
  await mkdir(inbox, { recursive: true });
  // 700 KiB 的假视频：体积下限调低后它就"够格"了，插件不会去读它的内容（没 ffmpeg）
  await writeFile(join(inbox, '海边 日落.mp4'), Buffer.alloc(700 * 1024, 7));
  await writeFile(join(inbox, 'temp-draft.mp4'), Buffer.alloc(700 * 1024, 7));
  await writeFile(join(inbox, '笔记.txt'), 'not a video');
  return { home, inbox };
}

test('整条链路：扫描识别 → 生成发布包 → 台账去重 → HTTP API', async (t) => {
  const { home, inbox } = await setup();
  let port = 0;
  const service = createService({ home, log: silentLog, getPort: () => port });
  await service.init();

  const saved = await service.saveConfig({
    enabled: true,
    source: { dir: inbox, minSizeMB: 0.1, recursive: false, excludeKeywords: ['temp'] },
    transcode: { mode: 'none' },
    pack: { outDir: join(home, 'packs'), copyCaption: false, openUploadPage: false },
    pet: { bubble: false, workStatus: false },
    caption: {
      titleTemplate: '{name} · {date}',
      descTemplate: '录于 {date} {time}',
      tags: ['日常'],
      visibility: 'public',
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(service.getConfig().source.dir, inbox);

  await t.test('扫描：按扩展名/关键词/体积过滤', async () => {
    const scan = await service.scan();
    assert.equal(scan.error, undefined);
    assert.equal(scan.items.length, 1, '只有一个文件该被挑中');
    assert.equal(scan.items[0].name, '海边 日落');
    assert.equal(scan.skipped.keyword, 1, 'temp-draft 被关键词排除');
    assert.equal(scan.skipped.ext, 1, '笔记.txt 不是视频');
  });

  /** @type {any} */
  let pack;
  await t.test('准备：没有 ffmpeg 也照样出包', async () => {
    const r = await service.prepare({ reason: 'test' });
    assert.equal(r.ok, true, `准备失败：${r.reason}`);
    pack = r.pack;
    assert.equal(pack.video.transcoded, false, '没 ffmpeg 时不该声称转码成功');
    assert.ok(
      pack.warnings.some((w) => w.includes('ffmpeg')),
      '应当在包里写明缺 ffmpeg',
    );
    assert.equal(pack.caption.title.startsWith('海边 日落 · '), true, '标题模板变量被替换');
  });

  await t.test('发布包：四个文件齐了，文案只有文案本身', async () => {
    const files = ['文案.txt', 'meta.json', '说明.txt'];
    for (const f of files)
      assert.ok(
        await stat(join(pack.dir, f)).then(
          () => true,
          () => false,
        ),
        `缺 ${f}`,
      );
    const caption = await readFile(join(pack.dir, '文案.txt'), 'utf8');
    assert.equal(caption.trim(), pack.caption.text.trim(), '文案.txt 必须等于成品文案');
    assert.ok(caption.includes('#日常'), '话题进了文案');
    assert.ok(!caption.includes('下一步'), '文案.txt 里不能有说明文字');

    const meta = JSON.parse(await readFile(join(pack.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.source.name, '海边 日落');
    assert.equal(meta.status, 'packed');

    const readme = await readFile(join(pack.dir, '说明.txt'), 'utf8');
    assert.ok(readme.includes('下一步'));
    assert.ok(readme.includes(pack.source.path), '说明里写明来源文件');
  });

  await t.test('去重：同一条不会准备第二次', async () => {
    const again = await service.prepare({ reason: 'test-again' });
    assert.equal(again.ok, false);
    assert.match(again.reason, /没有可发的新视频/);
  });

  await t.test('台账：记录状态可回填为已发布', async () => {
    const packs = await service.listPacks(5);
    assert.equal(packs.length, 1);
    const entry = packs.find((p) => p.source.name === '海边 日落');
    assert.ok(entry, '能列出刚生成的包');
    const marked = await service.mark(pack.packId, 'published');
    assert.equal(marked?.status, 'published');
  });

  await t.test('HTTP：状态、配置、文案预览、静态页', async () => {
    const handler = createRouter({ service, log: silentLog });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = /** @type {any} */ (server.address()).port;
    const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`;

    const state = await fetch(`${base}/api/state`).then((r) => r.json());
    assert.equal(state.enabled, true);
    assert.equal(state.config.source.dir, inbox);
    assert.equal(state.ledger.published, 1, '标为已发布后统计跟着变');

    const preview = await fetch(`${base}/api/caption-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        caption: { titleTemplate: '改一下 {name}', tags: ['测试'], visibility: 'private' },
        name: '样例',
      }),
    }).then((r) => r.json());
    assert.equal(preview.title, '改一下 样例', '预览用未保存的覆盖值');
    assert.equal(preview.visibility, '仅自己');

    const page = await fetch(`${base}/`).then((r) => r.text());
    assert.ok(page.includes('宠物权限'), '设置页能出来');

    const missing = await fetch(`${base}/api/nope`).then((r) => r.status);
    assert.equal(missing, 404);

    await new Promise((resolve) => server.close(resolve));
  });

  await service.stop();
});

test('配置：保存非法值会被纠正但整体仍可用', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pet-douyin-cfg-'));
  const service = createService({ home, log: silentLog, getPort: () => 0 });
  await service.init();
  const r = await service.saveConfig({
    schedule: { mode: 'daily', dailyTimes: ['25:00', '09:00'], weekdays: [0, 3] },
    source: { dir: '~/videos' },
  });
  assert.equal(r.ok, true);
  const cfg = service.getConfig();
  assert.deepEqual(cfg.schedule.dailyTimes, ['09:00'], '非法时刻被丢掉');
  assert.deepEqual(cfg.schedule.weekdays, [3], '0 不是合法星期');
  assert.ok(cfg.source.dir.endsWith('videos'), '~ 被展开');
  await service.stop();
});
