/**
 * 「一句话」链路的行为约束。
 *
 * 这组测试盯的不是"功能有没有"，而是**三条不能破的保证**：
 * 1. `sent` 永远是 false —— 插件从不替人发送；
 * 2. 没授牌就一步都不许动；
 * 3. 认不出收件人时不许默认发给谁。
 *
 * 第 2、3 条一旦回归，产物就是"发错人的私信"，这是整条链路唯一不可挽回的错。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from './service.js';

const silent = { info() {}, warn() {}, error() {}, list: () => [] };

/**
 * 起一个隔离服务。网页通道必然连不上（测试里没有 9333），正好覆盖降级分支。
 * @returns {Promise<any>} 服务
 */
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dy-say-'));
  const opened = [];
  const service = createService({
    home,
    log: silent,
    getPort: () => 0,
    copy: async () => ({ ok: true }),
    open: async (u) => {
      opened.push(u);
      return { ok: true };
    },
  });
  await service.init();
  // 端口指向一个几乎不可能有人监听的位置：测试绝不能连上开发机上真开着的那个浏览器，
  // 否则"读会话"会真的去操作你正在用的窗口（踩过一次：本机 9333 正好开着）。
  // autoLaunch 必须显式关掉：默认 browserPath 指向本机的 ego lite，开着它测试会
  // 真拉起一个专用浏览器实例，"没有网页通道"的降级分支就永远走不到了。
  await service.saveConfig({ behavior: { recordAudit: true }, web: { enabled: true, port: 65500, autoLaunch: false } });
  return { service, opened };
}

test('没授牌：一个字都不许动，且要指出缺哪项', async () => {
  const { service } = await setup();
  const r = await service.say({ pet: 'main', text: '给星⭐心发条消息：测试' });
  assert.equal(r.ok, false);
  assert.equal(r.needGrant, 'dm');
  assert.equal(r.sent, false);
  assert.match(r.reply, /授牌/);
  await service.stop();
});

test('默认（自动发送关着）：只出草稿，sent 必须是 false', async () => {
  const { service } = await setup();
  await service.setGrant({ pet: 'main', caps: { dm: true } });

  const r = await service.say({ pet: 'main', text: '给星⭐心发条消息：测试一下' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'dm');
  assert.equal(r.sent, false, '开关没开就绝不能是 true');
  assert.equal(r.intent.to, '星⭐心');
  assert.equal(r.intent.topic, '测试一下');
  assert.match(r.reply, /草稿已复制/);
  assert.match(r.reply, /自动发送没开/);
  assert.equal(r.focused, false, '测试里没有网页通道，必须走降级');
  await service.stop();
});

test('开了自动发送、但没有正文：仍然不许发（不能把模板占位文字当人话发出去）', async () => {
  const { service } = await setup();
  await service.setGrant({ pet: 'main', caps: { dm: true } });
  await service.saveConfig({ web: { allowAutoSend: true, port: 65500 } });

  const r = await service.say({ pet: 'main', text: '给星⭐心发条消息' });
  assert.equal(r.sent, false);
  assert.equal(r.sendResult, null, '正文为空时根本不该尝试发送');
  await service.stop();
});

test('开了自动发送但通道连不上：不许假装发出去，且要说清原因', async () => {
  const { service } = await setup();
  await service.setGrant({ pet: 'main', caps: { dm: true } });
  await service.saveConfig({ web: { allowAutoSend: true, port: 65500 } });

  const r = await service.say({ pet: 'main', text: '给星⭐心发条消息：这条发不出去' });
  assert.equal(r.sent, false, '连不上浏览器还敢说 sent:true 就是骗人');
  assert.equal(r.sendResult.ok, false);
  assert.match(r.reply, /自动发送没成功/);
  await service.stop();
});

test('网页通道连不上时，降级为打开网页版消息页（而不是假装成功）', async () => {
  const { service, opened } = await setup();
  await service.setGrant({ pet: 'main', caps: { dm: true } });
  await service.say({ pet: 'main', text: '私信星⭐心：在吗' });
  assert.ok(opened.includes('https://www.douyin.com/chat'), '没连上专用浏览器时应当打开网页版');
  await service.stop();
});

test('读会话也要过授牌（读消息本身就是在碰私信内容）', async () => {
  const { service } = await setup();
  const r = await service.say({ pet: 'main', text: '看看消息' });
  assert.equal(r.ok, false);
  assert.equal(r.needGrant, 'dm');
  await service.stop();
});

test('认不出意图就追问，不硬凑一个动作', async () => {
  const { service } = await setup();
  await service.setGrant({ pet: 'main', caps: { dm: true, browse: true, publish: true } });
  const r = await service.say({ pet: 'main', text: '你好呀' });
  assert.equal(r.ok, false);
  assert.equal(r.needIntent, true);
  assert.ok(r.reply.length > 0);
  await service.stop();
});

test('空收件人绝不进 dm 分支', async () => {
  const { service } = await setup();
  await service.setGrant({ pet: 'main', caps: { dm: true } });
  const r = await service.say({ pet: 'main', text: '给发条消息' });
  assert.notEqual(r.action === 'dm' && r.ok === true, true);
  await service.stop();
});

test('每次成功都落审计，失败也落（出问题能回答"谁什么时候做了什么"）', async () => {
  const { service } = await setup();
  await service.setGrant({ pet: 'main', caps: { dm: true } });
  await service.say({ pet: 'main', text: '给星⭐心发条消息：审计用' });
  const state = service.state();
  const hit = state.audit.filter((a) => a.action === 'say');
  assert.ok(hit.length >= 1, 'say 必须留痕');
  assert.equal(hit[0].pet, 'main');
  await service.stop();
});

/* ---------------- 宠物对话框里的认领（POST /pet-say） ---------------- */

test('完整意图：立刻回执 + 认领，绝不在返回前等执行', async () => {
  const { service } = await setup();
  const started = Date.now();
  const r = await service.petSay({ pet: 'main', text: '给星⭐心发条消息说我想你了' });
  const cost = Date.now() - started;
  assert.equal(r.ok, true);
  assert.equal(r.claimed, true);
  assert.equal(r.action, 'dm');
  assert.match(r.ack, /星⭐心/);
  // 执行（读会话 → 发消息）要几秒，回执必须在此之前返回，否则宠物对话框会卡住。
  // 阈值放宽到 1s：这里要证明的是"没有同步等执行"，不是精确性能。
  assert.ok(cost < 1000, `认领必须立刻返回，实际 ${cost}ms`);
});

test('不是指令的句子不认领，交给宠物自己闲聊', async () => {
  const { service } = await setup();
  for (const said of ['我想你了', '你好呀', '']) {
    const r = await service.petSay({ pet: 'main', text: said });
    assert.equal(r.claimed, false, `「${said}」不该被接管`);
    assert.equal(r.ack, '');
  }
});

test('缺正文的私信不认领（接了也发不出去，只会骗用户）', async () => {
  const { service } = await setup();
  const r = await service.petSay({ pet: 'main', text: '给星⭐心发条消息' });
  assert.equal(r.claimed, false);
});

test('试一句：宿主没给 llm 时如实失败，绝不吐模板腔', async () => {
  const { service } = await setup();
  const r = await service.previewReply({ peer: '星⭐心', text: '在吗' });
  assert.equal(r.ok, false, '取不到模型就必须是失败');
  assert.equal(r.text, undefined, '没有正文就不许编一句出来');
  assert.match(String(r.error), /llm/i);
  await service.stop();
});

test('试一句：有宿主 llm 时正文原样来自模型（没有模板痕迹）', async () => {
  const { service } = await setup();
  service.setHostLlm({ generate: async () => ({ ok: true, text: '在的，刚忙完', model: 'stub/m' }), modelLabel: async () => 'stub/m' });
  const r = await service.previewReply({ peer: '星⭐心', text: '在吗' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '在的，刚忙完');
  assert.equal(r.via, 'host-llm');
  await service.stop();
});

test('熟人名单：身份声明真的进了 system，清空后一句都不加', async () => {
  const { service } = await setup();
  let seen = '';
  service.setHostLlm({
    generate: async ({ system }) => {
      seen = system;
      return { ok: true, text: '好', model: 'stub/m' };
    },
    modelLabel: async () => 'stub/m',
  });

  await service.saveConfig({ web: { knownPeers: ['阿星 | 主人', '小李 | 主人的朋友 | 常来聊游戏'] } });

  await service.previewReply({ peer: '阿星', text: '在吗' });
  assert.match(seen, /主人本人/, '名单里标了主人，这一条就得真的出现在提示词里');
  assert.match(seen, /替主人回一句话/, '场景约束不能被身份声明挤掉');

  await service.previewReply({ peer: '小李', text: '在吗' });
  assert.match(seen, /主人的朋友/);
  assert.match(seen, /常来聊游戏/);

  await service.previewReply({ peer: '路人甲', text: '在吗' });
  assert.match(seen, /不在你的熟人名单里/);

  // 名单清空 = 完全不注入（老用户语气不许被这个功能改动）
  await service.saveConfig({ web: { knownPeers: [] } });
  seen = '';
  await service.previewReply({ peer: '阿星', text: '在吗' });
  assert.doesNotMatch(seen, /主人本人/);
  assert.doesNotMatch(seen, /熟人名单/);
  await service.stop();
});
