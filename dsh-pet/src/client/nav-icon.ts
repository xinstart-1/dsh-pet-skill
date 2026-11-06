/**
 * 「桌宠配置」分区的导航字形：一只爪印，与 DSH 内置图标同一几何语言
 * （16×16 viewBox、1.3 描边、currentColor 取行文字色，选中态不另换形）。
 * 走 DSH 官方的 `settings.section.icon` 插槽；注册在 `app.ts`，id 必须与设置分区 id 一致，否则不渲染。
 * 不用 primitives 的内置图标：那批是 `<use href="#symbol">` 引用精灵图，只能跟着宿主已有字形走，
 * 也跟宠物主题对不上；这里自带路径，viewport 与线宽都是自己定的。
 * @module dsh-pet/src/client/nav-icon
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from './settings/runtime.ts';

/** 导航行交给图标的呈现参数（与 `SettingsSectionIconOwnerProps` 对齐）。 */
export interface SectionIconProps {
  /** 请求的方形边长（px）；shell 目前恒传 16。 */
  size: number;
  /** 该分区是否为当前选中行；图形不区分选中态，保留字段以免 owner 契约漂移。 */
  active: boolean;
}

/** 一笔椭圆：脚趾用四个，掌垫一个；全部用椭圆是为了边界可精确核算（见测试里的留白断言）。 */
interface Oval {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** 四个脚趾，沿上缘呈弧形排开（中间两个略高，像踏在地上）。 */
const TOES: readonly Oval[] = [
  { cx: 3.85, cy: 6.15, rx: 1.15, ry: 1.4 },
  { cx: 6.55, cy: 4.35, rx: 1.2, ry: 1.5 },
  { cx: 9.45, cy: 4.35, rx: 1.2, ry: 1.5 },
  { cx: 12.15, cy: 6.15, rx: 1.15, ry: 1.4 },
];

/** 掌垫：比脚趾更宽更扁，重心压在下半格。 */
const PAD: Oval = { cx: 8, cy: 10.85, rx: 3.75, ry: 2.35 };

/**
 * 造导航字形组件。
 *
 * @param rt - 注入的 react 能力；只用到 `h`。
 * @returns 图标组件，直接作为 `settings.section.icon` 的注册体。
 */
export function makeSectionNavIcon(rt: Pick<SettingsRuntime, 'h'>): FunctionComponent<SectionIconProps> {
  const { h } = rt;
  return function SectionNavIcon(props: SectionIconProps) {
    // 0 与负数同样会让图标消失（宽度为 0 时 svg 不占位），一并退回 16。
    const size = Number.isFinite(props.size) && props.size > 0 ? props.size : 16;
    return h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      // 子节点走 props.children：注入的 `h` 是单子节点的 jsx，多子节点必须用这个形状。
      children: [...TOES, PAD].map((oval, index) =>
        h('ellipse', { key: 'oval' + index, cx: oval.cx, cy: oval.cy, rx: oval.rx, ry: oval.ry }),
      ),
    });
  };
}
