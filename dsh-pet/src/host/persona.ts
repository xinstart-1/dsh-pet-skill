/**
 * 人设拼装（宿主半侧，纯逻辑）：碎碎念与对话共用的 system 提示词只在这一处拼好。
 *
 * 三段，顺序固定：人设正文（实例 whisperPrompt → 条目 whisperPrompt → 空串）、名字声明、
 * 时间背景（timeContextOf 现算，不缓存）。不碰 IO、不读时钟，Date 由调用方传入；也不负责取字段与
 * 发起生成（index.ts 的 petSystemPrompt 只做「取字段 → 调这里」）。
 * 必须始终成立：拼装点唯一——不给名字与时间开占位符配置，否则等于出现第二个拼装点。
 * @module dsh-pet/src/host/persona
 */
import { timeContextOf } from './time-context.ts';

/**
 * 某宠物最终生效的人设正文（不含名字与时间）：实例 whisperPrompt → 条目 whisperPrompt → 空串。
 *
 * 语义是替换而不是拼接：两段人设同时生效会让模型收到两个身份。
 * 实例级的值合并器已过滤过，这里仍 trim 判空——petPersona 也是导出函数，不能假设调用方走了合并器。
 */
export function petPersona(conf: Record<string, unknown>, pet: Record<string, unknown>): string {
  const own = pet.whisperPrompt;
  if (typeof own === 'string' && own.trim() !== '') return own;
  const entry = conf.whisperPrompt;
  return typeof entry === 'string' ? entry : '';
}

/** composeSystemPrompt 的入参 */
export interface SystemPromptParts {
  /** 已回落到生效值的人设正文（petPersona 的结果；空串 = 没有人设，只有名字 + 时间） */
  prompt: string;
  /** 显示名（pets[].name；缺失/空按 id 处理） */
  name: string;
  /** 宠物 id（name 为空时的兜底；两者都空 = 整段名字声明省略） */
  id: string;
  /** 生成这一刻（生产传 new Date()，测试传固定日期） */
  now: Date;
  /**
   * 环境感知那一句（`awarenessText()` 的结果；空串 = 不注入）。
   *
   * 与人设分开：这是**每拍现算的动态事实**（你在哪个窗口、浏览器开着什么），
   * 不是"你是谁"。写进人设会让人有两套性格，也会过时。
   */
  awareness?: string;
}

/**
 * 拼出最终 system 提示词：人设正文 + 名字声明 + 时间背景。
 *
 * 边界：prompt 为空时不留前导换行；name 与 id 都取不到时整段名字声明省略；
 * now 非法（NaN）时 timeContextOf 返回空串，时间背景整行不加（宁缺，也不把 NaN 拼进提示词）。
 */
export function composeSystemPrompt(parts: SystemPromptParts): string {
  const name = String(parts.name || parts.id);
  const nameLine = name ? '你的名字是“' + name + '”。' : '';
  const lines = [parts.prompt, nameLine].filter((line) => line !== '');
  const time = timeContextOf(parts.now);
  if (time) lines.push(time);
  // 环境感知排在时间之后：同属"此刻的背景"，但它是可选的、可能为空
  const aware = String(parts.awareness ?? '').trim();
  if (aware !== '') lines.push(aware);
  return lines.join('\n');
}

/** petSystemText 的入参：findPetInstance 的命中结果 + 本拍环境感知那句（可空）。 */
export interface PetSystemInput {
  conf: Record<string, unknown>;
  pet: Record<string, unknown>;
}

/**
 * 某只宠物最终发给模型的 system 提示词——**全插件唯一拼装点**。
 *
 * 碎碎念（chat-memory）、对话生成与「上下文用量」估算（routes/chat 的 GET）都从这里取，
 * 保证估算看到的 system 与真正发出去的逐字一致（否则占量显示就是骗人的）。
 * 拼装内容 = composeSystemPrompt（人设正文 + 名字声明 + 时间背景 + 环境感知）；
 * `now` 缺省取当前时刻（估算与真实生成同一口径，都按"这一次请求"现算）。
 */
export function petSystemText(
  found: PetSystemInput,
  awareness: string,
  now: Date = new Date(),
): string {
  return composeSystemPrompt({
    prompt: petPersona(found.conf, found.pet),
    name: String(found.pet.name ?? ''),
    id: String(found.pet.id ?? ''),
    now,
    awareness,
  });
}
