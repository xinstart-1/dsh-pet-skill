/**
 * 「QQ」技能面板：把 QQ 自己的设置页嵌进宠物设置页的一块内容里。
 *
 * 做法与 `douyin-card.ts` 完全一致（同源 iframe + 高度上报），差别只有三处：
 * 地址前缀换成 `/dsh-qq-7342`、消息类型换成 `dsh-qq-height`、标题不同。
 *
 * 为什么不重写成 React：那个页面是围绕"一整页"写的（页签、表单绑定、轮询），
 * 重写等于重做一遍且要重新验证每条链路；视觉融合用 CSS + 高度同步就够。
 *
 * @module dsh-pet/src/client/settings/qq-card
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from './runtime.ts';

/** 高度上下限：太小是渲染中途的抖动，太大会把设置页整页撑爆 */
const MIN_HEIGHT = 400;
const MAX_HEIGHT = 4000;

/**
 * 造「QQ」技能面板。
 * @param rt - 注入的 react 能力
 * @returns 面板组件
 */
export function makeQqSection(rt: SettingsRuntime): FunctionComponent {
  const { h, useState, useEffect } = rt;

  return function QqSection() {
    /** 0 = 还没收到内容高度（首帧先用视口百分比兜着，避免塌成一条线） */
    const [height, setHeight] = useState(0);

    useEffect(() => {
      const onMessage = (event: MessageEvent) => {
        // 只认自己页面发来的（同源），别把别人 postMessage 的高度当真
        if (event.origin !== window.location.origin) return;
        const data = event.data as { type?: string; height?: number } | null;
        if (data?.type !== 'dsh-qq-height' || typeof data.height !== 'number') return;
        setHeight(Math.min(Math.max(data.height, MIN_HEIGHT), MAX_HEIGHT));
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);

    return h('iframe', {
      src: '/dsh-qq-7342/?embed=1',
      title: 'qq',
      style: {
        width: '100%',
        height: height > 0 ? `${height}px` : '72vh',
        border: 'none',
        background: 'transparent',
        display: 'block',
      },
    });
  };
}
