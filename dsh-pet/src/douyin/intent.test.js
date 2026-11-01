/**
 * 意图解析：把"人话"钉死。
 *
 * 这些用例都是从真实说法里抄的（含礼貌前缀、书名号、表情符号收件人），
 * 目的不是覆盖率好看，而是**保证不会截错收件人**——发错人是这条链路上唯一不可挽回的错。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeClaim, parseIntent } from './intent.js';

/** 只要动作与收件人的简写 */
const brief = (s) => {
  const r = parseIntent(s);
  return { action: r.action, to: r.to, topic: r.topic };
};

test('带正文：冒号、逗号、无标点三种写法都要认', () => {
  assert.deepEqual(brief('给星⭐心发一条消息：测试一下'), { action: 'dm', to: '星⭐心', topic: '测试一下' });
  assert.deepEqual(brief('给星⭐心发条消息，在吗'), { action: 'dm', to: '星⭐心', topic: '在吗' });
  assert.deepEqual(brief('给星⭐心发消息说测试一下'), { action: 'dm', to: '星⭐心', topic: '测试一下' });
});

test('只有收件人、没有正文：topic 必须是空串（交给上层用大模型补）', () => {
  assert.deepEqual(brief('给星⭐心发一条消息'), { action: 'dm', to: '星⭐心', topic: '' });
  assert.deepEqual(brief('给星⭐心发消息'), { action: 'dm', to: '星⭐心', topic: '' });
  assert.deepEqual(brief('私信星⭐心'), { action: 'dm', to: '星⭐心', topic: '' });
});

test('四种句式：发消息给X / 私信X / 对X说 / 回复X', () => {
  assert.deepEqual(brief('发消息给星⭐心：你好'), { action: 'dm', to: '星⭐心', topic: '你好' });
  assert.deepEqual(brief('私信星⭐心：你好'), { action: 'dm', to: '星⭐心', topic: '你好' });
  assert.deepEqual(brief('对星⭐心说：你好'), { action: 'dm', to: '星⭐心', topic: '你好' });
  // 「回复」是独立动作：先读对方最新一条再发，跟"凭空发一条"的 dm 不一样
  assert.deepEqual(brief('回复星⭐心：收到'), { action: 'reply', to: '星⭐心', topic: '收到' });
});

test('回复类：光杆回复、指代词、不带正文的回复X', () => {
  // 光杆"回复"= 回当前打开的会话（to 留空交给上层）
  for (const s of ['回复', '回一下', '回复他', '回复她', '回消息', '帮我回复一下']) {
    const r = parseIntent(s);
    assert.equal(r.action, 'reply', s);
    assert.equal(r.to, '', `${s} 不该产出具体收件人`);
  }
  // 回复X 不带正文：正文由上层（大模型）补
  assert.deepEqual(brief('回复星⭐心'), { action: 'reply', to: '星⭐心', topic: '' });
  // 指代词跟在后面不算收件人：「回复他：好的」= 回当前会话
  assert.deepEqual(brief('回复他：好的'), { action: 'reply', to: '', topic: '好的' });
  // 句尾语气词不影响
  assert.equal(parseIntent('回复一下吧').action, 'reply');
});

test('礼貌前缀与句尾语气词不影响判定', () => {
  assert.deepEqual(brief('帮我给星⭐心发一条消息：在吗'), { action: 'dm', to: '星⭐心', topic: '在吗' });
  assert.deepEqual(brief('麻烦给星⭐心发条消息吧'), { action: 'dm', to: '星⭐心', topic: '' });
  assert.equal(parseIntent('给星⭐心发条消息！').action, 'dm');
});

test('收件人外面的引号要剥掉', () => {
  assert.equal(parseIntent('给「星⭐心」发条消息').to, '星⭐心');
  assert.equal(parseIntent('给"星⭐心"发条消息').to, '星⭐心');
  assert.equal(parseIntent('给《星⭐心》发条消息').to, '星⭐心');
});

test('名字里带空格也要整体保留（不能只截前半段）', () => {
  assert.equal(parseIntent('给 小 星 心 发条消息：在吗').to, '小 星 心');
});

test('正文里的换行与表情原样保留，不做任何改写', () => {
  const r = parseIntent('给星⭐心发条消息：第一行\n第二行 😀');
  assert.equal(r.topic, '第一行\n第二行 😀');
});

test('读会话 / 看作品 / 出发布包，三个非私信动作', () => {
  assert.equal(parseIntent('看看消息').action, 'chats');
  assert.equal(parseIntent('有什么新消息吗').action, 'chats');
  assert.equal(parseIntent('出个发布包').action, 'publish');
  assert.equal(parseIntent('帮我剪一下素材').action, 'publish');
});

test('「发消息」不能被误判成「发布」', () => {
  assert.equal(parseIntent('给星⭐心发条消息').action, 'dm');
  assert.equal(parseIntent('看看有没有新消息').action, 'chats', '带"消息"就不该走发布包');
});

test('刷推荐流：刷/翻 + 抖音/推荐，几种说法都要认', () => {
  for (const said of ['刷会儿抖音', '刷刷抖音', '刷一下抖音', '刷抖音', '翻会儿抖音', '刷推荐流']) {
    assert.equal(parseIntent(said).action, 'feed', `「${said}」应判为 feed`);
  }
});

test('刷推荐流不能被别的动作抢走：带消息/私信/发布的说法不算', () => {
  // 这些句子的具体归属不重要（多半是 help，让宠物自己接），关键是不能被"刷"吞掉
  for (const said of ['刷抖音的时候回一下消息', '刷抖音私信他', '刷抖音的发布包弄好了吗']) {
    assert.notEqual(parseIntent(said).action, 'feed', `「${said}」不该被当成单纯的刷`);
  }
});

test('听不懂就认怂：返回 help 且带提示，不猜一个动作出来', () => {
  const r = parseIntent('你好');
  assert.equal(r.action, 'help');
  assert.ok(r.needs.length > 0);
  assert.equal(parseIntent('').action, 'help');
  assert.equal(parseIntent('   ').action, 'help');
});

test('空收件人绝不生成 dm（否则会发给默认对象）', () => {
  for (const bad of ['给发条消息', '私信', '对说：你好']) {
    const r = parseIntent(bad);
    assert.notEqual(r.action === 'dm' && r.to === '', true, `「${bad}」不该产出空收件人的 dm`);
  }
});

/* ---------------- 认领判定：宠物对话里的每一句都会问到这里 ---------------- */

test('能完整执行才认领：缺收件人或缺正文的私信一律不接', () => {
  // 接了却没有正文 = 宠物说"这就去发"然后什么也没发生，比不接更糟
  assert.equal(describeClaim(parseIntent('给星⭐心发条消息')).claimable, false);
  assert.equal(describeClaim(parseIntent('给星⭐心发条消息说我想你了')).claimable, true);
  assert.equal(describeClaim(parseIntent('私信星⭐心：在吗')).claimable, true);
});

test('不是指令的句子不认领，让宠物用自己的人格闲聊', () => {
  for (const said of ['你好呀', '今天好累', '我想你了', '']) {
    assert.equal(describeClaim(parseIntent(said)).claimable, false, `「${said}」不该被接管`);
  }
});

test('回执只承诺"去办"，不承诺结果（成败由执行完的播报说）', () => {
  const dm = describeClaim(parseIntent('给星⭐心发条消息：我想你了'));
  assert.equal(dm.claimable, true);
  assert.match(dm.ack, /星⭐心/);
  assert.ok(!/已发送|发出去了|好了/.test(dm.ack), `回执不该预先宣告成功：${dm.ack}`);
});

test('回复类：光杆「回复」也算完整意图（回当前会话最新一条）', () => {
  assert.equal(describeClaim(parseIntent('回复他')).claimable, true);
  assert.equal(describeClaim(parseIntent('回复星⭐心：今晚不行')).claimable, true);
  assert.equal(describeClaim(null).claimable, false, '坏输入不能抛错');
});

test('看消息 / 看作品 / 出发布包 都可认领', () => {
  assert.equal(describeClaim(parseIntent('看看有没有新消息')).claimable, true);
  assert.equal(describeClaim(parseIntent('出个发布包')).claimable, true);
});
