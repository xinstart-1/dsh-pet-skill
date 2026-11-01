/**
 * 菜单事件解析 —— 这条是拿真机崩溃换来的测试。
 *
 * 现场：dsh-pet 对"owner 没注册"回的是 HTTP 200 + `{ok:false, reason, message}`，
 * 上一版把 body 顶层当事件表遍历，于是 `reason`/`message` 变成了"被点击的菜单项"、
 * `unknown-owner` 变成了宠物 id，循环不退避地空转，最终把宿主堆内存打爆。
 *
 * 所以这里把"什么才算一次真点击"钉死：形状不对一律不认，label 必须在白名单里。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isBusinessOk, parseMenuEvents } from './pet-bridge.js';

test('业务失败（HTTP 200 + ok:false）绝不能被当成点击', () => {
  const payload = { ok: false, reason: 'unknown-owner', message: '这个 owner 没有注册，重新注册即可' };
  const r = parseMenuEvents(payload, ['分享到抖音']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.hits, []);
  assert.equal(r.reason, 'unknown-owner');
});

test('成功但没人点：events 里全是 null', () => {
  const r = parseMenuEvents({ ok: true, events: { 分享到抖音: null } }, ['分享到抖音']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.hits, []);
});

test('真点击：events 里是字符串 petId', () => {
  const r = parseMenuEvents({ ok: true, events: { 分享到抖音: 'main' } }, ['分享到抖音']);
  assert.deepEqual(r.hits, [{ label: '分享到抖音', pet: 'main' }]);
});

test('不在白名单的 label 一律丢弃（别人 owner 的项、误解析出的键）', () => {
  const r = parseMenuEvents({ ok: true, events: { reason: 'unknown-owner', message: 'xxx', 分享到抖音: 'main' } }, ['分享到抖音']);
  assert.deepEqual(r.hits, [{ label: '分享到抖音', pet: 'main' }]);
});

test('petId 必须是像样的字符串：数字/超长/空白都丢', () => {
  const allow = ['a', 'b', 'c'];
  const r = parseMenuEvents({ ok: true, events: { a: 123, b: 'x'.repeat(65), c: '   ' } }, allow);
  assert.deepEqual(r.hits, []);
});

test('形状不对：没有 events / 是数组 / 是字符串 → bad-shape', () => {
  assert.equal(parseMenuEvents({ ok: true }, ['a']).reason, 'bad-shape');
  assert.equal(parseMenuEvents({ ok: true, events: [] }, ['a']).reason, 'bad-shape');
  assert.equal(parseMenuEvents('oops', ['a']).reason, 'bad-shape');
  assert.equal(parseMenuEvents(null, ['a']).reason, 'bad-shape');
});

test('isBusinessOk：只看 body 的 ok，不只看 HTTP', () => {
  assert.equal(isBusinessOk({ ok: true, status: 200, data: { ok: true } }), true);
  assert.equal(isBusinessOk({ ok: true, status: 200, data: { ok: false, reason: 'x' } }), false);
  assert.equal(isBusinessOk({ ok: true, status: 200, data: { lockId: 'L1' } }), true);
  assert.equal(isBusinessOk({ ok: true, status: 200 }), true, '无 body 按 HTTP 算');
  assert.equal(isBusinessOk({ ok: false, status: 500 }), false);
});
