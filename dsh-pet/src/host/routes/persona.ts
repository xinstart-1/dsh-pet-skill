/**
 * `GET /persona`：把某只宠物**当前生效的人设**交给别的插件用。
 *
 * **为什么要有这个口子**：人格是"宠物自己的属性"，真源在 pet（用户在设置页里填的那份
 * `whisperPrompt`）。但能力插件回消息时也需要同一个人格——它们不该各存一份副本，
 * 否则改一处另一处不变，同一个人格会在两个场景里说两种话。
 *
 * 这里只做"取字段 → 交给唯一的拼装点（`persona.ts`）"，**不新造拼法**：
 * 人设正文 / 名字声明 / 时间背景的顺序由 `composeSystemPrompt` 一处决定。
 *
 * 返回两段：
 * - `persona`：人设正文（不含名字与时间）——调用方要自己拼别的东西时用它；
 * - `system`：拼好的完整 system 提示词——调用方只想"照着这个人格说话"时直接用它。
 *
 * @module dsh-pet/src/host/routes/persona
 */
import { readAllConfig } from '../config.ts';
import type { RouteResult } from '../http.ts';
import { composeSystemPrompt, petPersona } from '../persona.ts';
import { methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/**
 * `GET /persona?pet=<id>`：某只宠物的人设。
 * @param deps - 路由依赖（`configPaths` + `requirePet`）
 * @param input - 路由输入
 * @returns 人设；宠物不存在时按 `requirePet` 的结论返回
 */
export async function handlePersonaRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  if (input.rest !== 'persona') return undefined;
  if (input.method !== 'GET') return methodNotAllowed();

  const who = deps.requirePet(input.url.searchParams, () => readAllConfig(deps.configPaths));
  if (!who.ok) return who.res;

  const persona = petPersona(who.conf, who.pet);
  const rawName = who.pet.name;
  const system = composeSystemPrompt({
    prompt: persona,
    name: typeof rawName === 'string' ? rawName : '',
    id: who.petId,
    now: new Date(),
  });

  return okResult({ ok: true, pet: who.petId, persona, system });
}
