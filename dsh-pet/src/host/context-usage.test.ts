/**
 * 上下文用量估算的单测：启发式口径、组成合计、窗口兜底三条边界。
 *
 * 为什么值得钉：估算的每一项组成都必须与真实请求同源（petSystemText / imageInstruction），
 * 这里钉住纯函数本身的口径——CJK 与英文的权重、合计、百分比封顶，避免"估算比真实请求还大/还小"
 * 的静默漂移。用 Node 内置 test runner，不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { contextUsageOf, estimateTokens, windowTokensOf, DEFAULT_CONTEXT_WINDOW } from './context-usage.ts';

describe('estimateTokens', () => {
  test('空串 → 0；纯空白按"其他字符"口径也计一点（不是 0）', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('   \n\t') > 0);
  });

  test('纯中文按 0.6 token/字向上取整', () => {
    // 10 个汉字 → 6
    assert.equal(estimateTokens('一二三四五六七八九十'), 6);
    // 1 个汉字 → ceil(0.6) = 1（绝不返回 0，否则"还有人设"这件事会被显示成"没有"）
    assert.equal(estimateTokens('好'), 1);
  });

  test('纯英文按约 4 字符/token 向上取整', () => {
    // 8 个 ASCII 字符 → ceil(8 × 0.25) = 2
    assert.equal(estimateTokens('abcdefgh'), 2);
  });

  test('中文比等长英文估算更大（这是口径的预期，不是 bug）', () => {
    assert.ok(estimateTokens('一二三四五') > estimateTokens('abcde'));
  });
});

describe('windowTokensOf', () => {
  test('配置了合法值 → 原样使用（小数向下取整）', () => {
    assert.equal(windowTokensOf({ contextWindowTokens: 1048576 }), 1048576);
    assert.equal(windowTokensOf({ contextWindowTokens: '262144' }), 262144);
    assert.equal(windowTokensOf({ contextWindowTokens: 100.9 }), 100);
  });

  test('缺失 / 0 / 负数 / 非数字 → 内置默认（占比显示不该因写错的数字报错）', () => {
    assert.equal(windowTokensOf({}), DEFAULT_CONTEXT_WINDOW);
    assert.equal(windowTokensOf({ contextWindowTokens: 0 }), DEFAULT_CONTEXT_WINDOW);
    assert.equal(windowTokensOf({ contextWindowTokens: -5 }), DEFAULT_CONTEXT_WINDOW);
    assert.equal(windowTokensOf({ contextWindowTokens: 'big' }), DEFAULT_CONTEXT_WINDOW);
  });
});

describe('contextUsageOf', () => {
  const args = { system: '一二三四五', historyTexts: ['一二三四五六七八九十'], perTurnText: 'abcdefgh', window: 1000 };

  test('三项组成各自估算，合计 = 各项之和，百分比 = 合计/窗口', () => {
    const u = contextUsageOf(args);
    assert.deepEqual(
      u.parts.map((p) => p.tokens),
      [3, 6, 2],
    );
    assert.equal(u.total, 11);
    assert.equal(u.percent, 1.1);
  });

  test('perTurnText 缺省 = 本轮开销为 0（纯文本对话）', () => {
    const u = contextUsageOf({ ...args, perTurnText: undefined });
    assert.equal(u.parts[2]?.tokens, 0);
    assert.equal(u.total, 9);
  });

  test('占比封顶 100，不返回 NaN（窗口非法时按 1 兜底）', () => {
    const u = contextUsageOf({ ...args, window: Number.NaN });
    assert.equal(u.percent, 100);
    assert.ok(Number.isFinite(u.percent));
  });
});
