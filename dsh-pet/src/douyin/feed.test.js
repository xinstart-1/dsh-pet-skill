/**
 * 推荐流的单条解析。
 *
 * 测试数据是 2026-10-29 从真实播放器抓下来的原文（douyin.com/?recommend=1，登录态），
 * 不是编的——解析规则一旦对不上真实结构，这个功能就是"看起来刷了，报的全错"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  digestOf,
  formatDuration,
  formatLikes,
  likesOf,
  parseRecommend,
  parseRecommendList,
  shareTextOf,
  topByLikes,
} from './feed.js';

// 真实抓取记录：一条完整的（含 caption / item_title），两条只有 desc 的
const REAL = [
  {
    id: '7677415935590644521',
    nick: '@LibTV',
    itemTitle: '《太公在此》',
    desc: '《太公在此》 此后三千年，人间起屋上梁，镇宅安门，皆贴红纸：「太公在此 诸神退位」 #LibTV创作者成长计划',
    caption:
      '此后三千年，人间起屋上梁，镇宅安门，皆贴红纸：「太公在此 诸神退位」——\n本片以"姜子牙封神未封己身"的民间传说为灵感，演绎民俗「太公在此」红纸的由来。\n本视频由LibTV生成',
    digg: 79199,
    duration: 348369,
  },
  {
    id: '7696217463704309007',
    nick: '@剑网3',
    desc: '50级新世代！#剑网3苍生铸世新版本10月29日公测！重回5',
    digg: '1.4万',
    duration: '00:29',
  },
  {
    id: '7675665548755176758',
    nick: '@AI.814',
    desc: '第1集：《感染区》 列车驶入感染区，揭开序幕…',
    digg: '88.3万',
    duration: '03:20',
  },
];

test('解析真实记录：标题取 item_title，摘要取 caption（完整文案）', () => {
  const it = parseRecommend(REAL[0]);
  assert.equal(it.id, '7677415935590644521');
  assert.equal(it.author, 'LibTV');
  assert.equal(it.title, '《太公在此》', '有结构化标题就用它，别拿整段文案当标题');
  assert.match(it.summary, /^此后三千年/, 'caption 是"这条讲什么"的来源');
  assert.match(it.summary, /民间传说为灵感/, '多行文案要压成一行但内容不能丢');
  assert.equal(it.likes, '7.9万', '79199 要显示成万');
  assert.equal(it.duration, '05:48', '348369ms 要显示成 mm:ss');
  assert.equal(it.url, 'https://www.douyin.com/video/7677415935590644521');
});

test('没有 item_title / caption 时退回 desc：标题只取第一句，摘要用全文', () => {
  const it = parseRecommend(REAL[1]);
  assert.equal(it.title, '50级新世代', '按标点切成一句话，播报才不会被话题标签撑爆');
  assert.match(it.summary, /#剑网3苍生铸世/, '摘要保留原文（话题也在），供详情展示');
});

test('点赞换算：415 / 1.4万 / 88.3万 / 1.2亿 / 空', () => {
  assert.equal(likesOf('415'), 415);
  assert.equal(likesOf('1.4万'), 14_000);
  assert.equal(likesOf('88.3万'), 883_000);
  assert.equal(likesOf('1.2亿'), 120_000_000);
  assert.equal(likesOf(''), 0);
  assert.equal(likesOf('赞'), 0);
});

test('缺字段不猜：没有作者/描述/点赞也照样出条目', () => {
  const it = parseRecommend({ id: '123' });
  assert.equal(it.author, '');
  assert.equal(it.title, '');
  assert.equal(it.likes, '');
  assert.equal(it.likesNum, 0);
  assert.equal(it.duration, '');
});

test('接口给的原始数字要显示化：79199 → 7.9万，348369ms → 05:48', () => {
  assert.equal(formatLikes(79199), '7.9万');
  assert.equal(formatLikes(12000), '1.2万');
  assert.equal(formatLikes(10000), '1万');
  assert.equal(formatLikes(9999), '9999');
  assert.equal(formatLikes(120000000), '1.2亿');
  assert.equal(formatLikes('1.4万'), '1.4万', '已经是文本的原样返回');
  assert.equal(formatDuration(348369), '05:48');
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration('nope'), '');

  const it = parseRecommend({ id: '1', digg: 79199, duration: 348369 });
  assert.equal(it.likes, '7.9万');
  assert.equal(it.likesNum, 79_000);
  assert.equal(it.duration, '05:48');
});

test('多行描述压成一行（播放器里的描述常带换行）', () => {
  const it = parseRecommend({ id: '9', desc: '第一行\n第二行\n\n第三行' });
  assert.equal(it.title, '第一行 第二行 第三行');
});

test('没有 data-e2e-vid 的直接丢掉（拼不出链接，报出去也没用）', () => {
  assert.equal(parseRecommend({ id: '' }), null);
  assert.equal(parseRecommend(null), null);
});

test('按 id 去重：翻页瞬间的重复快照只留一次', () => {
  const items = parseRecommendList([REAL[0], REAL[1], REAL[0], { id: '' }]);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => i.id),
    [REAL[0].id, REAL[1].id],
  );
});

test('挑最热：按点赞数值降序，读不出点赞的排后面', () => {
  const items = parseRecommendList([...REAL, { id: '999', desc: '无点赞的一条' }]);
  const top = topByLikes(items, 2);
  assert.deepEqual(
    top.map((i) => i.likes),
    ['88.3万', '7.9万'],
  );
  assert.equal(topByLikes(items, 9)[3].id, '999', '读不出点赞的不会被丢掉，只是排最后');
});

test('分享文案：作者 + 《标题》 + 单条链接，话题标签要剥掉', () => {
  const text = shareTextOf(parseRecommend(REAL[1]));
  assert.match(text, /^@剑网3 /, '作者后的 @ 不能重复出现');
  assert.match(text, /50级新世代/);
  assert.doesNotMatch(text, /#剑网3苍生铸世/, '话题标签会撑爆句子');
  assert.match(text, /https:\/\/www\.douyin\.com\/video\/7696217463704309007$/);
  assert.equal(shareTextOf(null), '');
});

test('分享文案：标题自带书名号时不再套一层', () => {
  const text = shareTextOf(parseRecommend(REAL[0]));
  assert.match(text, /《太公在此》/);
  assert.doesNotMatch(text, /《《/, '标题自带《》时不许再套一层');
});

test('气泡播报：短、去话题、带点赞、超出用条数收尾', () => {
  const d = digestOf(parseRecommendList(REAL), { max: 2 });
  assert.match(d, /^刷了会儿抖音，挑2条给你：/);
  assert.equal(d.split('\n').length, 4);
  assert.match(d, /1\. @AI\.814 /, '88.3万赞那条最热，排第一');
  assert.doesNotMatch(d, /#剑网3苍生铸世/);
  assert.match(d, /一共刷到 3 条/);
});

test('气泡播报：没有条目就不说话', () => {
  assert.equal(digestOf([], { max: 3 }), '');
});
