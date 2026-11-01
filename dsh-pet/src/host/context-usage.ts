/**
 * 上下文用量估算：把「这次请求会带多少 token」算给用户看。
 *
 * 为什么是估算不是精确值：插件侧拿不到宿主分词器，而 DeepSeek 系分词对中文约 0.6 token/字、
 * 英文约 4 字符/token——按这个启发式取整上浮，误差对"占比还剩多少"的判断足够。
 * 组成与真实请求逐字同源：system 走 persona.petSystemText（唯一拼装点），历史就是当次会截进
 * 上下文的那些条，每轮开销（配图清单）与 chat.ts 的 imageInstruction 同一份文本。
 * 必须始终成立：只读传入的文本，不发起 IO；window 非法时回退默认，绝不返回 NaN。
 * @module dsh-pet/src/host/context-usage
 */

/** 上下文窗口的内置默认（token）：插件不知道模型真实窗口，用户层配置 contextWindowTokens 覆盖。 */
export const DEFAULT_CONTEXT_WINDOW = 131_072;

/** 一段用量组成的展示条目。 */
export interface ContextPart {
  /** 稳定键（前端配色用）：system / history / perTurn */
  key: 'system' | 'history' | 'perTurn';
  /** 中文展示名 */
  label: string;
  /** 估算 token 数 */
  tokens: number;
}

/** 一次请求的上下文用量（估算）。 */
export interface ContextUsage {
  /** 组成清单（顺序即堆叠顺序） */
  parts: ContextPart[];
  /** 合计 token */
  total: number;
  /** 模型上下文窗口（token） */
  window: number;
  /** 占窗口百分比（0~100，保留 1 位小数） */
  percent: number;
}

/** 估算一段文本的 token 数（CJK ≈ 0.6 token/字，其余 ≈ 0.25 token/字符，向上取整）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // CJK 表意文字 + 全角标点/假名等（U+3000 起）都按"一个字一个 token 的大头"算
    if (ch.codePointAt(0)! >= 0x3000) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.6 + other * 0.25);
}

/**
 * 该宠物生效的上下文窗口（token）：条目配置 contextWindowTokens（有限且 > 0）优先，
 * 否则内置默认 131072。非法值静默回退——占量显示不该因为一个写错的数字报错。
 */
export function windowTokensOf(conf: Record<string, unknown>): number {
  const v = Number(conf.contextWindowTokens);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_CONTEXT_WINDOW;
}

/**
 * 拼一次请求的上下文用量。
 *
 * @param args.system - 最终 system 提示词全文（petSystemText 的结果）。
 * @param args.historyTexts - 本次会截进上下文的记忆正文（每条一个元素，只算 content）。
 * @param args.perTurnText - 每条用户消息都要附的额外文本（配图指令 + 清单；纯文本对话为空串）。
 * @param args.window - 模型上下文窗口（token）。
 * @returns 组成 + 合计 + 百分比；window ≤ 0 时按 1 兜底（percent 封顶 100，不返回 NaN）。
 */
export function contextUsageOf(args: {
  system: string;
  historyTexts: readonly string[];
  perTurnText?: string;
  window: number;
}): ContextUsage {
  const parts: ContextPart[] = [
    { key: 'system', label: '系统提示词', tokens: estimateTokens(args.system) },
    {
      key: 'history',
      label: '对话历史',
      tokens: args.historyTexts.reduce((sum, t) => sum + estimateTokens(t), 0),
    },
    { key: 'perTurn', label: '本轮开销', tokens: estimateTokens(args.perTurnText ?? '') },
  ];
  const total = parts.reduce((sum, p) => sum + p.tokens, 0);
  const window = Number.isFinite(args.window) && args.window > 0 ? args.window : 1;
  const percent = Math.min(100, Math.round((total / window) * 1000) / 10);
  return { parts, total, window, percent };
}
