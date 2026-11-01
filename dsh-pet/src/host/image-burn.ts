/**
 * 图片「阅后即焚」：一次对话生成结束后，把这一轮的用户图片从附件存储里删掉。
 *
 * 为什么需要它：图片必须经宿主附件服务落盘（dsh-llm 的 image block 只认 durable 附件引用，
 * 没有内联 base64 通道），落盘就是一份本机副本——与"我只想让它看一眼"的意图相悖。
 * 记忆里本来只存引用不存像素（见 chat-memory 的注释），所以删掉字节不影响任何历史回放。
 *
 * 为什么不是直接调某个已知方法：宿主附件服务的方法名不是插件侧的公开契约（`image-attachment.ts`
 * 只声明了 saveImages / imageHostPath）。这里按"先问服务、再退文件"的顺序尽力而为：
 * 1) 服务上若存在 delete/remove 类方法 → 用它（将来宿主正式暴露删除时自动生效，不用改这里）；
 * 2) 否则用 `imageHostPath` 拿到绝对路径直接 unlink（文件后端才行，非文件后端拿不到路径）；
 * 3) 都不行 → 明确返回 unsupported，调用方记一行 warn，不假装删掉了。
 *
 * 必须始终成立：不抛异常（删不掉只是隐私优化失败，不该把一次正常对话搞崩）；返回结果可判定。
 * @module dsh-pet/src/host/image-burn
 */
import { unlinkSync } from 'node:fs';
import type { PetImageRef } from './image-attachment.ts';

/** 删除结果：是否真删了、走的哪条路、细节（日志用）。 */
export interface BurnResult {
  /** 是否确实删掉了字节 */
  burned: boolean;
  /** 走的哪条路 */
  how: 'store-api' | 'unlink' | 'unsupported';
  /** 细节：方法名 / 路径 / 失败原因（只进日志，不含图片内容） */
  detail?: string;
}

/** 附件服务上可能存在的删除方法名（按顺序探测；宿主正式暴露哪个就用哪个）。 */
const STORE_APIS = ['deleteImage', 'removeImage', 'deleteAttachment', 'removeAttachment'] as const;

/** 删除一个文件的最小注入点（测试传假实现，避免真碰磁盘）。 */
export type Unlink = (path: string) => void;

/**
 * 尽力删除一张已落盘的对话图片。
 *
 * @param sink - 宿主附件服务（`optionalService('attachments')` 的返回值；可能是 undefined）。
 * @param ref - 这一轮图片的引用。
 * @param unlink - 删文件的实现，默认 `fs.unlinkSync`。
 * @returns 结果；任何异常都被收敛成 `burned: false` + detail。
 */
export function burnImage(sink: unknown, ref: PetImageRef, unlink: Unlink = (p) => unlinkSync(p)): BurnResult {
  if (!sink || typeof sink !== 'object') return { burned: false, how: 'unsupported', detail: '附件服务不可用' };
  const s = sink as Record<string, unknown>;

  for (const name of STORE_APIS) {
    const fn = s[name];
    if (typeof fn !== 'function') continue;
    try {
      (fn as (r: unknown) => unknown).call(sink, ref);
      return { burned: true, how: 'store-api', detail: name };
    } catch (e) {
      // 服务方法存在但调用失败：不再退到 unlink（可能已部分删除，或语义不同），如实报告
      return { burned: false, how: 'store-api', detail: `${name}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const hostPath = s.imageHostPath;
  if (typeof hostPath === 'function') {
    let path: unknown;
    try {
      path = (hostPath as (r: PetImageRef) => unknown).call(sink, ref);
    } catch {
      path = undefined;
    }
    if (typeof path === 'string' && path !== '') {
      try {
        unlink(path);
        return { burned: true, how: 'unlink', detail: path };
      } catch (e) {
        return { burned: false, how: 'unlink', detail: `${path}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    return { burned: false, how: 'unlink', detail: '取不到本地路径（非文件后端？）' };
  }

  return { burned: false, how: 'unsupported', detail: '附件服务没有删除方法，也没有 imageHostPath' };
}
