/**
 * 「抖音」技能面板：把抖音自己的设置页**当作桌宠设置里的一块内容**嵌进来。
 *
 * 它不是左侧的独立分区，而是「桌宠配置」标签行上的一个技能（见 `skills.ts`）。
 *
 * 两条让它"看不出是另一个应用"的措施：
 * 1. iframe 带 `?embed=1`：抖音页在那模式下隐藏自家顶栏的品牌区、把竖排页签改成横向分段、
 *    背景透明（见 `douyin-web/style.css` 末段），视觉上贴住宠物设置页；
 * 2. **高度自适应**：抖音页用 `postMessage` 把内容真实高度报上来，这里据此撑开 iframe。
 *    固定高度要么截断内容、要么留白，都会露馅——这正是"内嵌感"最主要的来源。
 *
 * 为什么还是 iframe 而不是重写成 React：那 3000 行前端是围绕"一整页"写的（页签、
 * 表单绑定、轮询、折叠面板），重写等于重做一遍且要重新验证每条链路；而视觉融合用
 * CSS 覆盖 + 高度同步就能达到同样观感。
 *
 * @module dsh-pet/src/client/settings/douyin-card
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from './runtime.ts';

/** 高度上下限：太小是渲染中途的抖动，太大会把设置页整页撑爆 */
const MIN_HEIGHT = 400;
const MAX_HEIGHT = 4000;

/**
 * 造「抖音」分区。
 * @param rt - 注入的 react 能力
 * @returns 分区组件
 */
export function makeDouyinSection(rt: SettingsRuntime): FunctionComponent {
  const { h, useState, useEffect } = rt;

  return function DouyinSection() {
    /** 0 = 还没收到内容高度（首帧先用视口百分比兜着，避免塌成一条线） */
    const [height, setHeight] = useState(0);

    useEffect(() => {
      const onMessage = (event: MessageEvent) => {
        // 只认自己页面发来的（同源），别把别人 postMessage 的高度当真
        if (event.origin !== window.location.origin) return;
        const data = event.data as { type?: string; height?: number } | null;
        if (data?.type !== 'dsh-douyin-height' || typeof data.height !== 'number') return;
        setHeight(Math.min(Math.max(data.height, MIN_HEIGHT), MAX_HEIGHT));
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);

    return h('iframe', {
      src: '/dsh-douyin-7341/?embed=1',
      title: 'douyin',
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
