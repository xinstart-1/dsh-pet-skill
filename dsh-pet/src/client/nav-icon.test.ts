/**
 * 「桌宠配置」导航字形（src/client/nav-icon.ts）的契约测试。
 *
 * 三条契约：
 *   1. 几何落在 16×16 视口内、留出边距，否则会被 navCell 的 40px 行高裁掉或顶格；
 *   2. 笔画可见：fill:none + stroke:currentColor（继承行文字色，亮/暗主题都不用二次适配），
 *      且 `strokeWidth` 与 DSH 内置图标同为 1.3（细了在 16px 下发灰，粗了糊成一团）；
 *   3. size 由 owner 传入：非法值退回 16，不让外部把图标拉成 0 宽而静默消失。
 *
 * 用假的 `h` 记录节点树（不引 jsdom），与 pet-card.test.ts 同一套写法。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { makeSectionNavIcon } from './nav-icon.ts';

interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
const SectionNavIcon = makeSectionNavIcon({ h });

/** 摊平整棵树。 */
function flatten(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  const element = node as Node;
  return [element, ...flatten(element.props?.children)];
}

const render = (size = 16, active = false): Node => SectionNavIcon({ size, active }) as unknown as Node;

/** 视口内所有坐标点：全部图形都是椭圆，外框 = cx±rx / cy±ry，再并上 1.3 描边的一半。 */
function extent(nodes: Node[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  const half = 1.3 / 2; // 描边沿轮廓两侧各扩线宽的一半，算留白必须带上
  for (const node of nodes) {
    if (node.tag !== 'ellipse') continue;
    const { cx, cy, rx, ry } = node.props as Record<string, number>;
    grow(cx - rx - half, cy - ry - half);
    grow(cx + rx + half, cy + ry + half);
  }
  return { minX, minY, maxX, maxY };
}

describe('makeSectionNavIcon —— 设置左栏的爪印字形', () => {
  test('根节点是 16×16 的 svg，尺寸取 owner 传入的 size', () => {
    const svg = render(16);
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.props.viewBox, '0 0 16 16');
    assert.equal(svg.props.width, 16);
    assert.equal(svg.props.height, 16);
    assert.equal(render(20).props.width, 20, 'size 是 owner 契约的一部分，不能被写死');
  });

  test('非法 size 退回 16（0/NaN 会让图标静默消失）', () => {
    assert.equal(render(0).props.width, 16);
    assert.equal(render(Number.NaN).props.width, 16);
  });

  test('描边取 currentColor、线宽 1.3，与 DSH 内置图标一致', () => {
    const svg = render();
    assert.equal(svg.props.fill, 'none', '实心填充会和内置的描边图标风格打架');
    assert.equal(svg.props.stroke, 'currentColor', '写死颜色会跟丢选中/暗色主题');
    assert.equal(svg.props.strokeWidth, 1.3);
  });

  test('图形不越出 16×16 视口，且四周至少留 1px（顶格会被 40px 行裁切）', () => {
    const { minX, minY, maxX, maxY } = extent(flatten(render()));
    assert.ok(minX >= 1, `左边界 ${minX} 顶格`);
    assert.ok(minY >= 1, `上边界 ${minY} 顶格`);
    assert.ok(maxX <= 15, `右边界 ${maxX} 顶格`);
    assert.ok(maxY <= 15, `下边界 ${maxY} 顶格`);
  });

  test('四个脚趾 + 一块掌垫：少一个就不像爪印了', () => {
    const nodes = flatten(render());
    assert.equal(nodes.filter((node) => node.tag === 'ellipse').length, 5, '4 个脚趾 + 1 块掌垫');
  });

  test('子节点带 key，且图标对读屏隐藏（标签已由行文字提供）', () => {
    const children = render().props.children as Node[];
    assert.ok(children.length > 0);
    for (const child of children) assert.ok(child.props.key !== undefined, '缺 key 会在控制台刷警告');
    assert.equal(render().props['aria-hidden'], 'true');
    assert.equal(render().props.focusable, 'false');
  });

  test('选中态不另换图形：active 只影响宿主行样式', () => {
    assert.deepEqual(flatten(render(16, true)), flatten(render(16, false)));
  });
});
