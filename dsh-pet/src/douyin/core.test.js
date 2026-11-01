/**
 * 纯逻辑单测：授权地址、code 提取、错误解析、作品归一化、配置归一化。
 * 这些都不碰网络与磁盘，边界（没有 code / 抖音返回 error_code / 嵌套封面）全部造得出来。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, appReadiness, pathsFor } from './config.js';
import {
  buildAuthorizeUrl,
  extractCode,
  hasScope,
  normalizeItem,
  normalizeToken,
  pickUrl,
  readError,
} from './douyin-client.js';
import { humanCount, dayOf } from './capabilities.js';
import { mask } from './service.js';

test('授权地址：参数齐全且 scope 用逗号连接', () => {
  const url = buildAuthorizeUrl({
    clientKey: 'aw123',
    scopes: ['user_info', 'video.list'],
    redirectUri: 'https://a.com/cb',
    state: 's1',
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://open.douyin.com/platform/oauth/connect/');
  assert.equal(u.searchParams.get('client_key'), 'aw123');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'user_info,video.list');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://a.com/cb');
  assert.equal(u.searchParams.get('state'), 's1');
});

test('授权地址：没有回调地址时不带该参数（走手动粘贴 code）', () => {
  const url = buildAuthorizeUrl({ clientKey: 'k', scopes: ['user_info'], redirectUri: '' });
  assert.equal(new URL(url).searchParams.has('redirect_uri'), false);
});

test('code 提取：整条回调地址 / 只有 query / 裸 code 都认', () => {
  assert.equal(extractCode('https://a.com/cb?code=abc123&state=s'), 'abc123');
  assert.equal(extractCode('?code=xyz'), 'xyz');
  assert.equal(extractCode('raw-code-1'), 'raw-code-1');
  assert.equal(extractCode('https://a.com/cb?state=s'), '');
  assert.equal(extractCode(''), '');
});

test('scope 判定：逗号与空格分隔都认', () => {
  assert.equal(hasScope('user_info video.list', 'video.list'), true);
  assert.equal(hasScope('user_info,video.list', 'video.list'), true);
  assert.equal(hasScope('user_info', 'video.list'), false);
  assert.equal(hasScope('', 'video.list'), false);
});

test('错误解析：HTTP 200 + error_code 也算失败', () => {
  assert.deepEqual(readError({ data: { error_code: 0 } }), { code: 0, detail: '' });
  const e = readError({ data: { error_code: 2190008, description: 'access_token过期' } });
  assert.equal(e.code, 2190008);
  assert.equal(e.detail, 'access_token过期');
  assert.equal(readError({ message: 'boom' }).detail, 'boom');
});

test('token 归一化：字段缺失不炸', () => {
  const t = normalizeToken({ data: { access_token: 'a', open_id: 'o', expires_in: '7200' } });
  assert.equal(t.accessToken, 'a');
  assert.equal(t.openId, 'o');
  assert.equal(t.expiresIn, 7200);
  assert.equal(t.refreshToken, '');
});

test('封面/URL 取值：字符串、url_list、url 三种形状', () => {
  assert.equal(pickUrl('https://x/a.jpg'), 'https://x/a.jpg');
  assert.equal(pickUrl('a.jpg'), '', '相对路径不认');
  assert.equal(pickUrl({ url_list: ['https://x/b.jpg'] }), 'https://x/b.jpg');
  assert.equal(pickUrl({ url: 'https://x/c.jpg' }), 'https://x/c.jpg');
  assert.equal(pickUrl(null), '');
});

test('作品归一化：item_id 缺失时兜 aweme_id，统计字段转数字', () => {
  const it = normalizeItem({
    aweme_id: 'aw1',
    desc: '  标题  ',
    cover: { url_list: ['https://c'] },
    share_url: 'https://v.douyin.com/x/',
    create_time: '1700000000',
    statistics: { play_count: '1000', digg_count: 12 },
  });
  assert.equal(it.itemId, 'aw1');
  assert.equal(it.title, '标题');
  assert.equal(it.cover, 'https://c');
  assert.equal(it.createTime, 1700000000);
  assert.equal(it.stats.play, 1000);
  assert.equal(it.stats.digg, 12);
});

test('配置归一化：坏值回落、scope 去重、https 校验', () => {
  const { config, warnings } = normalizeConfig({
    app: { clientKey: 123, scopes: ['user_info', 'user_info', 'video.list', ' '], authorizeBase: 'http://evil' },
    behavior: { browseCount: 999, throttleMs: -1 },
  });
  assert.equal(config.app.clientKey, '', '非字符串回落空');
  assert.deepEqual(config.app.scopes, ['user_info', 'video.list']);
  assert.equal(config.app.authorizeBase, 'https://open.douyin.com/platform/oauth/connect/', 'http 基址被纠正');
  assert.equal(config.behavior.browseCount, 20, '夹到上限');
  assert.equal(config.behavior.throttleMs, 0, '夹到下限');
  assert.ok(warnings.length >= 4);
});

test('凭据就绪判定', () => {
  const { config } = normalizeConfig({});
  assert.deepEqual(appReadiness(config).missing, ['Client Key', 'Client Secret']);
  const { config: ok } = normalizeConfig({ app: { clientKey: 'k', clientSecret: 's' } });
  assert.equal(appReadiness(ok).ready, true);
});

test('路径落在 $DSH_HOME/dsh-pet-douyin-account', () => {
  const p = pathsFor('C:/Users/demo/.dsh/dsh-pet-douyin-account');
  assert.ok(p.accountsFile.includes('accounts.json'));
  assert.ok(p.grantsFile.includes('grants.json'));
});

test('脱敏与数字人话', () => {
  assert.equal(mask('aw1234567890'), 'aw12…7890');
  assert.equal(mask('short'), '****');
  assert.equal(mask(''), '');
  assert.equal(humanCount(1234), '1234');
  assert.equal(humanCount(12345), '1.2万');
  assert.equal(humanCount(123456789), '1.2亿');
  assert.equal(dayOf(0), '');
  assert.match(dayOf(1700000000), /^\d{4}-\d{2}-\d{2}$/);
});

// ── 打开外链的协议白名单：自定义 scheme 曾经被一行 /^https?:/ 彻底挡死 ──
import { douyinAppInstalled, openUrl } from './util.js';

test('openUrl：自定义 scheme 在白名单里才放行，其余一律拒绝', async () => {
  const bad = await openUrl('file:///c:/windows/system32/calc.exe');
  assert.equal(bad.ok, false, 'file: 必须被拒——否则插件成了任意程序启动器');

  const weird = await openUrl('javascript:alert(1)');
  assert.equal(weird.ok, false);

  const notUrl = await openUrl('这不是地址');
  assert.equal(notUrl.ok, false);
});

test('douyinAppInstalled：只返回布尔，不抛异常', async () => {
  const v = await douyinAppInstalled();
  assert.equal(typeof v, 'boolean');
});
