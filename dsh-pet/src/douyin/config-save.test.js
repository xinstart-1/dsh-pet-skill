/**
 * 配置落盘的合并语义。
 *
 * 这里钉住的是一个真实踩过的坑：`normalizeConfig` 从 DEFAULT_CONFIG 起底、只覆盖
 * patch 里出现的字段，所以早期 `saveConfig` 拿到部分补丁时会把**其余设置全部打回默认**。
 * 设置页每次发全量所以看不出来，但只要用 HTTP 改一个 scope，用户辛苦调的文案、目录、
 * 排期就全没了——而且不会报错，属于最难查的那种丢数据。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, pathsFor, saveConfig } from './config.js';

test('部分保存只改指定字段，其余保持磁盘上的现状', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dy-config-'));
  const paths = pathsFor(dir);

  await saveConfig(paths, {
    source: { dir: 'X:/我的素材', minSizeMB: 3 },
    caption: { titleTemplate: '我的标题模板', tags: ['#甲', '#乙'] },
    schedule: { mode: 'daily', dailyTimes: ['09:30'] },
  });

  // 只改 scope —— 这就是「填凭据」那一步会发的补丁
  await saveConfig(paths, { app: { scopes: ['user_info'] } });

  const { config } = await loadConfig(paths);
  assert.equal(config.source.dir, 'X:/我的素材', '素材目录不该被打回默认');
  assert.equal(config.source.minSizeMB, 3);
  assert.equal(config.caption.titleTemplate, '我的标题模板');
  assert.deepEqual(config.caption.tags, ['#甲', '#乙']);
  assert.deepEqual(config.schedule.dailyTimes, ['09:30']);
  assert.deepEqual(config.app.scopes, ['user_info'], '这才是本次要改的');
});

test('数组整体替换，不做逐项合并（否则删词条永远删不掉）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dy-config-'));
  const paths = pathsFor(dir);

  await saveConfig(paths, { caption: { tags: ['#甲', '#乙', '#丙'] } });
  await saveConfig(paths, { caption: { tags: ['#甲'] } });

  const { config } = await loadConfig(paths);
  assert.deepEqual(config.caption.tags, ['#甲']);
});

test('清空字段是有效操作：空串要能把旧值盖掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dy-config-'));
  const paths = pathsFor(dir);

  await saveConfig(paths, { app: { clientKey: 'aw-old' }, caption: { titleTemplate: '旧模板' } });
  await saveConfig(paths, { app: { clientKey: '' }, caption: { titleTemplate: '' } });

  const { config } = await loadConfig(paths);
  assert.equal(config.app.clientKey, '');
  assert.equal(config.caption.titleTemplate, '');
});

test('熟人名单：存得住、改别的字段不带走它、能整体清空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dy-config-'));
  const paths = pathsFor(dir);

  await saveConfig(paths, { web: { knownPeers: ['阿星 | 主人', '小李 | 主人的朋友 | 常来聊游戏'] } });
  const first = await loadConfig(paths);
  assert.equal(first.config.web.knownPeers.length, 2);
  assert.equal(first.config.web.knownPeers[0], '阿星 | 主人', '分隔符与空格原样保留，怎么解析是 peers.js 的事');

  // 「改别的字段」是最常见的补丁形态：不能因为它没带 knownPeers 就把名单清掉
  await saveConfig(paths, { web: { autoReplyPollSec: 60 } });
  const second = await loadConfig(paths);
  assert.equal(second.config.web.knownPeers.length, 2, '改轮询间隔不该把名单打回空');

  // 空名单是有效状态：等于「不注入身份声明」，而不是「配置坏了」
  await saveConfig(paths, { web: { knownPeers: [] } });
  const third = await loadConfig(paths);
  assert.deepEqual(third.config.web.knownPeers, []);
});
