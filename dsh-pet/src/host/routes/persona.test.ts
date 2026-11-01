/**
 * `GET /persona` 的契约测试：把"宠物的人设"正确交给别的插件。
 *
 * 钉三件事：
 *   ① `persona` 是人设正文（不含名字与时间），`system` 是拼好的完整提示词；
 *   ② 没填人设时不编造：`persona` 为空串，`system` 只剩名字声明；
 *   ③ 宠物不存在时原样返回 `requirePet` 的结论（不吞成空人设）。
 *
 * 跑法：node --experimental-strip-types --test src/host/routes/persona.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PetRouteDeps, RouteInput } from './types.ts';
import { handlePersonaRoutes } from './persona.ts';

/** 造依赖：requirePet 按参数返回固定宠物 */
function makeDeps(pet: Record<string, unknown> | null): PetRouteDeps {
  return {
    configPaths: {},
    log: { warn: () => {} },
    requirePet: (_params: URLSearchParams, _cfg: unknown) =>
      pet === null
        ? { ok: false as const, res: { kind: 'json' as const, status: 200, obj: { ok: false, reason: 'unknown-pet' } } }
        : { ok: true as const, petId: 'main', entry: 'main', conf: {}, pet },
  } as unknown as PetRouteDeps;
}

/** 一次 GET /persona */
function input(method = 'GET', rest = 'persona'): RouteInput {
  return { url: new URL('http://127.0.0.1/dsh-pet-7340/persona?pet=main'), rest, method };
}

/** 取应答体 */
function bodyOf(res: unknown): { ok: boolean; pet?: string; persona?: string; system?: string } {
  return (res as { obj: unknown }).obj as { ok: boolean; pet?: string; persona?: string; system?: string };
}

test('填了人设：persona 是正文，system 含正文 + 名字', async () => {
  const deps = makeDeps({ id: 'main', name: '蓝毛小女仆', whisperPrompt: '你是鲸鱼娘溟月，喜欢白米饭。' });
  const body = bodyOf(await handlePersonaRoutes(deps, input()));
  assert.equal(body.ok, true);
  assert.equal(body.pet, 'main');
  assert.equal(body.persona, '你是鲸鱼娘溟月，喜欢白米饭。');
  assert.match(String(body.system), /鲸鱼娘溟月/);
  assert.match(String(body.system), /蓝毛小女仆/);
});

test('没人设不编造：persona 空串，system 只剩名字', async () => {
  const deps = makeDeps({ id: 'main', name: '蓝毛小女仆' });
  const body = bodyOf(await handlePersonaRoutes(deps, input()));
  assert.equal(body.persona, '');
  assert.match(String(body.system), /蓝毛小女仆/);
  assert.doesNotMatch(String(body.system), /鲸鱼/);
});

test('宠物不存在：把 requirePet 的结论原样交回', async () => {
  const deps = makeDeps(null);
  const body = bodyOf(await handlePersonaRoutes(deps, input()));
  assert.equal(body.ok, false);
});

test('方法不对 → 405；路径不匹配 → 交回下一个处理器', async () => {
  const deps = makeDeps({ id: 'main' });
  assert.equal(((await handlePersonaRoutes(deps, input('POST'))) as { status: number }).status, 405);
  assert.equal(await handlePersonaRoutes(deps, input('GET', 'chat')), undefined);
});
