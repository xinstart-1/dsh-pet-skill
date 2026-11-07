/**
 * 阅后即焚的单测：探测顺序、文件兜底、失败收敛三条边界。
 *
 * 为什么值得钉：这是"删掉用户图片"的动作，删错/删不掉都不该静默——探测顺序错了会在宿主以后
 * 正式暴露删除方法时仍去 unlink，失败不收敛会把一次正常对话搞崩。用假 sink + 假 unlink，
 * 完全不碰真实磁盘。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { burnImage } from './image-burn.ts';
import type { PetImageRef } from './image-attachment.ts';

const REF: PetImageRef = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 852, width: 240, height: 120 };

/** 记录调用参数的假 sink。 */
function makeSink(shape: Record<string, unknown>): { sink: Record<string, unknown>; calls: string[] } {
  const calls: string[] = [];
  const sink: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    sink[k] =
      typeof v === 'function'
        ? (...args: unknown[]) => (calls.push(String(k)), (v as (...a: unknown[]) => unknown)(...args))
        : v;
  }
  return { sink, calls };
}

describe('burnImage', () => {
  test('服务上有删除方法 → 优先用服务，不去 unlink', () => {
    const r: PetImageRef[] = [];
    const unlinked: string[] = [];
    const { sink } = makeSink({
      deleteImage: (ref: PetImageRef) => r.push(ref),
      imageHostPath: () => 'C:/x.png',
    });
    const out = burnImage(sink, REF, (p) => unlinked.push(p));
    assert.deepEqual(out, { burned: true, how: 'store-api', detail: 'deleteImage' });
    assert.deepEqual(r, [REF]);
    assert.deepEqual(unlinked, [], '服务删成功时不该再碰文件');
  });

  test('多个方法名同时存在时按 deleteImage → removeImage → … 的顺序取第一个', () => {
    const { sink, calls } = makeSink({
      removeImage: () => undefined,
      deleteImage: () => undefined,
    });
    const out = burnImage(sink, REF);
    assert.equal(out.how, 'store-api');
    assert.deepEqual(calls, ['deleteImage'], '只调用链上第一个存在的方法');
  });

  test('没有删除方法 → 退回 imageHostPath + unlink', () => {
    const unlinked: string[] = [];
    const { sink } = makeSink({ imageHostPath: () => 'C:/tmp/att-1' });
    const out = burnImage(sink, REF, (p) => unlinked.push(p));
    assert.deepEqual(out, { burned: true, how: 'unlink', detail: 'C:/tmp/att-1' });
    assert.deepEqual(unlinked, ['C:/tmp/att-1']);
  });

  test('服务方法抛错 → 收敛成未删除，不抛给调用方', () => {
    const { sink } = makeSink({
      deleteImage: () => {
        throw new Error('boom');
      },
    });
    const out = burnImage(sink, REF);
    assert.equal(out.burned, false);
    assert.equal(out.how, 'store-api');
    assert.match(String(out.detail), /boom/);
  });

  test('unlink 失败 / 取不到路径 / 服务缺失 → 都返回 burned:false 且不抛', () => {
    const unlinkThrow = burnImage(makeSink({ imageHostPath: () => 'C:/tmp/att-1' }).sink, REF, () => {
      throw new Error('EPERM');
    });
    assert.equal(unlinkThrow.burned, false);
    assert.match(String(unlinkThrow.detail), /EPERM/);

    const noPath = burnImage(makeSink({ imageHostPath: () => undefined }).sink, REF);
    assert.equal(noPath.burned, false);
    assert.equal(noPath.how, 'unlink');

    const noSink = burnImage(undefined, REF);
    assert.equal(noSink.burned, false);
    assert.equal(noSink.how, 'unsupported');

    const emptySink = burnImage({}, REF);
    assert.equal(emptySink.burned, false);
    assert.equal(emptySink.how, 'unsupported');
  });
});
