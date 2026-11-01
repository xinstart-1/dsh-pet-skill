/**
 * 技能标签条（src/client/settings/skill-tabs.ts）的契约测试。
 *
 * 三条契约：
 *   1. 宠物种类带实例数、技能不带（技能没有实例，括个「(0)」会让人以为没装）；
 *   2. 条目标题沿用字典键，条本身不自己造文案；
 *   3. 点击回传的是项 id（技能带 `skill:` 前缀），由外壳决定切哪种状态。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { makeSkillTabs, type SkillTabItem } from './skill-tabs.ts';
import { skillTabId } from './skills.ts';

interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
const SkillTabs = makeSkillTabs({ h, t: (key: string) => '[' + key + ']' } as never);

const tabs: SkillTabItem[] = [
  { id: 'main', label: '内置', count: 1 },
  { id: 'mypack', label: 'mypack', count: 3 },
  { id: skillTabId('douyin'), label: '抖音' },
];

/** 把假 react 树拍平（与 global-card.test.ts 同款夹具）。 */
function flatten(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  const element = node as Node;
  return [element, ...flatten(element.props?.children)];
}

/** 标签按钮：顺序即展示顺序。 */
const buttons = (tree: unknown): Node[] => flatten(tree).filter((node) => node.tag === 'button');

describe('SkillTabs —— 技能标签条', () => {
  test('标题走字典键，宠物种类带实例数、技能不带', () => {
    const tree = SkillTabs({ tabs, active: 'main', busy: false, onSelect: () => {} } as never);
    assert.deepEqual(
      buttons(tree).map((b) => b.props.children),
      ['内置 (1)', 'mypack (3)', '抖音'],
    );
    const label = flatten(tree).find((node) => node.props.className === 'dsh-pet-cfg__tabsLabel');
    assert.equal(label?.props.children, '[kindLabel]');
  });

  test('当前项打 is-active，点击回传项 id', () => {
    const seen: string[] = [];
    const tree = SkillTabs({
      tabs,
      active: skillTabId('douyin'),
      busy: false,
      onSelect: (id: string) => seen.push(id),
    } as never);
    const found = buttons(tree);
    assert.deepEqual(
      found.map((b) => String(b.props.className).includes('is-active')),
      [false, false, true],
    );
    const onClick = found[2].props.onClick as (() => void) | undefined;
    assert.equal(typeof onClick, 'function');
    onClick?.();
    assert.deepEqual(seen, [skillTabId('douyin')]);
  });

  test('busy 时全部禁用', () => {
    const tree = SkillTabs({ tabs, active: 'main', busy: true, onSelect: () => {} } as never);
    assert.deepEqual(
      buttons(tree).map((b) => b.props.disabled),
      [true, true, true],
    );
  });
});
