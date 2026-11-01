/**
 * LLM 回复层：消息组装、宿主流解析、包裹清理。
 * 措辞可以由模型发挥，但这层的形状不能漂——发出去的是"一条干净的正文"。
 * 只走宿主 LLM（harness 默认模型），没有任何自备 Key 的通路。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatMessages, createHostLlm, stripWrapper } from './llm.js';

test('buildChatMessages：system 用人设，user 里带会话名和最近消息（截断到 8 条）', () => {
  const msgs = buildChatMessages({ peer: '星⭐心', texts: ['你好', '@我 在吗'], persona: '贱萌' });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, '贱萌');
  assert.ok(msgs[1].content.includes('星⭐心'));
  assert.ok(msgs[1].content.includes('@我 在吗'));
  const many = buildChatMessages({ peer: 'x', texts: Array.from({ length: 20 }, (_, i) => `m${i}`) });
  assert.ok(!many[1].content.includes('m0 '), '只带最近 8 条');
  assert.ok(many[1].content.includes('m19'));
  assert.equal(buildChatMessages({ peer: 'x', texts: ['你好'] })[0].content, '', '人设为空不造默认人格（真源在宠物设置页）');
});

test('stripWrapper：剥一层包裹引号', () => {
  assert.equal(stripWrapper(' "好的呀" '), '好的呀');
  assert.equal(stripWrapper('「没问题」'), '没问题');
  assert.equal(stripWrapper('正常正文'), '正常正文');
  assert.equal(stripWrapper(''), '');
  assert.equal(stripWrapper(null), '');
});

test('createHostLlm：宿主没 llm 服务时返回 null', () => {
  assert.equal(createHostLlm({ ctx: {} }), null);
  assert.equal(createHostLlm({ ctx: { llm: {} } }), null);
});

test('createHostLlm：从 text-delta 累积正文，忽略 reasoning-delta；消息形状正确', async () => {
  const seen = [];
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'aaa', model: 'm-1' }) },
    llm: {
      async *stream(options) {
        seen.push(options);
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: '想一想' };
        yield { type: 'block-start', index: 1, blockType: 'text' };
        yield { type: 'text-delta', index: 1, text: '在' };
        yield { type: 'text-delta', index: 1, text: '的呀' };
      },
    },
  };
  const host = createHostLlm({ ctx });
  const r = await host.generate({ system: '你是助手', user: '你好', history: [{ role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }] });
  assert.equal(r.ok, true);
  assert.equal(r.text, '在的呀');
  assert.equal(r.model, 'aaa/m-1');
  const opts = seen[0];
  assert.equal(opts.provider, 'aaa');
  assert.equal(opts.model, 'm-1');
  // 人设走 system 消息（宿主的 `system` 选项实测不生效，见 llm.js 的注释）
  assert.equal(opts.system, undefined);
  assert.equal(opts.messages.length, 4);
  assert.deepEqual(opts.messages[0], {
    role: 'system',
    content: [{ type: 'text', text: '你是助手' }],
    source: { kind: 'system-prompt' },
  });
  assert.deepEqual(opts.messages[1], { role: 'user', content: [{ type: 'text', text: '早' }], source: { kind: 'user' } });
  assert.deepEqual(opts.messages[2].source, { provider: 'aaa', model: 'm-1' });
  assert.deepEqual(opts.messages[3], { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } });
});

test('createHostLlm：带图时文本在前、图片块在后，且用附件引用而不是裸字节', async () => {
  const seen = [];
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'aaa', model: 'm-1' }) },
    llm: {
      async *stream(options) {
        seen.push(options);
        yield { type: 'text-delta', text: '看见了' };
      },
    },
  };
  const ref = { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 1024, width: 320, height: 240 };
  const host = createHostLlm({ ctx });
  const r = await host.generate({ system: '', user: '这条在讲什么', images: [ref] });
  assert.equal(r.ok, true);
  const msg = seen[0].messages.at(-1);
  assert.equal(msg.role, 'user');
  assert.deepEqual(msg.content, [
    { type: 'text', text: '这条在讲什么' },
    { type: 'image', attachment: ref },
  ]);
});

test('createHostLlm：不带图时消息形状与加图之前完全一致', async () => {
  const seen = [];
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'aaa', model: 'm-1' }) },
    llm: {
      async *stream(options) {
        seen.push(options);
        yield { type: 'text-delta', text: '好' };
      },
    },
  };
  await createHostLlm({ ctx }).generate({ user: '在吗' });
  assert.deepEqual(seen[0].messages.at(-1).content, [{ type: 'text', text: '在吗' }]);
});

test('createHostLlm：没配默认模型如实返回 no-model-selection；流抛错折成 ok:false', async () => {
  const hostNone = createHostLlm({ ctx: { agentDefaultModel: { currentSelection: () => null }, llm: { stream: async function* () {} } } });
  assert.deepEqual(await hostNone.generate({ user: 'x' }).then((r) => ({ ok: r.ok })), { ok: false });
  const hostErr = createHostLlm({
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      llm: { stream: async function* () { throw new Error('boom'); } },
    },
  });
  const r = await hostErr.generate({ user: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /boom/);
});
