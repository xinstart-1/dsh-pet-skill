/**
 * 技能注册表：桌宠设置页那条标签行里，除宠物种类之外的另一半条目。
 *
 * 为什么要有这张表：插件合并成 dsh-pet-skill 之后，「宠物」和「技能」共用同一个设置分区
 * （左侧只有「桌宠配置」一个入口），点标签切换。但技能不是宠物条目——它没有实例、不写
 * main-config.jsonc、也不该被种类那套「条目不在了就退回 main」的逻辑管。所以这里把技能
 * 单独登记成一张表，设置页只做「查表渲染」：加新技能就在这里多一条，标签行与外壳都不用改。
 *
 * 标签 id 带 `skill:` 前缀：宠物种类 id 是条目名（main / 角色包前缀），前缀隔开后即使有个
 * 角色包恰好叫「抖音」也不会和它撞车。
 *
 * @module dsh-pet/src/client/settings/skills
 */
import type { FunctionComponent } from 'react';
import { makeDouyinSection } from './douyin-card.ts';
import { makeQqSection } from './qq-card.ts';
import type { Key } from './locales.ts';
import type { SettingsRuntime } from './runtime.ts';

/** 技能清单的一项。 */
export interface Skill {
  /** 技能 id（注册表内唯一）。 */
  readonly id: string;
  /** 标签文案：字典键，由渲染方翻译。 */
  readonly labelKey: Key;
  /** 造技能面板组件（在设置页工厂里造一次，保证组件类型跨渲染稳定）。 */
  readonly makePanel: (rt: SettingsRuntime) => FunctionComponent;
}

/** 技能标签 id 的前缀。 */
const TAB_PREFIX = 'skill:';

/**
 * 已登记的技能（顺序即标签行里的顺序）。
 *
 * 两个技能都是"整页内嵌自己的设置页"（同源 iframe，见各自 card），
 * 配置归它们自己管，宠物这边不认识它们的任何字段。
 * QQ 排在抖音后面：先来的在前，加技能只改这张表。
 */
export const SKILLS: readonly Skill[] = [
  { id: 'douyin', labelKey: 'skillDouyin', makePanel: makeDouyinSection },
  { id: 'qq', labelKey: 'skillQq', makePanel: makeQqSection },
];

/**
 * 技能 id → 标签行 id。
 * @param id - 技能 id
 * @returns 标签行里用的 id
 */
export const skillTabId = (id: string): string => TAB_PREFIX + id;

/**
 * 标签行 id 是不是技能。
 * @param tabId - 标签行 id
 * @returns 是技能标签返回 true
 */
export const isSkillTab = (tabId: string): boolean => tabId.startsWith(TAB_PREFIX);

/**
 * 标签行 id → 技能 id（不是技能标签则返回空串）。
 * @param tabId - 标签行 id
 * @returns 技能 id
 */
export const skillIdOf = (tabId: string): string =>
  tabId.startsWith(TAB_PREFIX) ? tabId.slice(TAB_PREFIX.length) : '';
