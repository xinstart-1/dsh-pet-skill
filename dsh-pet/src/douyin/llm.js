/**
 * 大模型回复生成（只走宿主 LLM，不自己配 Key）。
 *
 * 为什么回复要过大模型：固定模板三条就露馅，对方一眼看出是机器人。
 * 大模型只干一件事——把"对方说了什么"变成一句像人话的回复；发什么、发不发，
 * 仍然由外层那套闸门/回执/去重管着，这层只负责"措辞"。
 *
 * **模型不归本插件管**：pet 与本插件共用 harness 的 `ctx.llm` + `agentDefaultModel`，
 * 用户在 harness 里配的默认模型就是唯一来源。这里没有任何 API Key / 网关 / 模型名可配，
 * 也没有第二条通路——宿主不可用就如实失败，上层据此**不发**（没有模板兜底）。
 *
 * 分层：`buildChatMessages` / `stripWrapper` 是纯函数（钉单测）；
 * `createHostLlm()` 是唯一 IO 通路，失败永远结构化返回，不抛错。
 *
 * @module dsh-pet-douyin/llm
 */

/**
 * 组装对话消息（纯）。人设由调用方传入——真源在宠物设置页，**本模块不备默认人格**：
 * 宠物没写人设就是"没有人格"，宁缺也不造一个"抖音AI助手"出来（那等于同一个人有两套性格）。
 * @param {{peer: string, texts: string[], persona?: string}} args 参数
 * @returns {Array<{role: string, content: string}>} messages
 */
export function buildChatMessages({ peer, texts, persona = '' }) {
  const convo = texts.slice(-8).map((t, i) => `${i + 1}. ${String(t).slice(0, 120)}`).join('\n');
  return [
    { role: 'system', content: String(persona ?? '') },
    {
      role: 'user',
      content:
        `会话对象：${peer}\n` +
        `最近的消息（按时间排序，最后一条是刚收到的）：\n${convo}\n\n` +
        '请直接给出一条要回复的正文，不要任何解释、引号或前缀。',
    },
  ];
}

/* ---------------- 宿主半侧：直接用 DSH 注入的 ctx.llm ---------------- */

/**
 * 从宿主流的块序列里抽正文（纯）：只认 `text-delta`，剥一层包裹引号。
 * chunk 形状（实测）：`{type:'block-start',index,blockType}`、`{type:'text-delta',text}`、
 * `{type:'reasoning-delta',text}`——推理模型的思考走 `reasoning-delta`，**不算正文**。
 * @param {string} raw 拼接后的正文
 * @returns {string} 清理后的正文
 */
export function stripWrapper(raw) {
  let s = String(raw ?? '').trim();
  if (s.length >= 2) {
    const pairs = [
      ['"', '"'],
      ['「', '」'],
      ['“', '”'],
    ];
    for (const [l, r] of pairs) {
      if (s.startsWith(l) && s.endsWith(r)) {
        s = s.slice(1, -1).trim();
        break;
      }
    }
  }
  return s;
}

/**
 * 包一层宿主 LLM（dsh-pet 同款接法：`ctx.llm.stream` + `ctx.agentDefaultModel`）。
 *
 * 边界（实测/源码核对得出）：
 * - 消息形状是 `{role, content:[{type:'text',text}], source}`，user 的 source 是 `{kind:'user'}`，
 *   assistant 的 source 是 `{provider, model}`——不需要 import `@deepseek-ai/dsh-llm`，手搓即可；
 * - 生成结果从流里累积 `text-delta` 块，`reasoning-delta` 忽略；
 * - 模型取 `ctx.agentDefaultModel.currentSelection()`（用户在 harness 里配的默认模型），
 *   没配就返回 `{ok:false, reason:'no-model-selection'}`，由上层回落；
 * - 宿主不注入 `llm` 服务（旧版宿主/异常态）时整个工厂返回 null。
 *
 * @param {{ctx: any, sessionId?: string}} deps Cordis ctx（已 inject llm / agentDefaultModel）+ 会话语义标签
 * @returns {{generate: (args: {system?: string, user: string, history?: Array<{role: string, content: string}>, timeoutMs?: number}) => Promise<{ok: boolean, text?: string, reason?: string, model?: string}>, modelLabel: () => Promise<string>}|null} 适配器
 */
export function createHostLlm({ ctx, sessionId = 'dsh-pet-douyin' }) {
  if (typeof ctx?.llm?.stream !== 'function') return null;

  /** 当前默认模型；读不到返回 null */
  async function selection() {
    try {
      const s = ctx.agentDefaultModel?.currentSelection();
      return s?.provider && s?.model ? { provider: String(s.provider), model: String(s.model) } : null;
    } catch {
      return null;
    }
  }

  /**
   * 跑一次生成。失败返回 `{ok:false, reason}`，不抛错——宿主流的失败被 dsh-llm 折进终止块，这里兜底成结构化结果。
   * @param {{system?: string, user: string, history?: Array<{role: string, content: string}>, timeoutMs?: number}} args 参数
   * @returns {Promise<{ok: boolean, text?: string, reason?: string, model?: string}>} 结果
   */
  async function generate({ system = '', user, history = [], images = [], timeoutMs = 60_000 }) {
    const sel = await selection();
    if (sel === null) return { ok: false, reason: 'no-model-selection（harness 里没配默认模型）' };
    // 人设走 **system 消息**，不是 `system` 选项：实测宿主不吃 `system`（传了等于没传——
    // 表现为回话完全不按宠物人设来，问它身份还会自称底层模型）。
    // 形状与 `@deepseek-ai/dsh-llm` 的 `createSystemMessage` 一致（本模块不引那个包，
    // 与这里的消息都是手搓，保持"只依赖宿主注入的 ctx"）。
    const messages = [
      ...(String(system ?? '').trim() === ''
        ? []
        : [{ role: 'system', content: [{ type: 'text', text: String(system) }], source: { kind: 'system-prompt' } }]),
      ...history.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: String(m.content ?? '') }],
        ...(m.role === 'assistant'
          ? { source: { provider: sel.provider, model: sel.model } }
          : { source: { kind: 'user' } }),
      })),
      { role: 'user', content: [
          ...(String(user ?? '') === '' ? [] : [{ type: 'text', text: String(user) }]),
          // 图片块排在文本块之后：提示词先到、像素后到，模型更容易按提示去看图。
          // `attachment` 是附件服务返回的引用（{attachmentId, mediaType, bytes, width, height}），
          // 与 dsh-pet 宿主侧 chat.ts 传图用的是同一种形状。
          ...images.map((attachment) => ({ type: 'image', attachment })),
        ], source: { kind: 'user' } },
    ];
    const parts = [];
    // 推理模型（如 sensenova flash-lite）偶发只吐 reasoning 不吐正文——空正文重试一次，
    // 再空才交回上层（上层不发，没有模板兜底）。重试只多等一拍，不改变"失败结构化交回上层"的约定。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      parts.length = 0;
      try {
        for await (const ch of ctx.llm.stream({
          provider: sel.provider,
          model: sel.model,
          sessionId,
          messages,
          temperature: 1,
          signal: AbortSignal.timeout(timeoutMs),
        })) {
          if (ch?.type === 'text-delta' && typeof ch.text === 'string') parts.push(ch.text);
        }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      const text = stripWrapper(parts.join(''));
      if (text !== '') return { ok: true, text, model: `${sel.provider}/${sel.model}` };
    }
    return { ok: false, reason: '模型未返回正文' };
  }

  return {
    generate,
    async modelLabel() {
      const s = await selection();
      return s === null ? '未配置默认模型' : `${s.provider}/${s.model}`;
    },
  };
}
