/**
 * 环境感知的纯逻辑：挑页面 / 拼提示 / 判断该不该开口。
 *
 * 这三件事一起钉，因为它们决定了宠物"看到了什么"和"什么时候搭话"——
 * 判断错了不会崩，只会变成一个烦人的东西（用户明确反感的那种）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectWindows, formatAwareness, pickActivePage, pickByVisibility, pickNotableWindows, speakReason, type AwarenessSample } from './awareness.ts';

test('按可见性挑页面：只有 visible 的那个算数（标签顺序不作数）', () => {
  const pages = [
    { title: '创作者中心', url: 'https://creator.douyin.com/upload', visible: false },
    { title: '抖音-记录美好生活', url: 'https://www.douyin.com/?recommend=1', visible: true },
  ];
  assert.equal(pickByVisibility(pages)?.url, 'https://www.douyin.com/?recommend=1');
  assert.equal(
    pickByVisibility(pages.map((p) => ({ ...p, visible: false }))),
    null,
    '都不亮就交给启发式兜底',
  );
  assert.equal(pickByVisibility([{ title: 'x', url: 'chrome://settings', visible: true }]), null, '非 http 不算');
});

test('启发式兜底：优先第一个含 douyin.com 的页面；非 page / 非 http 一律忽略', () => {
  const targets = [
    { type: 'page', title: '创作者中心', url: 'https://creator.douyin.com/creator-micro/content/upload' },
    { type: 'page', title: '抖音-记录美好生活', url: 'https://www.douyin.com/?recommend=1' },
    { type: 'service_worker', title: '', url: 'https://www.douyin.com/sw.js' },
    { type: 'page', title: 'chrome://settings', url: 'chrome://settings' },
  ];
  // 这条规则不懂"视线"，只保证"是个抖音页"。真正的选择靠 visibilityState，见上一个用例。
  assert.equal(pickActivePage(targets)?.url, 'https://creator.douyin.com/creator-micro/content/upload');

  const noDouyin = [{ type: 'page', title: '知乎', url: 'https://www.zhihu.com/' }];
  assert.deepEqual(pickActivePage(noDouyin), { title: '知乎', url: 'https://www.zhihu.com/' });

  assert.equal(pickActivePage([]), null);
  assert.equal(pickActivePage([{ type: 'service_worker', url: 'https://x/y.js' }]), null);
});

test('拼提示：只列真的采到的信号，一条都没有就返回空串（调用方据此不加这行）', () => {
  assert.equal(formatAwareness(null), '');
  assert.equal(formatAwareness({ at: 1 }), '');

  const browserOnly = formatAwareness({
    at: 1,
    browser: { title: '抖音-记录美好生活', url: 'https://www.douyin.com/?recommend=1' },
  });
  assert.match(browserOnly, /浏览器里在看「抖音-记录美好生活」/);
  assert.doesNotMatch(browserOnly, /窗口/, '没采到窗口就别提');

  const winOnly = formatAwareness({ at: 1, windowTitle: 'index.ts - Visual Studio Code', windowProcess: 'Code' });
  assert.match(winOnly, /「index\.ts - Visual Studio Code」（Code）/);

  assert.match(formatAwareness({ at: 1, idleSec: 1900 }), /半个多小时没动键鼠/);
  assert.match(formatAwareness({ at: 1, idleSec: 320 }), /有 5 分钟没动键鼠/);
  assert.match(formatAwareness({ at: 1, idleSec: 5 }), /正在电脑前/);
});

test('拼提示：末尾带一句"别复述"，防止它把看到的念出来', () => {
  const s = formatAwareness({ at: 1, windowTitle: 'x', windowProcess: 'y' });
  assert.match(s, /不要复述给主人听/);
});

test('首拍不开口：刚开就冒一句是最烦的', () => {
  const cur: AwarenessSample = { at: 1000, browser: { title: 'a', url: 'https://a.com/1' } };
  assert.deepEqual(speakReason(null, cur), { speak: false, reason: '首拍只记录' });
});

test('换页面 / 换窗口要开口', () => {
  const prev: AwarenessSample = { at: 1000, browser: { title: 'a', url: 'https://a.com/1' } };
  const changed: AwarenessSample = { at: 61_000, browser: { title: 'b', url: 'https://b.com/2' } };
  assert.equal(speakReason(prev, changed).reason, '换了页面');

  assert.equal(speakReason({ at: 1, windowTitle: 'A' }, { at: 2, windowTitle: 'B' }).reason, '换了窗口');
});

test('同一页面盯太久才提醒，正常采样间隔不触发', () => {
  const prev: AwarenessSample = { at: 0, browser: { title: 'a', url: 'https://a.com/1' } };
  const later: AwarenessSample = { at: 31 * 60_000, browser: prev.browser };
  assert.equal(speakReason(prev, later, { stallSec: 1800 }).speak, true, '间隔跨过阈值 → 说');

  const short: AwarenessSample = { at: 5 * 60_000, browser: prev.browser };
  assert.equal(speakReason(prev, short, { stallSec: 1800 }).speak, false, '5 分钟一采不会误报');
});

test('走开很久又回来：说一句', () => {
  const prev: AwarenessSample = { at: 0, idleSec: 2000, browser: { title: 'a', url: 'https://a.com/1' } };
  const back: AwarenessSample = { at: 60_000, idleSec: 3, browser: prev.browser };
  assert.equal(speakReason(prev, back, { awaySec: 900 }).reason, '离开后回来');
});

test('窗口采集：解析进程名与标题，同名窗口去重，坏行忽略', async () => {
  const out = [
    'wps\t周报.docx - WPS Office',
    'Weixin\t微信',
    'wps\t周报.docx - WPS Office',
    '没有制表符的坏行',
    'msedge\t和另外 3 个页面 - Microsoft Edge',
  ].join('\r\n');
  const run = async () => ({ code: 0, stdout: out });
  const list = await collectWindows(run);
  assert.deepEqual(list, [
    { process: 'wps', title: '周报.docx - WPS Office' },
    { process: 'Weixin', title: '微信' },
    { process: 'msedge', title: '和另外 3 个页面 - Microsoft Edge' },
  ]);
});

test('窗口采集：命令失败或没输出 → 空数组，不抛', async () => {
  assert.deepEqual(await collectWindows(async () => ({ code: 1, stdout: '' })), []);
  assert.deepEqual(await collectWindows(async () => ({ code: 0, stdout: '   ' })), []);
});

test('挑窗口：优先"在干活"的（WPS/Office/编辑器），其次其它', () => {
  const list = [
    { process: 'Weixin', title: '微信' },
    { process: 'wps', title: '周报.docx - WPS Office' },
    { process: 'msedge', title: '知乎' },
  ];
  assert.equal(pickNotableWindows(list, 1)[0].process, 'wps', '聊天软件不该抢在文档前面');
  assert.equal(pickNotableWindows(list, 2).length, 2);
  assert.deepEqual(pickNotableWindows([], 2), []);
});

test('拼提示：窗口标题会进那一句，且带上"别复述"', () => {
  const s = formatAwareness({
    at: 1,
    windows: [{ process: 'wps', title: '周报.docx - WPS Office' }],
  });
  assert.match(s, /桌面上开着「周报\.docx - WPS Office」/);
  assert.match(s, /不要复述给主人听/);
});

test('打开一个新窗口（WPS/Office）就算"有变化"要开口', () => {
  const prev: AwarenessSample = {
    at: 0,
    windows: [{ process: 'Weixin', title: '微信' }],
  };
  const cur: AwarenessSample = {
    at: 300_000,
    windows: [
      { process: 'Weixin', title: '微信' },
      { process: 'wps', title: '周报.docx - WPS Office' },
    ],
  };
  assert.equal(speakReason(prev, cur).reason, '窗口有变化');
});

test('窗口枚举顺序变了不算变化（比的是集合指纹）', () => {
  const a: AwarenessSample = {
    at: 0,
    windows: [
      { process: 'wps', title: '周报.docx - WPS Office' },
      { process: 'Weixin', title: '微信' },
    ],
  };
  const b: AwarenessSample = {
    at: 300_000,
    windows: [
      { process: 'Weixin', title: '微信' },
      { process: 'wps', title: '周报.docx - WPS Office' },
    ],
  };
  assert.equal(speakReason(a, b).speak, false);
});

test('噪声进程（输入法/UWP 外壳）不该被挑出来说', () => {
  const list = [
    { process: 'TextInputHost', title: 'Microsoft Text Input Application' },
    { process: 'ApplicationFrameHost', title: 'Microsoft Store' },
    { process: 'Weixin', title: '微信' },
  ];
  assert.deepEqual(pickNotableWindows(list, 2), [{ process: 'Weixin', title: '微信' }]);
});

test('标题里带文件名（.docx 等）也算"在干活"，优先于聊天软件', () => {
  const list = [
    { process: 'Weixin', title: '微信' },
    { process: 'someapp', title: '周报.docx - 某编辑器' },
  ];
  assert.equal(pickNotableWindows(list, 1)[0].title, '周报.docx - 某编辑器');
});

test('什么都没变就不说话', () => {
  const prev: AwarenessSample = { at: 0, idleSec: 2, browser: { title: 'a', url: 'https://a.com/1' }, windowTitle: 'W' };
  const same: AwarenessSample = { at: 300_000, idleSec: 4, browser: prev.browser, windowTitle: 'W' };
  assert.equal(speakReason(prev, same).speak, false);
});
