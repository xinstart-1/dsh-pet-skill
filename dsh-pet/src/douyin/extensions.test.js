/**
 * 扩展清单自注册：钉住"只动自己那条"这条边界。
 *
 * 清单是多个插件共用的文件，**弄丢别人的条目**是这里唯一不可挽回的错
 * （对方插件不会知道自己被删了，只会表现为"宠物突然不搭理它"）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { entriesOf, manifestPath, registerSelf, removeSelf, upsertSelf } from './extensions.js';
import { PLUGIN_ID } from './util.js';

/** 临时 DSH_HOME */
const tmpHome = () => mkdtemp(join(tmpdir(), 'dsh-ext-'));

test('两种清单形状都能取条目（裸数组 / {extensions}）', () => {
  assert.deepEqual(entriesOf([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(entriesOf({ extensions: [{ id: 'a' }] }), [{ id: 'a' }]);
  assert.deepEqual(entriesOf(null), []);
  assert.deepEqual(entriesOf('oops'), []);
});

test('upsert 保留别人的条目，并且同 id 只留最新一条', () => {
  const before = { extensions: [{ id: 'other', api: 'http://127.0.0.1:1/x' }, { id: PLUGIN_ID, api: 'http://127.0.0.1:9/old' }] };
  const after = upsertSelf(before, { id: PLUGIN_ID, api: 'http://127.0.0.1:9/new' });
  assert.equal(after.extensions.length, 2);
  const other = after.extensions.find((e) => e.id === 'other');
  assert.deepEqual(other, { id: 'other', api: 'http://127.0.0.1:1/x' }, '别人的条目必须原样保留');
  assert.equal(after.extensions.filter((e) => e.id === PLUGIN_ID).length, 1);
  assert.equal(after.extensions.find((e) => e.id === PLUGIN_ID).api, 'http://127.0.0.1:9/new');
});

test('upsert 不替别人清理坏数据（没有 id 的条目原样留着）', () => {
  const after = upsertSelf([{ api: 'x' }, null, { id: PLUGIN_ID }], { id: PLUGIN_ID, api: 'http://127.0.0.1:9/x' });
  assert.equal(after.extensions.filter((e) => e?.api === 'x').length, 1);
});

test('removeSelf 只摘自己', () => {
  const after = removeSelf({ extensions: [{ id: 'other' }, { id: PLUGIN_ID }] }, PLUGIN_ID);
  assert.deepEqual(after.extensions, [{ id: 'other' }]);
});

test('registerSelf 写盘后能读回自己的地址；端口不合法时不碰文件', async () => {
  const home = await tmpHome();
  const ok = await registerSelf({ home, port: 51234, prefix: '/dsh-douyin-7341' });
  assert.equal(ok.ok, true);
  assert.equal(ok.api, 'http://127.0.0.1:51234/dsh-douyin-7341');
  const saved = JSON.parse(await readFile(manifestPath(home), 'utf8'));
  assert.equal(saved.extensions[0].id, PLUGIN_ID);
  assert.equal(saved.extensions[0].api, 'http://127.0.0.1:51234/dsh-douyin-7341');

  // 二次注册（端口变了）应就地更新，不新增条目
  await registerSelf({ home, port: 52000, prefix: '/dsh-douyin-7341' });
  const again = JSON.parse(await readFile(manifestPath(home), 'utf8'));
  assert.equal(again.extensions.length, 1);
  assert.equal(again.extensions[0].api, 'http://127.0.0.1:52000/dsh-douyin-7341');

  // 端口还没就绪：返回失败且不改写已有内容
  const before = await readFile(manifestPath(home), 'utf8');
  const bad = await registerSelf({ home, port: 0, prefix: '/dsh-douyin-7341' });
  assert.equal(bad.ok, false);
  assert.equal(await readFile(manifestPath(home), 'utf8'), before);
});

test('清单文件损坏时仍能建立（覆盖成合法 JSON），不抛错', async () => {
  const home = await tmpHome();
  await writeFile(manifestPath(home), '{ 坏掉的', 'utf8');
  const r = await registerSelf({ home, port: 51235, prefix: '/dsh-douyin-7341' });
  assert.equal(r.ok, true);
  const saved = JSON.parse(await readFile(manifestPath(home), 'utf8'));
  assert.equal(saved.extensions.length, 1);
});
