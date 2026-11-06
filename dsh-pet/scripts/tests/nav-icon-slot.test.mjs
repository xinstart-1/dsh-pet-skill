// 用 DSH 自己的 SlotCore 跑真实槽机制：证明「settings.section.icon + id=pet-config」这条注册路径成立。
//
// 为什么需要这一层：产物契约只证明「我们注册了」，证不了「注册会被接受、且只会点亮自己那一行」。
// 这里复刻外壳的声明（list/root/inline）与我们的注册，覆盖四件事：
//   1. 槽未声明时注册必须报错 → 所以插件走 slots.inject 等声明到位，而不是直接 register；
//   2. section 与 section.icon 用同一个 id，shell 的 only 过滤才认得出；
//   3. list 槽按 id 天然隔离，不会串到别人的行；同 id 重复注册被拒（id 就是主键）；
//   4. 释放后干净摘除，插件卸载不留残影。
//
// 只 import 已安装的 @deepseek-ai/dsh-client-ui-slots，不碰产物。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';

/** 复刻 dsh-client-ui-settings-general 的 sidebar.settings 注册：子槽随父的 children 表一起声明。 */
function mountShell(core) {
  return core.register(
    {
      name: 'root',
      id: 'settings-shell',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        // inline: true 与真实外壳一致；它由声明方给出，注册侧不重复声明。
        'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
      },
    },
    () => null,
  );
}

/** 复刻插件的两条注册（app.ts 里的 settings.section 与 settings.section.icon）。 */
function mountPlugin(core) {
  const disposeSection = core.register({ name: 'settings.section', id: 'pet-config', order: 30 }, () => null);
  const disposeIcon = core.register({ name: 'settings.section.icon', id: 'pet-config', order: 30 }, () => null);
  return () => {
    disposeIcon();
    disposeSection();
  };
}

test('unmounted slot rejects registration — plugin must wait via slots.inject', () => {
  const bare = new SlotCore();
  assert.throws(
    () => bare.register({ name: 'settings.section.icon', id: 'pet-config' }, () => null),
    /is not declared/,
    'registering before the shell declares the slot must throw',
  );
});

test('shell declaration is list/root, matching the icon contract', () => {
  const core = new SlotCore();
  const unmount = mountShell(core);
  try {
    const spec = core.spec('settings.section.icon');
    assert.equal(spec.kind, 'list', 'icon slot must be a list (one entry per section id)');
    assert.equal(spec.scope, 'root', 'icon slot is rendered by the settings shell, not a session');
  } finally {
    unmount();
  }
});

test('section and section.icon register under the same id so only: row.id matches', () => {
  const core = new SlotCore();
  const unmountShell = mountShell(core);
  const unmountPlugin = mountPlugin(core);
  try {
    // shell 用 `only: row.id` 过滤：两边的 id 必须逐字相同，否则图标永远不渲染。
    assert.deepEqual(
      core.entries('settings.section').map((e) => e.options.id),
      ['pet-config'],
    );
    assert.deepEqual(
      core.entries('settings.section.icon').map((e) => e.options.id),
      ['pet-config'],
    );
  } finally {
    unmountPlugin();
    unmountShell();
  }
});

test('icon entries are isolated by id and duplicate ids are rejected', () => {
  const core = new SlotCore();
  const unmountShell = mountShell(core);
  const unmountPlugin = mountPlugin(core);
  const disposeOther = core.register({ name: 'settings.section.icon', id: 'other-section' }, () => null);
  try {
    // 别的分区注册图标，不会顶掉我们的那条（list 槽按 id 各自独立）。
    assert.equal(core.entries('settings.section.icon').length, 2);
    assert.ok(
      core.entries('settings.section.icon').some((e) => e.options.id === 'pet-config'),
      'pet-config icon entry must survive a foreign registration',
    );

    // id 是 list 槽的主键：同 id 同 priority 再注册必须被拒，避免静默覆盖。
    assert.throws(
      () => core.register({ name: 'settings.section.icon', id: 'pet-config' }, () => null),
      /already has an entry with id "pet-config"/,
    );
  } finally {
    disposeOther();
    unmountPlugin();
    unmountShell();
  }
});

test('plugin unmount removes every registration it added', () => {
  const core = new SlotCore();
  const unmountShell = mountShell(core);
  const unmountPlugin = mountPlugin(core);
  unmountPlugin();
  try {
    assert.equal(core.entries('settings.section.icon').length, 0, 'icon entry must be disposed');
    assert.equal(core.entries('settings.section').length, 0, 'section entry must be disposed');
  } finally {
    unmountShell();
  }
});
