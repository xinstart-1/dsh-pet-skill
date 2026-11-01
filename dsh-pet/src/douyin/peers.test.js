/**
 * 熟人名单：名字 → 身份。
 *
 * 这里钉的是「别认错人」：认错比不认更尴尬（把陌生网友当主人，主人反而被当外人）。
 * 也钉住「没配名单就一句都不加」——老用户的回复语气不能因为这个功能被改掉。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanPeerName, describePeer, findPeer, parsePeerList } from './peers.js';

test('规整会话名：剥零宽字符与群成员数后缀', () => {
  assert.equal(cleanPeerName('  阿星  '), '阿星');
  assert.equal(cleanPeerName('在发什么呆(3)'), '在发什么呆');
  assert.equal(cleanPeerName('阿\u200b星'), '阿星');
  assert.equal(cleanPeerName(undefined), '');
});

test('解析名单：分隔符两侧空白不算内容，坏行（没名字）丢掉', () => {
  assert.deepEqual(parsePeerList([' 阿星 | 主人 | 别声张 ', '小李|朋友', '', '  ', '| 主人']), [
    { name: '阿星', relation: '主人', note: '别声张', owner: true },
    { name: '小李', relation: '朋友', note: '', owner: false },
  ]);
});

test('解析名单：关系写 owner 也算主人，同名只留第一条', () => {
  const [a] = parsePeerList(['boss | OWNER', 'boss | 同事']);
  assert.equal(a.owner, true);
  assert.equal(a.relation, 'OWNER', '第一条原样留下，后写的静默丢弃');
  assert.equal(parsePeerList(['boss | OWNER', 'boss | 同事']).length, 1);
});

test('认人：先精确，再包含；单字名字不参与包含匹配', () => {
  const list = ['阿星 | 主人', '小李 | 主人的朋友'];
  assert.equal(findPeer('阿星', parsePeerList(list))?.owner, true);
  assert.equal(findPeer('小李的朋友圈', parsePeerList(list))?.name, '小李', '昵称带装饰也能认出来');
  assert.equal(findPeer('小', parsePeerList(['小 | 主人']))?.owner, true, '一字名字精确相等照样认得');
  assert.equal(findPeer('小明的号', parsePeerList(['小 | 主人'])), null, '但一字名字不许模糊命中所有人');
  assert.equal(findPeer('路人甲', parsePeerList(list)), null);
});

test('认人：同时配了长短两个名字时取更具体的那个', () => {
  const entries = parsePeerList(['小李 | 同事', '小李子 | 主人']);
  assert.equal(findPeer('小李子的号', entries)?.name, '小李子');
});

test('身份声明：没配名单 = 一句都不加（老用户行为不变）', () => {
  assert.equal(describePeer('张三', []), '');
  assert.equal(describePeer('张三', undefined), '');
});

test('身份声明：主人 / 熟人 / 陌生人三种口气', () => {
  const list = ['阿星 | 主人', '小李 | 主人的朋友 | 常来聊游戏'];
  assert.match(describePeer('阿星', list), /主人本人/);
  const friend = describePeer('小李', list);
  assert.match(friend, /主人的朋友/);
  assert.match(friend, /常来聊游戏/);
  assert.match(friend, /不是你主人/);
  const stranger = describePeer('路人甲', list);
  assert.match(stranger, /不在你的熟人名单里/);
  assert.match(stranger, /陌生网友/);
});

test('身份声明：名字拿不到时按陌生网友，不瞎猜是谁', () => {
  assert.match(describePeer('', ['阿星 | 主人']), /不知道现在跟你说话的人是谁/);
});

test('身份声明：熟人没写关系时给一句能读通的兜底', () => {
  assert.match(describePeer('老王', ['老王']), /主人认识的人/);
});
