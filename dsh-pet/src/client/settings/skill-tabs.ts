/**
 * 技能标签条：横向列出全部条目（内置宠物 / 各 pet pack / 各技能），点一下切换当前条目。
 *
 * 只负责「切到哪一项」；实例的增删与字段编辑由宠物标签条和设置页外壳处理，
 * 技能面板由外壳按当前条目渲染（见 skills.ts）。
 *
 * 条目比旧的「种类」条多了一类：技能没有实例数，所以 `count` 可省——有值才括注。
 * @module dsh-pet/src/client/settings/skill-tabs
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from './runtime.ts';

/** 标签条的一项。 */
export interface SkillTabItem {
  /** 项 id：宠物条目名（main / 角色包前缀），或 `skill:<技能 id>`。 */
  readonly id: string;
  /** 显示文案（调用方已翻译好）。 */
  readonly label: string;
  /** 括注的实例数；技能没有实例，省略。 */
  readonly count?: number;
}

/** 技能标签条的输入。 */
export interface SkillTabsProps {
  /** 全部条目（顺序即成品里的条目顺序）。 */
  tabs: readonly SkillTabItem[];
  /** 当前条目的 id。 */
  active: string;
  /** 保存中或配置未就绪时禁用切换。 */
  busy: boolean;
  /** 切到另一个条目。 */
  onSelect: (id: string) => void;
}

/**
 * 造技能标签条。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 技能标签条组件。
 */
export function makeSkillTabs(rt: Pick<SettingsRuntime, 'h' | 't'>): FunctionComponent<SkillTabsProps> {
  const { h, t } = rt;

  return function SkillTabs(props: SkillTabsProps) {
    return h('div', {
      className: 'dsh-pet-cfg__kinds',
      children: [
        h('span', { key: 'label', className: 'dsh-pet-cfg__tabsLabel', children: t('kindLabel') }),
        ...props.tabs.map((item) =>
          h('button', {
            key: item.id,
            type: 'button',
            disabled: props.busy,
            onClick: () => props.onSelect(item.id),
            className: 'dsh-pet-cfg__tab' + (item.id === props.active ? ' is-active' : ''),
            // 主条目固定显示「内置」；文件宠物显示目录前缀（与素材根一致）；技能显示技能名，不带实例数。
            children: item.label + (item.count === undefined ? '' : ' (' + item.count + ')'),
          }),
        ),
      ],
    });
  };
}
