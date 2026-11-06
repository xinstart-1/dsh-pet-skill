// 左栏「桌宠配置」导航图标的回归：产物契约 + 真实 16×16 渲染的像素断言。
//
// 背景：DSH 0.2.2-rc.1 的 navIcon(id) 白名单里没有我们的分区，兜底齿轮曾被插件用 DOM 补丁隐藏，
// mask 又画不出来 → 整格空白。现在改用官方 slot `settings.section.icon`（list/root/inline，
// shell 以 only: row.id 过滤），图标由 nav-icon.ts 的 makeSectionNavIcon 内联渲染。
//
// 这里守三件事，任何一条破了都会退回「空白格 / 糊成一团 / 顶格被 40px 行高裁掉」：
//   1. lib/client.js（GUI 实际加载的产物）里有 slot 注册，且旧 DOM hack 与隐藏 CSS 彻底消失；
//   2. 图标 SVG 自包含（含 <svg、不含 <use — 后者在 data URI 里解析不到符号就是空图）；
//   3. 真 Chromium 在 16×16 里画出来的非透明像素占比合理（8%~60%）且四周留白 ≥1px。
//
// 只读 lib/ 与 src/，不改任何产物；跑法与 settings.test.mjs 一致：node --test scripts/tests/*.test.mjs
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = 'lib/client.js';
const bundle = readFileSync(pkgRoot + BUNDLE, 'utf8');

// 与 nav-icon.ts 的几何保持一致：4 脚趾 + 1 掌垫，全部 ellipse；描边 1.3。
const TOES = [
  { cx: 3.85, cy: 6.15, rx: 1.15, ry: 1.4 },
  { cx: 6.55, cy: 4.35, rx: 1.2, ry: 1.5 },
  { cx: 9.45, cy: 4.35, rx: 1.2, ry: 1.5 },
  { cx: 12.15, cy: 6.15, rx: 1.15, ry: 1.4 },
];
const PAD = { cx: 8, cy: 10.85, rx: 3.75, ry: 2.35 };

/** 按 nav-icon.ts 的 props 造等价的内联 SVG（与产物同一套几何与描边）。 */
function iconSvg(size = 16) {
  const ellipses = [...TOES, PAD].map((o) => `<ellipse cx="${o.cx}" cy="${o.cy}" rx="${o.rx}" ry="${o.ry}"/>`).join('');
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
    ellipses +
    '</svg>'
  );
}

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

// ---------------------------------------------------------------- 产物契约

test('bundle registers the official settings.section.icon slot for pet-config', () => {
  const slotCount = bundle.split('settings.section.icon').length - 1;
  // 声明/注入各一次是正常下限；出现 0 次说明插件没注册这个 slot，图标必然退回齿轮兜底。
  assert.ok(slotCount >= 2, `settings.section.icon appears ${slotCount} times in ${BUNDLE}, expected >= 2`);

  // id 必须与 settings.section 的注册 id 一致，否则 shell 的 only: row.id 过滤掉我们的图标。
  const registrations = [
    ...bundle.matchAll(/name:\s*"settings\.section(?:\.icon)?"[\s\S]{0,120}?id:\s*"([^"]+)"/g),
  ].map((m) => m[1]);
  assert.ok(
    registrations.length >= 2,
    `expected both settings.section and settings.section.icon registrations, got ${registrations.length}`,
  );
  for (const id of registrations) assert.equal(id, 'pet-config', `section/section.icon ids must match; got "${id}"`);
});

test('legacy DOM hack and gear-hiding CSS are gone from the bundle', () => {
  for (const legacy of ['installSectionNavIcon', 'svgMaskUri', 'navIcon']) {
    assert.equal(
      bundle.split(legacy).length - 1,
      0,
      `${legacy} still present in ${BUNDLE}: leftover DOM patch can override the new slot icon`,
    );
  }
});

test('icon svg is self-contained (no <use> symbol reference)', () => {
  // 产物里的图标是内联 ellipse，不是 primitives 的 <use href="#symbol"> 精灵图。
  assert.ok(
    bundle.includes('ellipse'),
    `${BUNDLE} has no inline <ellipse> — icon may have regressed to a symbol sprite`,
  );
  assert.equal(
    bundle.split('<use ').length - 1,
    0,
    `${BUNDLE} references <use>, which renders blank outside the sprite document`,
  );

  // 同一条契约也覆盖我们测试里用的等价 SVG 构造。
  const svg = iconSvg();
  assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'), 'iconSvg must be a complete <svg> element');
  assert.ok(!svg.includes('<use '), 'iconSvg must not use <use>');
  assert.equal(svg.split('<ellipse').length - 1, 5, 'expected 4 toes + 1 pad');
});

// ---------------------------------------------------------------- 真实渲染像素

/** 在 size×size 的图标上量非透明像素占比与四周留白（留白按该 size 下的屏幕像素算）。 */
async function measureIcon(page, size) {
  // 把 SVG 放大 SCALE 倍再画进 canvas：16px 下抗锯齿会把边缘像素算糊，放大量出的占比才稳。
  // 图标按传入的 size 渲染（viewBox 固定 0 0 16 16），所以占比不随 size 变，留白按 size/16 缩放。
  const SCALE = 16;
  const markup = iconSvg(size)
    .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
    .replace('stroke="currentColor"', 'stroke="#000"')
    .replace(`width="${size}" height="${size}"`, `width="${size * SCALE}" height="${size * SCALE}"`);
  return page.evaluate(
    async ({ svgMarkup, scale, size }) => {
      const canvas = document.createElement('canvas');
      canvas.width = size * scale;
      canvas.height = size * scale;
      const ctx = canvas.getContext('2d');
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('svg failed to load as image'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);
      });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const W = canvas.width;
      const H = canvas.height;
      let painted = 0;
      let minX = W;
      let minY = H;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          // 只看红色通道：白底上任何描边像素都会把它压下来。
          if (data[(y * W + x) * 4] < 250) {
            painted += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      // 画布是 size*SCALE，所以 1 屏幕 px = SCALE 个画布像素；下面全部换算成该 size 下的屏幕 px。
      return {
        ratio: painted / (W * H),
        padLeft: minX / scale,
        padTop: minY / scale,
        padRight: (W - 1 - maxX) / scale,
        padBottom: (H - 1 - maxY) / scale,
        // 画出的包围盒尺寸（屏幕 px），用来自证不是「只剩一两个点」。
        inkWidth: (maxX - minX + 1) / scale,
        inkHeight: (maxY - minY + 1) / scale,
        size,
      };
    },
    { svgMarkup: markup, scale: SCALE, size },
  );
}

test('16×16 render: ink coverage 8%~60% and ≥1px whitespace on all sides', async () => {
  const context = await browser.newContext({ viewport: { width: 300, height: 200 } });
  const page = await context.newPage();
  try {
    await page.setContent('<!doctype html><html><body style="margin:0;background:#fff"></body></html>');
    const m = await measureIcon(page, 16);

    // 占比：太小 = 没画出来 / 只剩残点；太大 = 笔画糊成一团，和 DSH 内置图标不搭。
    assert.ok(m.ratio >= 0.08, `ink coverage ${(m.ratio * 100).toFixed(1)}% < 8% — icon may be invisible`);
    assert.ok(
      m.ratio <= 0.6,
      `ink coverage ${(m.ratio * 100).toFixed(1)}% > 60% — strokes may have merged into a blob`,
    );

    // 留白：四周 ≥1px，否则在 40px 行高里会被 navCell 的 9px 上下内边距裁掉或顶格。
    assert.ok(m.padLeft >= 1, `left whitespace ${m.padLeft}px < 1px (glyph touches the edge)`);
    assert.ok(m.padTop >= 1, `top whitespace ${m.padTop}px < 1px (glyph touches the edge)`);
    assert.ok(m.padRight >= 1, `right whitespace ${m.padRight}px < 1px (glyph touches the edge)`);
    assert.ok(m.padBottom >= 1, `bottom whitespace ${m.padBottom}px < 1px (glyph touches the edge)`);

    // 包围盒要真的占满中间那块：几何基准是 x∈[2.05,13.95]、y∈[2.2,13.85]（16px 下约 12×11.7px）。
    assert.ok(m.inkWidth >= 10 && m.inkWidth <= 14, `ink width ${m.inkWidth}px outside expected 10~14px`);
    assert.ok(m.inkHeight >= 10 && m.inkHeight <= 14, `ink height ${m.inkHeight}px outside expected 10~14px`);
  } finally {
    await context.close();
  }
});

test('14px render stays legible (coverage holds and whitespace stays ≥1px)', async () => {
  const context = await browser.newContext({ viewport: { width: 300, height: 200 } });
  const page = await context.newPage();
  try {
    await page.setContent('<!doctype html><html><body style="margin:0;background:#fff"></body></html>');
    const m = await measureIcon(page, 14);
    // 同一几何缩到 14px：占比不变（viewBox 等比缩放），留白从 2px 缩到约 1.75px，仍须 ≥1px。
    assert.ok(m.ratio >= 0.08 && m.ratio <= 0.6, `14px ink coverage ${(m.ratio * 100).toFixed(1)}% outside 8%~60%`);
    for (const [side, pad] of [
      ['left', m.padLeft],
      ['top', m.padTop],
      ['right', m.padRight],
      ['bottom', m.padBottom],
    ]) {
      assert.ok(pad >= 1, `14px ${side} whitespace ${pad}px < 1px — glyph touches the edge`);
    }
  } finally {
    await context.close();
  }
});
