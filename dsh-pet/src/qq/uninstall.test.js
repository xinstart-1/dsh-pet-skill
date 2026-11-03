/**
 * 卸载清理：只删明确列出的用户数据目录，绝不碰 DSH_HOME 本身或其他插件。
 *
 * 这组测试盯的是「删错了地方」会比「没删干净」更糟——所以在临时 HOME 下造几个目录，
 * 断言 wipeAll 只动了 dsh-pet-qq / dsh-pet /（可选）electron，连 HOME 里无关的文件都原封不动。
 *
 * 注意：通过 `home` 选项注入临时目录，而不是改 `process.env.DSH_HOME`——
 * 后者是全局状态，Node 测试并行执行时多个用例会互相污染、误删彼此的目录。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectTargets, wipeAll, wipeDir } from './uninstall.js';

/** 每个测试一个唯一 HOME，彻底避免并行/残留导致的目录互相干扰。 */
function freshHome(label) {
  return mkdtempSync(join(tmpdir(), `uninstall-${label}-`));
}

test('collectTargets：默认不含 electron，包含 qq 与 pet', () => {
  const home = freshHome('targets-1');
  const { targets } = collectTargets({ home });
  const keys = targets.map((t) => t.key);
  assert.ok(keys.includes('qq'));
  assert.ok(keys.includes('pet'));
  assert.ok(!keys.includes('electron'), 'electron 默认保留，需显式开启');
});

test('collectTargets：includeElectron 时含 electron', () => {
  const home = freshHome('targets-2');
  const { targets } = collectTargets({ home, includeElectron: true });
  assert.ok(targets.some((t) => t.key === 'electron'));
});

test('wipeAll：只删列出的目录，HOME 本身与无关文件原封不动', async () => {
  const home = freshHome('run-1');
  mkdirSync(join(home, 'dsh-pet-qq', 'napcat'), { recursive: true });
  mkdirSync(join(home, 'dsh-pet', 'pet'), { recursive: true });
  mkdirSync(join(home, 'electron', 'x'), { recursive: true });
  mkdirSync(join(home, 'other-plugin'), { recursive: true });
  writeFileSync(join(home, 'dsh-pet-qq', 'config.json'), '{}');
  writeFileSync(join(home, 'keep-me.txt'), '别删我');
  writeFileSync(join(home, 'other-plugin', 'data'), '其他插件也不能碰');
  const r = await wipeAll({ home, includeElectron: false });
  assert.equal(r.ok, true, `应清理成功：${JSON.stringify(r.failed)}`);
  assert.equal(existsSync(join(home, 'dsh-pet-qq')), false, 'dsh-pet-qq 应被删');
  assert.equal(existsSync(join(home, 'dsh-pet')), false, 'dsh-pet 应被删');
  assert.equal(existsSync(join(home, 'electron')), true, 'electron 默认应保留');
  assert.equal(existsSync(join(home, 'keep-me.txt')), true, 'HOME 下无关文件不能碰');
  assert.equal(existsSync(join(home, 'other-plugin')), true, '其他插件目录不能碰');
});

test('wipeAll：includeElectron 时连 electron 一起删', async () => {
  const home = freshHome('run-2');
  mkdirSync(join(home, 'dsh-pet-qq'), { recursive: true });
  mkdirSync(join(home, 'electron', 'x'), { recursive: true });
  const r = await wipeAll({ home, includeElectron: true });
  assert.equal(r.ok, true);
  assert.ok(r.removed.includes('electron'), 'electron 应在已删清单里');
  assert.equal(existsSync(join(home, 'electron')), false);
});

test('wipeDir：目录不存在返回 removed:"absent"，且不算失败', async () => {
  const home = freshHome('none-1');
  const r = await wipeDir(join(home, 'nope', 'gone'));
  assert.equal(r.removed, 'absent');
});
