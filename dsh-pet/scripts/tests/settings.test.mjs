// Real React + Chromium; API fixtures never touch the user's DSH configuration.
// First run: pnpm exec playwright install chromium
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

const pet = {
  id: 'pet-1',
  name: 'Blue',
  size: 240,
  display: 'web',
  position: { corner: 'top-right', marginX: 20, marginY: 20 },
};
const defaults = {
  main: {
    pets: [pet],
    notificationsEnabled: true,
    whisperImageEnabled: false,
    chatImageEnabled: false,
    confineToScreen: false,
    physics: {
      gravity: 2400,
      restitution: 0.6,
      groundFriction: 4,
      throwPower: 1,
      ceilingBounce: false,
      petCollision: false,
    },
    whisperModel: { provider: '', model: '' },
    chatModel: { provider: '', model: '' },
    chatMemoryRounds: 5,
    chatImageLimit: 10,
  },
};
const customized = {
  main: {
    ...defaults.main,
    notificationsEnabled: false,
    whisperImageEnabled: true,
    chatImageEnabled: true,
    confineToScreen: true,
    chatMemoryRounds: 19,
    chatImageLimit: 2,
    whisperModel: { provider: 'test', model: 'model' },
    chatModel: { provider: 'test', model: 'model' },
    physics: { ...defaults.main.physics, gravity: 1200, throwPower: 2, ceilingBounce: true, petCollision: true },
  },
};
let browser, server, url;
before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./settings.fixture.js', import.meta.url)),
    platform: 'browser',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
  const { output } = await bundle.generate({ format: 'iife' });
  await bundle.close();
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(output[0].code);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<html><head><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#202020;--dsw-alias-label-secondary:#444;--dsw-alias-label-tertiary:#666;--dsw-alias-border-l2:#bbb;--dsw-alias-state-business-primary:#245eea;--dsw-alias-button-info-fill:#245eea;--dsw-alias-state-error-primary:#c22}body{margin:16px;font-family:sans-serif}</style></head><body><div id="root"></div><script>window.initialConfig=${JSON.stringify(defaults)};</script><script src="/fixture.js"></script></body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function open(t, { get = customized, put, post, viewport = { width: 900, height: 900 }, lang = 'en' } = {}) {
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const writes = [],
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/dsh-pet-7340/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/dsh-pet-7340/config') {
      if (request.method() === 'PUT') {
        writes.push(request.postDataJSON());
        if (put) return put(route);
        return route.fulfill({ json: customized });
      }
      if (request.method() === 'POST') return post ? post(route) : route.fulfill({ json: defaults });
      if (typeof get === 'function') return get(route);
      return route.fulfill({ json: get });
    }
    if (pathname === '/dsh-pet-7340/config/meta') {
      return route.fulfill({
        json: {
          user: '/test/main-config.jsonc',
          default: '/test/assets/config.jsonc',
          animations: '/test/main-animation',
        },
      });
    }
    // RuntimeCard 读 info.electron.ready；兜底的模型清单形状（只有 providers）会让它抛 TypeError 白屏。
    // 这里给合法的 RuntimeSnapshot 桩，其余非 config 路由（/models、/runtime/electron）维持兜底。
    if (pathname === '/dsh-pet-7340/runtime') {
      return route.fulfill({
        json: {
          electron: {
            ready: true,
            path: '/test/electron',
            version: 'test',
            downloading: false,
            lastError: null,
            lastErrorAt: null,
          },
          logPath: '/test/dsh-pet.log',
          electronDir: '/test/electron-dir',
          inProcess: false,
        },
      });
    }
    return route.fulfill({
      json: { providers: [{ id: 'test', name: 'Test', models: [{ id: 'model', name: 'Model' }] }] },
    });
  });
  await page.goto(`${url}/?lang=${lang}`);
  await page.locator('.dsh-pet-cfg').waitFor();
  return { page, writes };
}

async function save(page) {
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save', exact: true }).first().click(),
  ]);
}

// 宿主 PUT /config 按白名单重建 pets，读取侧派生出来的 assetRoot/extra 不进用户配置；
// 断言提交体前先按同一口径去掉它们，否则比较的是「客户端多带的派生字段」而非落盘结果。
function persistedPets(pets) {
  return pets.map(({ assetRoot, extra, ...rest }) => rest);
}

test('config save errors: write failures keep edits visible and allow a retry', async (t) => {
  let attempts = 0;
  const { page, writes } = await open(t, {
    put: (route) =>
      ++attempts === 1
        ? route.fulfill({ status: 500, json: { error: 'failed to save config' } })
        : route.fulfill({ json: customized }),
  });
  const size = page.locator('input[type="number"]').first();
  await page.getByRole('button', { name: 'Save', exact: true }).first().waitFor({ state: 'visible' });
  await size.fill('320');
  await save(page);
  await page
    .getByText(
      'Failed to save config. Check the server connection, configuration directory write permissions and server log.',
      { exact: true },
    )
    .first()
    .waitFor();
  assert.equal(await page.getByText('Failed to load config', { exact: true }).count(), 0);
  assert.equal(await size.inputValue(), '320');
  await save(page);
  await page.getByText('Saved — the pets updated instantly.', { exact: true }).first().waitFor();
  assert.equal(writes[1].pets[0].size, 320);
});

test('config save errors: validation failures explain the rejected configuration', async (t) => {
  // 宿主契约：业务失败是 200 + {ok:false,reason:'bad-request'}，4xx 只留给协议错误；
  // 回 400 会被客户端归到传输失败，显示的是另一条文案。
  const { page } = await open(t, {
    put: (route) => route.fulfill({ json: { ok: false, reason: 'bad-request', message: 'invalid pet config' } }),
  });
  await save(page);
  await page
    .getByText('Failed to save config: invalid configuration. Check the values and try again.', { exact: true })
    .first()
    .waitFor();
});

test('config save errors: network failures display a save error and release the button', async (t) => {
  const { page } = await open(t, { put: (route) => route.abort('failed') });
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page
    .getByText(
      'Failed to save config. Check the server connection, configuration directory write permissions and server log.',
      { exact: true },
    )
    .first()
    .waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).first().isEnabled(), true);
});

test('config save errors: sync failures use the sync message', async (t) => {
  const { page } = await open(t, { post: (route) => route.fulfill({ status: 500, json: { error: 'write failed' } }) });
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Sync', exact: true }).last().click();
  await page
    .getByText('Failed to sync config. Check the server connection and configuration directory write permissions.', {
      exact: true,
    })
    .first()
    .waitFor();
});

test('pending config prevents editing and saving placeholder defaults', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { page, writes } = await open(t, {
    get: async (route) => {
      await pending;
      await route.fulfill({ json: customized });
    },
  });
  try {
    // 页面有两个同名 Save（宠物卡就近保存 + 底部操作区）：任一被禁用即说明表单整体不可写。
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).first().isDisabled(), true);
    assert.equal(await page.locator('input[type=text]').first().isDisabled(), true);
    assert.deepEqual(writes, []);
  } finally {
    release();
  }
});

for (const failure of ['http', 'network', 'malformed', 'null']) {
  test(`failed config (${failure}) is visible, blocks Save and can be retried`, async (t) => {
    let fail = true;
    const { page, writes } = await open(t, {
      get: (route) =>
        !fail
          ? route.fulfill({ json: customized })
          : failure === 'network'
            ? route.abort()
            : route.fulfill(
                failure === 'http' ? { status: 503, body: 'unavailable' } : { json: failure === 'null' ? null : {} },
              ),
    });
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).first().isDisabled(), true);
    assert.deepEqual(writes, []);
    fail = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await save(page);
    assert.equal(writes.length, 1);
    for (const [key, value] of Object.entries(customized.main)) {
      assert.deepEqual(key === 'pets' ? persistedPets(writes[0][key]) : writes[0][key], value, key);
    }
  });
}

test('Sync updates all controls so a subsequent Save preserves the restored defaults', async (t) => {
  const { page, writes } = await open(t);
  await save(page);
  assert.equal(writes[0].chatMemoryRounds, 19);
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Sync', exact: true }).last().click();
  await save(page);
  assert.equal(writes.length, 2);
  for (const [key, value] of Object.entries(defaults.main)) {
    // pets 走持久化口径（去掉读取侧派生的 assetRoot/extra），其余字段原样比较。
    assert.deepEqual(key === 'pets' ? persistedPets(writes[1][key]) : writes[1][key], value, key);
  }
});

test('fresh config refreshes the pet list instead of saving an old bridge snapshot', async (t) => {
  const fresh = { main: { ...customized.main, pets: [{ ...pet, name: 'Updated elsewhere', size: 360 }] } };
  const { page, writes } = await open(t, { get: fresh });
  await save(page);
  assert.deepEqual(persistedPets(writes[0].pets), fresh.main.pets);
});

// 人设框回归：曾经 min-height 只有 66px（≈3 行），长人设既不能通读也不显示滚动条；
// 现在默认 150px（8 行）起、随内容长高、到样式里的 max-height 封顶后改内部滚动。这里盯住三个不变量。
const LONG_PERSONA =
  Array.from(
    { length: 12 },
    (_, i) => `第${i + 1}段：${'要写得足够长才能撑开人设框，这句重复到够数为止。'.repeat(3)}`,
  ).join('\n') + '\n结尾一行';

/** 量一个 textarea 的关键几何、滚动样式与高度上限。 */
async function measureArea(area) {
  return area.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      valueLength: el.value.length,
      clientHeight: el.clientHeight,
      offsetHeight: el.offsetHeight,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowY: style.overflowY,
      // 上限从样式读，不写死像素：将来调 max-height 时断言不会假红；none/auto 解析成 null = 无上限。
      maxHeight: Number.isFinite(parseFloat(style.maxHeight)) ? parseFloat(style.maxHeight) : null,
    };
  });
}

test('persona textarea keeps a readable default height and never clips or overflows horizontally', async (t) => {
  const { page } = await open(t, { viewport: { width: 900, height: 900 }, lang: 'zh' });
  const area = page.locator('textarea.dsh-pet-cfg__area').first();
  await area.waitFor();

  // 1) 空值：默认高度必须是 150px 那一档，而不是旧的 66px（≈3 行）。
  //    border-box 下 clientHeight 比 min-height 少上下各 1px 边框，故用 offsetHeight 判下限、clientHeight 判余量。
  const empty = await measureArea(area);
  assert.ok(
    empty.offsetHeight >= 150,
    `empty offsetHeight ${empty.offsetHeight} < 150 (default height regressed to 66px?)`,
  );
  assert.ok(empty.clientHeight >= 145, `empty clientHeight ${empty.clientHeight} < 145 (border-box tolerance)`);

  // 2) 填长人设：必须长高；长到 max-height 封顶时改为内部滚动，绝不允许「框不变高、内容被裁掉」。
  await area.fill(LONG_PERSONA);
  assert.ok(LONG_PERSONA.length >= 300, `fixture persona only ${LONG_PERSONA.length} chars`);
  const filled = await measureArea(area);
  assert.equal(filled.valueLength, LONG_PERSONA.length);
  assert.ok(filled.clientHeight >= 150, `filled clientHeight ${filled.clientHeight} < 150`);
  // 「触顶」判据从 max-height 派生（留 6px 边框与取整余量），不再硬编码某个封顶值。
  const capped = filled.maxHeight !== null && filled.clientHeight >= filled.maxHeight - 6;
  if (capped) {
    // 触顶：必须能内部滚动（overflowY auto/scroll 且 scrollHeight ≥ clientHeight）。
    assert.ok(
      ['auto', 'scroll'].includes(filled.overflowY),
      `capped textarea overflowY=${filled.overflowY}, expected auto/scroll so content stays reachable`,
    );
    assert.ok(
      filled.scrollHeight >= filled.clientHeight,
      `capped textarea scrollHeight ${filled.scrollHeight} < clientHeight ${filled.clientHeight}`,
    );
  } else {
    // 未触顶：应当按内容完全展开，没有裁切。
    assert.ok(
      filled.scrollHeight <= filled.clientHeight + 2,
      `expanded textarea clips content: scrollHeight ${filled.scrollHeight} > clientHeight ${filled.clientHeight} + 2`,
    );
  }
  // 任何情况下都不突破封顶（border-box 下 offsetHeight 比 max-height 多上下各 1px 边框）。
  if (filled.maxHeight !== null) {
    assert.ok(
      filled.offsetHeight <= filled.maxHeight + 2,
      `textarea exceeded max-height: offsetHeight ${filled.offsetHeight} > max-height ${filled.maxHeight} + 2`,
    );
  }

  // 3) 360px 窄视口：不得横向溢出（scrollWidth ≤ clientWidth）。
  await page.setViewportSize({ width: 360, height: 800 });
  await area.scrollIntoViewIfNeeded();
  const narrow = await measureArea(area);
  assert.ok(
    narrow.scrollWidth <= narrow.clientWidth,
    `narrow viewport horizontal overflow: scrollWidth ${narrow.scrollWidth} > clientWidth ${narrow.clientWidth}`,
  );

  if (process.env.DSH_PET_UI_ARTIFACTS) {
    mkdirSync(process.env.DSH_PET_UI_ARTIFACTS, { recursive: true });
    await page.screenshot({
      path: join(process.env.DSH_PET_UI_ARTIFACTS, 'settings-zh-360-persona-long.png'),
      fullPage: true,
    });
  }
});

for (const lang of ['en', 'zh']) {
  for (const width of [360, 520, 900]) {
    test(`settings keep controls and toggle labels readable (${lang}, ${width}px)`, async (t) => {
      const { page } = await open(t, { viewport: { width, height: 800 }, lang });
      const clipped = await page
        .locator('.dsh-pet-cfg__toggle>label>span')
        .evaluateAll((labels) =>
          labels.filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent),
        );
      assert.deepEqual(clipped, []);
      if (process.env.DSH_PET_UI_ARTIFACTS) {
        mkdirSync(process.env.DSH_PET_UI_ARTIFACTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.DSH_PET_UI_ARTIFACTS, 'settings-' + lang + '-' + width + '.png'),
          fullPage: true,
        });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
  }
}

test('model picker remains anchored while the responsive settings panel is scrolled', async (t) => {
  const { page, writes } = await open(t, { viewport: { width: 900, height: 700 } });
  const trigger = page.locator('.dsh-pet-mp__trigger').first();
  // 设置页比 700px 视口长得多，触发器初始在视口外：先滚到它可见处，否则「浮层贴住触发器」
  // 这条不变量在触发器本身就不可见时无从验证（浮层只能被钳在视口外）。
  await trigger.scrollIntoViewIfNeeded();
  const base = await page.evaluate(() => window.scrollY);
  await trigger.click();
  const panel = page.getByRole('menu');
  await panel.waitFor();
  for (const offset of [0, 120]) {
    await page.evaluate((y) => window.scrollTo(0, y), base + offset);
    await page.waitForFunction(() => {
      const trigger = document.querySelector('.dsh-pet-mp__trigger').getBoundingClientRect();
      const panel = document.querySelector('.dsh-pet-mp__panel').getBoundingClientRect();
      return Math.abs(panel.left - trigger.left) < 2 && panel.top >= 0 && panel.bottom <= innerHeight;
    });
  }
  await page.getByRole('menuitemradio', { name: 'Follow current conversation' }).click();
  await save(page);
  assert.deepEqual(writes[0].whisperModel, { provider: '', model: '' });
});
