/**
 * 扩展能力位的单测 —— 钉住四件事：
 *   ① 清单解析：裸数组与 `{extensions:[]}` 都认，非法条目（缺 id、非本机地址、重复 id）静默丢弃；
 *   ② 只会问本机：`api` 指向外网时该条直接不生效（用户的话不出这台机器）；
 *   ③ 认领语义：只有 `{ok:true,claimed:true,ack}` 才算接管，其余（HTTP 错误 / 字段缺失 / 非 JSON）一律当没接管；
 *   ④ 故障隔离：超时、连接被拒、清单写坏都不能抛到对话层——宠物照常闲聊。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/extension-say.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExtensionSay, parseExtensions } from './extension-say.ts';

/** 造一个临时 DSH_HOME，可选写入 extensions.json */
async function makeHome(manifest?: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pet-ext-'));
  if (manifest !== undefined) {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'extensions.json'), JSON.stringify(manifest), 'utf8');
  }
  return home;
}

/** 收集 warn，便于断言"故障只记日志不抛出" */
function makeLog(): { lines: string[]; warn(m: string): void } {
  const lines: string[] = [];
  return {
    lines,
    warn(message: string) {
      lines.push(message);
    },
  };
}

/** 造一个假的 fetch：按 URL 返回预设响应，并记录被问过的地址 */
function makeFetch(
  handler: (url: string, body: unknown) => { ok?: boolean; json?: unknown } | Promise<{ ok?: boolean; json?: unknown }>,
): { calls: { url: string; body: unknown }[]; impl: typeof fetch } {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, body });
    const out = await handler(url, body);
    return {
      ok: out.ok ?? true,
      json: async () => out.json,
    };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('parseExtensions —— 清单校验', () => {
  test('裸数组与带外壳两种形状都认，并按 order 升序', () => {
    const bare = parseExtensions([
      { id: 'b', api: 'http://127.0.0.1:2/x', order: 20 },
      { id: 'a', api: 'http://127.0.0.1:1/x', order: 10 },
    ]);
    assert.deepEqual(
      bare.map((e) => e.id),
      ['a', 'b'],
    );
    const wrapped = parseExtensions({ extensions: [{ id: 'a', api: 'http://localhost:1/x' }] });
    assert.equal(wrapped.length, 1);
    assert.equal(wrapped[0]?.label, 'a', 'label 缺失时用 id 兜底');
    assert.equal(wrapped[0]?.api, 'http://localhost:1/x');
  });

  test('非法条目丢弃：缺 id / 缺 api / 重复 id / 非法 URL / 非对象', () => {
    const got = parseExtensions([
      { api: 'http://127.0.0.1:1/x' },
      { id: 'no-api' },
      { id: 'dup', api: 'http://127.0.0.1:1/x' },
      { id: 'dup', api: 'http://127.0.0.1:2/x' },
      { id: 'bad-url', api: 'not-a-url' },
      'string',
      null,
    ]);
    assert.deepEqual(
      got.map((e) => e.id),
      ['dup'],
    );
    assert.equal(got[0]?.api, 'http://127.0.0.1:1/x', '重复 id 保留第一条');
  });

  test('非本机地址一律不生效（用户的话不出这台机器）', () => {
    const got = parseExtensions([
      { id: 'remote', api: 'http://example.com/api' },
      { id: 'lan', api: 'http://192.168.1.5:8080/api' },
      { id: 'local', api: 'http://127.0.0.1:8080/api' },
      { id: 'v6', api: 'http://[::1]:8080/api' },
    ]);
    assert.deepEqual(
      got.map((e) => e.id),
      ['local', 'v6'],
    );
  });

  test('尾斜杠被剥掉（拼接 /pet-say 时不会出现 //）', () => {
    const got = parseExtensions([{ id: 'a', api: 'http://127.0.0.1:1/x///' }]);
    assert.equal(got[0]?.api, 'http://127.0.0.1:1/x');
  });
});

describe('claim —— 认领语义', () => {
  test('没人认领 → null；请求体带 pet 与原话', async () => {
    const home = await makeHome({ extensions: [{ id: 'a', api: 'http://127.0.0.1:1/x' }] });
    const { calls, impl } = makeFetch(() => ({ json: { ok: true, claimed: false } }));
    const ext = createExtensionSay({ dshHome: home, log: makeLog(), fetchImpl: impl });
    assert.equal(await ext.claim({ pet: 'main', text: '你好呀' }), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'http://127.0.0.1:1/x/pet-say');
    assert.deepEqual(calls[0]?.body, { pet: 'main', text: '你好呀' });
  });

  test('认领 → 带回执；ack 缺失时用 label 兜底', async () => {
    const home = await makeHome({
      extensions: [
        { id: 'a', label: '甲', api: 'http://127.0.0.1:1/x' },
        { id: 'b', label: '乙', api: 'http://127.0.0.1:2/x' },
      ],
    });
    const { impl } = makeFetch((url) =>
      url.includes(':2/') ? { json: { ok: true, claimed: true } } : { json: { ok: true, claimed: false } },
    );
    const ext = createExtensionSay({ dshHome: home, log: makeLog(), fetchImpl: impl });
    assert.deepEqual(await ext.claim({ pet: 'main', text: '帮我发条消息' }), {
      id: 'b',
      ack: '交给「乙」了',
    });
  });

  test('两个都认领时按 order 取前者（顺序即优先级）', async () => {
    const home = await makeHome({
      extensions: [
        { id: 'late', api: 'http://127.0.0.1:2/x', order: 20 },
        { id: 'early', api: 'http://127.0.0.1:1/x', order: 10 },
      ],
    });
    const { impl } = makeFetch((url) => ({
      json: { ok: true, claimed: true, ack: url.includes(':1/') ? '我先' : '我后' },
    }));
    const ext = createExtensionSay({ dshHome: home, log: makeLog(), fetchImpl: impl });
    assert.equal((await ext.claim({ pet: 'main', text: '办事' }))?.ack, '我先');
  });

  test('HTTP 错误 / claimed 非 true / 非 JSON 形状 → 算没认领', async () => {
    const home = await makeHome({
      extensions: [
        { id: 'a', api: 'http://127.0.0.1:1/x' },
        { id: 'b', api: 'http://127.0.0.1:2/x' },
        { id: 'c', api: 'http://127.0.0.1:3/x' },
      ],
    });
    const { impl } = makeFetch((url) => {
      if (url.includes(':1/')) return { ok: false, json: {} };
      if (url.includes(':2/')) return { json: { ok: true, claimed: 'yes' } };
      return { json: null };
    });
    const ext = createExtensionSay({ dshHome: home, log: makeLog(), fetchImpl: impl });
    assert.equal(await ext.claim({ pet: 'main', text: '办事' }), null);
  });

  test('抛错/超时被吞掉，只留一行日志，不影响其他扩展认领', async () => {
    const home = await makeHome({
      extensions: [
        { id: 'boom', api: 'http://127.0.0.1:1/x', order: 10 },
        { id: 'ok', api: 'http://127.0.0.1:2/x', order: 20 },
      ],
    });
    const log = makeLog();
    const impl = (async (input: unknown) => {
      if (String(input).includes(':1/')) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ ok: true, claimed: true, ack: '我来' }) };
    }) as unknown as typeof fetch;
    const ext = createExtensionSay({ dshHome: home, log, fetchImpl: impl });
    assert.equal((await ext.claim({ pet: 'main', text: '办事' }))?.ack, '我来');
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0] ?? '', /boom/);
  });

  test('没有清单 / 清单写坏 / 空话 → 一次请求都不发', async () => {
    const noFile = await makeHome();
    const broken = await makeHome();
    await writeFile(join(broken, 'extensions.json'), '{ oops', 'utf8');
    for (const home of [noFile, broken]) {
      const { calls, impl } = makeFetch(() => ({ json: { ok: true, claimed: true } }));
      const log = makeLog();
      const ext = createExtensionSay({ dshHome: home, log, fetchImpl: impl });
      assert.equal(await ext.claim({ pet: 'main', text: '办事' }), null);
      assert.equal(calls.length, 0);
      // 文件缺失是常态（不打日志）；写坏要报，否则排障时看不出清单被写烂了
      assert.equal(log.lines.length, home === broken ? 1 : 0);
    }
    const home = await makeHome({ extensions: [{ id: 'a', api: 'http://127.0.0.1:1/x' }] });
    const { calls, impl } = makeFetch(() => ({ json: { ok: true, claimed: true } }));
    const ext = createExtensionSay({ dshHome: home, log: makeLog(), fetchImpl: impl });
    assert.equal(await ext.claim({ pet: 'main', text: '   ' }), null);
    assert.equal(calls.length, 0);
  });
});
