/**
 * 一键安装的进度解析：安装器输出 → 结构化进度。
 *
 * 这组测试盯的是「进度条不能骗人」：
 * 1. 真实下载行必须解析出准确的百分比（数据取自实机捕获的 227 行原始输出）；
 * 2. 两段下载（QQ 300MB、NapCat 34MB）要折算进一条单调递增的整体进度，不能倒退；
 * 3. 失败信号不能被当成进度吞掉——安装器会卡在 "Press any key"，插件必须能识别失败。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { INSTALL_PHASES, parseInstallLine } from './napcat.js';

test('真实下载行：解析出百分比与已下载量', () => {
  const r = parseInstallLine('下载进度: [=====>                        ] 23% (69MB/300MB)', { phase: 'qq-download' });
  assert.equal(r.phase, 'qq-download');
  assert.equal(r.detail, '69MB/300MB');
  // 23% 落在 QQ 段 [2,55] 内，折算后应在区间里且接近前段
  assert.ok(r.percent > 2 && r.percent < 55, `折算后应在 QQ 段内，实际 ${r.percent}`);
});

test('两段下载都折算进同一条整体进度，且单调不回退', () => {
  let prev = { phase: 'prepare', percent: 0 };
  const seen = [];
  const feed = (line) => {
    const c = parseInstallLine(line, prev);
    if (c) prev = { phase: c.phase ?? prev.phase, percent: c.percent ?? prev.percent };
    if (typeof c?.percent === 'number') seen.push(c.percent);
    return c;
  };
  // 模拟实机顺序：QQ 下载 → 解压 → NapCat 下载 → 解压 → 完成
  feed('[信息] 检查QQ安装包...');
  feed('[信息] 开始下载QQ 9.9.33-52230...');
  for (let p = 0; p <= 100; p += 10) feed(`下载进度: [==>   ] ${p}% (${p}MB/300MB)`);
  feed('[成功] QQ下载成功');
  feed('[信息] 开始下载NapCat ...');
  for (let p = 0; p <= 100; p += 10) feed(`下载进度: [==>   ] ${p}% (${p}MB/34MB)`);
  feed('[成功] NapCat下载成功');
  feed('===== 安装完成 =====');

  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `进度不能倒退：${seen[i - 1]} → ${seen[i]}`);
  }
  assert.equal(seen[seen.length - 1], 100, '最后必须是 100');
  assert.ok(seen.length >= 10, '应解析出足够多的进度点');
});

test('NapCat 段（第二段）的百分比落在高位区间，不与 QQ 段重叠', () => {
  const qq = parseInstallLine('下载进度: [==>   ] 50% (150MB/300MB)', { phase: 'qq-download' });
  const shell = parseInstallLine('下载进度: [==>   ] 50% (17MB/34MB)', { phase: 'shell-download' });
  assert.ok(shell.percent > qq.percent, `第二段应更靠后：qq=${qq.percent} shell=${shell.percent}`);
  const shellSpan = INSTALL_PHASES.find((p) => p.key === 'shell-download');
  assert.ok(shell.percent >= shellSpan.from && shell.percent <= shellSpan.to);
});

test('阶段锚点：解压与完成都有明确阶段', () => {
  assert.equal(parseInstallLine('[成功] QQ下载成功').phase, 'qq-extract');
  assert.equal(parseInstallLine('[成功] NapCat下载成功').phase, 'shell-extract');
  assert.equal(parseInstallLine('===== 安装完成 =====').phase, 'done');
  assert.equal(parseInstallLine('===== 安装完成 =====').percent, 100);
  assert.equal(parseInstallLine('[信息] 开始下载QQ 9.9.33-52230...').phase, 'qq-download');
});

test('失败信号：识别为 detail，不被当成进度吞掉', () => {
  const e1 = parseInstallLine('[错误] 解压NapCat失败，错误码: 2');
  assert.ok(e1 !== null, '失败行必须被识别');
  assert.equal(e1.percent, undefined, '失败行不带百分比');
  assert.match(String(e1.detail), /解压NapCat失败/);

  const e2 = parseInstallLine('[错误] 所有地址均不可用');
  assert.ok(e2 !== null);
  assert.match(String(e2.detail), /所有地址均不可用/);

  const e3 = parseInstallLine('安装包SHA256校验不通过');
  assert.ok(e3 !== null);
});

test('无关行一律返回 null（不污染进度）', () => {
  assert.equal(parseInstallLine(''), null);
  assert.equal(parseInstallLine('   '), null);
  assert.equal(parseInstallLine('7-Zip 19.00 (x64) : Copyright (c) 1999-2018 Igor Pavlov'), null);
  assert.equal(parseInstallLine('Path = QQ.exe'), null);
  assert.equal(parseInstallLine('Physical Size = 314581680'), null);
});
