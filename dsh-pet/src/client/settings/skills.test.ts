/**
 * 技能注册表（src/client/settings/skills.ts）的契约测试。
 *
 * 两条契约：
 *   1. 技能标签 id 与宠物条目名不能相撞——否则点「抖音」会去切一个叫抖音的角色包；
 *   2. 每个技能都能造出面板（缺面板等于标签点了没反应）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { isSkillTab, skillIdOf, skillTabId, SKILLS } from './skills.ts';
import { zh } from './locales.ts';

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
const rt = { h, useState: () => [], useEffect: () => {}, t: (key: string) => key } as never;

describe('skills —— 技能注册表', () => {
  test('至少有一个技能，且 id 唯一', () => {
    assert.ok(SKILLS.length > 0, '注册表空了：标签行会只剩宠物种类');
    const ids = SKILLS.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('每个技能的标签 id 带前缀，能原样解回技能 id', () => {
    for (const item of SKILLS) {
      const tabId = skillTabId(item.id);
      assert.equal(isSkillTab(tabId), true);
      assert.equal(skillIdOf(tabId), item.id);
      // 宠物条目名（main / 角色包前缀）不会被误判成技能
      assert.equal(isSkillTab(item.id), false);
      assert.equal(skillIdOf(item.id), '');
    }
  });

  test('每个技能都有面板可造，且文案键在字典里', () => {
    for (const item of SKILLS) {
      assert.equal(typeof item.makePanel(rt), 'function');
      assert.equal(typeof (zh as Record<string, unknown>)[item.labelKey], 'string');
    }
  });
});
