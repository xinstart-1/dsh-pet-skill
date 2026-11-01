/**
 * 运行状态卡：桌面运行时（Electron）就位 / 下载中 / 失败原因，与一个「重新拉起」按钮。
 *
 * 数据自取自管（`GET /runtime`），不进保存流程；拉取失败整卡不出现——缺状态提示比给错状态更安全。
 * 下载中每 3 秒轮询一次快照（宿主侧下载没有进度百分比可查，只区分「在下载 / 已结束」），
 * 其余状态不轮询，页面常驻零流量。
 * @module dsh-pet/src/client/settings/runtime-card
 */
import type { FunctionComponent } from 'react';
import { loadRuntime, requestElectronRetry, type RuntimeInfo } from './config/http.ts';
import type { SettingsRuntime } from './runtime.ts';
import { MONO_STACK, makeUiKit } from './ui.ts';

/** 下载中时的轮询间隔（毫秒）。 */
const POLL_MS = 3000;

/** 状态点颜色：就绪绿 / 下载中琥珀 / 失败红，跟随主题的语义 token。 */
const DOT_COLORS = {
  ready: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
  downloading: 'var(--dsw-alias-state-warning-primary, #c78a1d)',
  missing: 'var(--dsw-alias-state-error-primary, #d64545)',
} as const;

/** 一行的状态判定：三元不够用（就绪 / 下载中 / 未就位+有失败 / 未就位+从未失败）。 */
type Phase = 'ready' | 'downloading' | 'missing';

/**
 * 造运行状态卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件；数据拉取失败时渲染 null。
 */
export function makeRuntimeCard(rt: SettingsRuntime): FunctionComponent {
  const { h, useState, useEffect, t } = rt;
  const { cardHead } = makeUiKit({ h, t });

  return function RuntimeCard() {
    const [info, setInfo] = useState<RuntimeInfo | null>(null);
    const [btnFailed, setBtnFailed] = useState(false);

    // 拉取与轮询：下载中每 3s 刷一次，其余状态只在挂载时拉一次。
    // 用 info 自身做依赖——下载结束那一次快照会自动把轮询停掉，不需要第二个状态位。
    useEffect(() => {
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = (): void => {
        void loadRuntime().then((next) => {
          if (!alive) return;
          setInfo(next);
          if (next?.electron.downloading) timer = setTimeout(tick, POLL_MS);
        });
      };
      tick();
      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
      };
    }, []);

    // 首拉未回或拉取失败：整卡不出现（与 meta 卡同一策略）。
    if (info === null) return null;

    const phase: Phase = info.electron.ready ? 'ready' : info.electron.downloading ? 'downloading' : 'missing';
    const failed = phase === 'missing' && info.electron.lastError !== null;

    const rows: ReturnType<typeof h>[] = [];
    if (info.inProcess) {
      rows.push(
        h('div', { key: 'ip', className: 'dsh-pet-cfg__note', children: t('runtimeInProcess') }),
      );
    } else {
      rows.push(
        h('div', {
          key: 'electron',
          className: 'dsh-pet-cfg__statusRow',
          children: [
            h('span', {
              key: 'dot',
              className: 'dsh-pet-cfg__dot',
              style: { background: DOT_COLORS[phase] },
              'aria-hidden': 'true',
            }),
            h('span', {
              key: 'text',
              style: { minWidth: 0, overflowWrap: 'anywhere' },
              children: [
                h('b', {
                  key: 'state',
                  style: { fontWeight: 500 },
                  children:
                    phase === 'ready'
                      ? t('runtimeReady')
                      : phase === 'downloading'
                        ? t('runtimeDownloading')
                        : t('runtimeMissing'),
                }),
                // 版本与路径跟在状态后面：等宽、可复制，与路径卡同一观感。
                h('span', {
                  key: 'meta',
                  style: { fontFamily: MONO_STACK, marginLeft: '6px', color: 'var(--dsw-alias-label-tertiary)' },
                  children: 'v' + info.electron.version + (info.electron.path ? ' · ' + info.electron.path : ''),
                }),
              ],
            }),
          ],
        }),
      );
      // 失败原因写在明面：这是「桌面宠物凭空消失」时用户唯一能看到的具体线索。
      if (failed) {
        rows.push(
          h('div', { key: 'err', className: 'dsh-pet-cfg__note', children: t('runtimeLastError') + info.electron.lastError }),
        );
      }
      // 未就位（无论有没有失败过）都给一个动作出口 + 日志指引；下载中按钮没有意义，不渲染。
      if (phase !== 'ready' && phase !== 'downloading') {
        rows.push(
          h('div', {
            key: 'act',
            className: 'dsh-pet-cfg__actions',
            children: [
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-pet-cfg__btn is-primary is-sm',
                  onClick: () => {
                    setBtnFailed(false);
                    void requestElectronRetry().then((sent) => {
                      if (sent) {
                        // 立刻进轮询节奏：不用等 3s，直接拉一次，让「下载中」亮起来。
                        void loadRuntime().then((next) => {
                          if (next !== null) setInfo(next);
                        });
                      } else setBtnFailed(true);
                    });
                  },
                  children: info.electron.lastError !== null ? t('runtimeRetryBtn') : t('runtimeDownloadBtn'),
                },
              ),
              btnFailed ? h('span', { className: 'dsh-pet-cfg__msg is-err', children: t('runtimeBtnFailed') }) : null,
            ],
          }),
        );
      }
    }

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('runtimeTitle'), t('runtimeHint')),
        ...rows,
        // 日志指引只有未就位时才需要；就绪时「高级配置」卡里本来就有完整路径。
        phase === 'missing' && info.logPath
          ? h('div', { key: 'log', className: 'dsh-pet-cfg__note', children: t('runtimeLogNote') + info.logPath })
          : null,
      ],
    });
  };
}
