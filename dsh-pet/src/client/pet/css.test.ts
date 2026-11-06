/**
 * 宠物页面样式注入（src/client/pet/css.ts）的契约测试。
 *
 * 重点守 alpha 修正滤镜（透明灰框修复）的三条契约，任何一条破了都会让页面出现可见缺陷：
 *   1. 视频引用了滤镜 id —— 不引用就回到「浅色底上一圈淡灰矩形」；
 *   2. 滤镜节点真的注入且只注入一份 —— 多实例挂载不重复堆节点；
 *   3. 滤镜节点脱离行内流 —— 默认 display:inline 会在 #root 之后生成匿名行盒，
 *      把宿主页面撑出约一行滚动条、顶部标签条被顶出视野。
 *
 * 用极简 document 替身（不引 jsdom），与 nav-icon.test.ts 同一套写法。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { injectPetCss } from './css.ts';

interface FakeNode {
  tag: string;
  /** 真实 DOM 里 `filter.id = …` 与 `setAttribute('id', …)` 同源，这里也合并。 */
  id: string;
  attrs: Map<string, string>;
  style: Record<string, string>;
  children: FakeNode[];
  textContent: string;
  /** 与 attrs 同一份存储：写 dataset.pluginCss 等价于写 data-plugin-css 属性。 */
  dataset: Record<string, string>;
  appendChild(child: FakeNode): FakeNode;
  setAttribute(name: string, value: string): void;
}

/** camelCase → kebab-case，供 dataset 与属性名互通。 */
const kebab = (name: string): string => name.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase());

function makeNode(tag: string): FakeNode {
  const attrs = new Map<string, string>();
  const node: FakeNode = {
    tag,
    get id() {
      return attrs.get('id') ?? '';
    },
    set id(value: string) {
      attrs.set('id', value);
    },
    attrs,
    style: {},
    children: [],
    textContent: '',
    // dataset 的写入落到同一份 attrs 上：`dataset.pluginCss = x` 等价于 `setAttribute('data-plugin-css', x)`。
    dataset: new Proxy({} as Record<string, string>, {
      get: (_target, key: string) => attrs.get('data-' + kebab(key)),
      set: (_target, key: string, value: string) => {
        attrs.set('data-' + kebab(key), value);
        return true;
      },
      has: (_target, key: string) => attrs.has('data-' + kebab(key)),
    }),
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      attrs.set(name, value);
    },
  };
  return node;
}

/** 极简 document：只够 css.ts 用到的那几个能力。 */
function makeDocument(): { doc: unknown; head: FakeNode; body: FakeNode; all: () => FakeNode[] } {
  const head = makeNode('head');
  const body = makeNode('body');
  const createElement = (tag: string): FakeNode => makeNode(tag);
  const createElementNS = (_ns: string, tag: string): FakeNode => makeNode(tag);
  const flatten = (node: FakeNode): FakeNode[] => [node, ...node.children.flatMap(flatten)];
  const all = (): FakeNode[] => [...flatten(head), ...flatten(body)];

  const doc = {
    head,
    body,
    createElement,
    createElementNS,
    // 只支持本模块用到的两种选择器形态；attrs 是唯一真相源（dataset 已映射进去）。
    querySelector(selector: string): FakeNode | null {
      const nodes = all();
      const attrMatch = /^([a-z]*)\[([a-zA-Z0-9-]+)="([^"]*)"\]$/.exec(selector);
      if (attrMatch !== null) {
        const [, tag, attr, value] = attrMatch;
        return nodes.find((node) => (tag === '' || node.tag === tag) && node.attrs.get(attr) === value) ?? null;
      }
      const barMatch = /^([a-z]*)\[([a-zA-Z0-9-]+)\]$/.exec(selector);
      if (barMatch !== null) {
        const [, tag, attr] = barMatch;
        return nodes.find((node) => (tag === '' || node.tag === tag) && node.attrs.has(attr)) ?? null;
      }
      return null;
    },
  };
  return { doc, head, body, all };
}

const withDocument = (): { doc: ReturnType<typeof makeDocument>; restore: () => void } => {
  const doc = makeDocument();
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = doc.doc;
  return {
    doc,
    restore: () => {
      (globalThis as { document?: unknown }).document = previous;
    },
  };
};

describe('injectPetCss —— 样式注入与 alpha 修正滤镜', () => {
  test('样式表里视频引用了 alpha 修正滤镜', () => {
    const env = withDocument();
    try {
      injectPetCss();
      const style = env.doc.head.children.find((node) => node.tag === 'style');
      assert.ok(style, '应注入一个 <style>');
      assert.ok(
        style.textContent.includes('filter:url(#dsh-pet-alpha-fix)'),
        '视频不带滤镜就会在浅色底上露出与包围盒等大的淡灰矩形',
      );
    } finally {
      env.restore();
    }
  });

  test('滤镜定义真的注入，且用 feFuncA 扣掉 1/255', () => {
    const env = withDocument();
    try {
      injectPetCss();
      const svg = env.doc.body.children.find((node) => node.attrs.has('data-dsh-pet-alpha-fix'));
      assert.ok(svg, '应注入滤镜定义用的 <svg>');
      const filter = svg.children[0]?.children[0];
      assert.equal(filter?.tag, 'filter');
      assert.equal(filter?.attrs.get('id'), 'dsh-pet-alpha-fix');
      const func = filter?.children[0]?.children[0];
      assert.equal(func?.tag, 'feFuncA');
      assert.equal(func?.attrs.get('slope'), '1');
      // 1/255 ≈ 0.0039215686：扣掉一档，背景归零、本体只降不可见的一档。
      assert.equal(func?.attrs.get('intercept'), '-0.0039215686');
    } finally {
      env.restore();
    }
  });

  test('滤镜节点绝对定位，不参与宿主行内流（否则会撑出一行滚动条）', () => {
    const env = withDocument();
    try {
      injectPetCss();
      const svg = env.doc.body.children.find((node) => node.attrs.has('data-dsh-pet-alpha-fix'));
      assert.equal(svg?.style.position, 'absolute');
    } finally {
      env.restore();
    }
  });

  test('重复注入只留一份样式与一份滤镜（多实例挂载不堆节点）', () => {
    const env = withDocument();
    try {
      injectPetCss();
      injectPetCss();
      injectPetCss();
      const styles = env.doc.head.children.filter((node) => node.tag === 'style');
      const filters = env.doc.body.children.filter((node) => node.attrs.has('data-dsh-pet-alpha-fix'));
      assert.equal(styles.length, 1, '样式只注入一份');
      assert.equal(filters.length, 1, '滤镜只注入一份');
    } finally {
      env.restore();
    }
  });

  test('没有 document 时静默返回（宿主环境缺 DOM 不抛错）', () => {
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      assert.doesNotThrow(() => injectPetCss());
    } finally {
      (globalThis as { document?: unknown }).document = previous;
    }
  });
});
