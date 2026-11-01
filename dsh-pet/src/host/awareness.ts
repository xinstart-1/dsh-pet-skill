/**
 * 环境感知：宠物「看到」用户此刻在干嘛。
 *
 * 分两条腿，因为能力和隐私等级完全不同：
 * - **浏览器**：走 CDP 读专用浏览器当前标签的标题 / 网址。纯 HTTP，没有原生依赖，最便宜；
 * - **桌面**：窗口标题 / 键鼠活跃 / 屏幕截图。需要 Electron helper（`runtime/electron-helper`）或
 *   PowerShell P/Invoke，都要碰原生接口，且截图会带上屏幕上的**一切**（密码、聊天、文档）。
 *
 * 三条硬规矩（写进代码而不是写在文档里）：
 * 1. **默认全关**：`enabled` 为 false 时这一整个模块不采集、不注入、不说话；
 * 2. **只读元数据**：浏览器这条只读 title/url，绝不读页面内容；桌面那条在开关关闭时连窗口标题都不读；
 * 3. **不落盘**：快照只在内存里活一拍，供提示词现用；日志里只写"采到了/没采到"，不写窗口标题原文。
 *
 * 这个文件里凡是纯函数（pick / format / speakReason）都不碰 IO，可以完全离线单测；
 * 只有 `collectBrowser` 发一次 HTTP。
 *
 * @module dsh-pet/src/host/awareness
 */

/** 一条环境快照。字段都可缺：某个源没开、或采不到，就不填。 */
export interface AwarenessSample {
  /** 采样时刻（ms） */
  at: number;
  /** 专用浏览器当前标签 */
  browser?: { title: string; url: string };
  /** 前台窗口标题（桌面侧，需 helper 支持） */
  windowTitle?: string;
  /** 前台窗口进程名（桌面侧） */
  windowProcess?: string;
  /** 键鼠空闲秒数（桌面侧） */
  idleSec?: number;
  /** 桌面上开着的窗口（进程名 + 标题；标题里常带文件名） */
  windows?: WindowInfo[];
}

/** CDP `/json/list` 里我们关心的字段。 */
export interface BrowserTarget {
  type?: string;
  title?: string;
  url?: string;
}

/**
 * 从"带可见性标记"的页面里挑出用户真正在看的那个。
 *
 * 为什么需要这一步：CDP 的标签列表**顺序不代表视线**（实测同时开着创作者中心和推荐页时，
 * 列表第一个是创作者中心）。唯一可靠的信号是页面自己的 `document.visibilityState`——
 * 只有当前激活的那个标签是 `visible`。
 * @param pages 带 visible 标记的页面
 * @returns 可见页（都不亮返回 null，交给启发式兜底）
 */
export function pickByVisibility(
  pages: readonly { title: string; url: string; visible: boolean }[],
): { title: string; url: string } | null {
  const hit = (Array.isArray(pages) ? pages : []).find((p) => p?.visible === true && /^https?:/i.test(String(p.url ?? '')));
  return hit === undefined ? null : { title: String(hit.title ?? '').trim(), url: String(hit.url ?? '').trim() };
}

/**
 * 从 CDP 的标签页列表里挑出"用户正在看的那个"（**兜底用**，优先用 pickByVisibility）。
 *
 * 取舍：优先挑抖音页（本插件场景），否则取第一个 http(s) 页面；一个都没有就返回 null。
 * 这条规则不懂"视线"，只在读不到 visibilityState 时用。
 * @param targets CDP 返回的 target 列表
 * @param preferHost 优先匹配的域名片段（默认 douyin.com）
 * @returns 选中的页面（无可用返回 null）
 */
export function pickActivePage(
  targets: readonly BrowserTarget[],
  preferHost = 'douyin.com',
): { title: string; url: string } | null {
  const pages = (Array.isArray(targets) ? targets : []).filter(
    (t) => t?.type === 'page' && typeof t.url === 'string' && /^https?:/i.test(t.url),
  );
  if (pages.length === 0) return null;
  const hit = pages.find((t) => String(t.url).includes(preferHost)) ?? pages[0];
  return { title: String(hit?.title ?? '').trim(), url: String(hit?.url ?? '').trim() };
}

/** 单个页面问一次 `document.visibilityState`；失败返回 null（不抛、不拖慢整体）。 */
async function pageVisibility(wsUrl: string, timeoutMs: number): Promise<boolean | null> {
  if (!/^wss?:\/\//i.test(wsUrl)) return null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean | null): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* 关不掉就算了 */
      }
      resolve(v);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => done(null), timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: 'document.visibilityState', returnByValue: true },
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(String(ev.data)) as { result?: { result?: { value?: unknown } } };
        done(msg.result?.result?.value === 'visible');
      } catch {
        done(null);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

/**
 * 读专用浏览器当前标签（只读标题与网址，不碰页面内容）。
 *
 * 先按 `document.visibilityState` 找真正激活的标签（最多问 4 个，每个 800ms 上限），
 * 问不到再退回顺序启发式——宁可给一个"大概是这个"，也不因为一个页面卡住而整条采集失败。
 * @param port CDP 调试端口
 * @param timeoutMs 列表请求超时
 * @param preferHost 兜底时的优先域名
 * @returns 页面信息；连不上或没有页面时返回 null（不抛）
 */
export async function collectBrowser(
  port: number,
  timeoutMs = 2500,
  preferHost = 'douyin.com',
): Promise<{ title: string; url: string } | null> {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${p}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const targets = (await res.json()) as (BrowserTarget & { webSocketDebuggerUrl?: string })[];
    const pages = targets.filter((t) => t?.type === 'page' && /^https?:/i.test(String(t.url ?? ''))).slice(0, 4);

    const flags: { title: string; url: string; visible: boolean }[] = [];
    for (const page of pages) {
      const visible = await pageVisibility(String(page.webSocketDebuggerUrl ?? ''), 800);
      if (visible !== null) flags.push({ title: String(page.title ?? ''), url: String(page.url ?? ''), visible });
    }
    return pickByVisibility(flags) ?? pickActivePage(targets, preferHost);
  } catch {
    return null;
  }
}

/**
 * 把快照翻成给模型看的一句话（塞进 system 的**动态段**，不进人设）。
 *
 * 宁可少说也不编：没采到的源直接不提；全都没采到就返回空串，调用方据此不加这一行。
 * @param sample 快照
 * @returns 一句中文（可能为空串）
 */
export function formatAwareness(sample: AwarenessSample | null | undefined): string {
  if (!sample) return '';
  const bits: string[] = [];
  const win = String(sample.windowTitle ?? '').trim();
  const proc = String(sample.windowProcess ?? '').trim();
  if (win !== '' || proc !== '') {
    const where = win === '' ? proc : proc === '' ? `「${win}」` : `「${win}」（${proc}）`;
    bits.push(`主人现在在用的窗口是${where}`);
  }
  const url = String(sample.browser?.url ?? '').trim();
  if (url !== '') {
    const title = String(sample.browser?.title ?? '').trim();
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return '';
      }
    })();
    bits.push(title === '' ? `浏览器开着 ${host || '某个页面'}` : `浏览器里在看「${title}」`);
  }
  const idle = Number(sample.idleSec);
  if (Number.isFinite(idle) && idle >= 0) {
    if (idle >= 1800) bits.push('而且已经半个多小时没动键鼠了，可能不在电脑前');
    else if (idle >= 300) bits.push(`有 ${Math.round(idle / 60)} 分钟没动键鼠`);
    else bits.push('正在电脑前');
  }
  // 桌面窗口：优先"在干活"的那几个（写作/编码/设计），比"还开着微信"贴场景得多
  const windowLine = describeWindows(sample.windows ?? []);
  if (windowLine !== '') bits.push(windowLine);
  if (bits.length === 0) return '';
  return `（你现在能看到这些：${bits.join('；')}。只用来让搭话贴合场景，不要复述给主人听。）`;
}

/** 开口判断的入参。 */
export interface SpeakOptions {
  /** 同一页面盯多久算"太久了"（秒），0 = 不提醒 */
  stallSec?: number;
  /** 离开多久算"走开了"（秒） */
  awaySec?: number;
}

/** 开口判断的结论。 */
export interface SpeakDecision {
  speak: boolean;
  /** 为什么说（写日志用，不念给用户） */
  reason: string;
}

const pageKey = (s?: { title: string; url: string }): string =>
  s === undefined || s.url === '' ? '' : `${s.url.split('?')[0]}|${s.title}`;

/**
 * 窗口集合的指纹：排序后拼起来，用于判断"桌面上的窗口变了没"。
 *
 * 必须用集合而不是"当前窗口"：我们拿不到焦点，只有列表；打开 WPS 的表现就是
 * 列表里多了一项。排序是为了让枚举顺序变化不被误判成"换了窗口"。
 */
const windowsKey = (list?: readonly WindowInfo[]): string =>
  (Array.isArray(list) ? list : [])
    .map((w) => `${w.process}|${w.title}`)
    .sort()
    .join('\n');

/** 办公软件识别：进程名或窗口标题里命中就算"在干正事"。顺序即优先级（先认更具体的）。 */
const OFFICE_PATTERNS: Array<[RegExp, string]> = [
  [/wps|kingsoft/i, 'WPS'],
  [/winword|\bword\b/i, 'Word'],
  [/excel/i, 'Excel'],
  [/powerpoint|\bppt\b/i, 'PowerPoint'],
  [/pages|numbers|keynote/i, 'iWork'],
  [/notion|语雀|yuque|飞书|feishu/i, '文档工具'],
];

/**
 * 认出"现在在用什么办公软件"。
 *
 * 只看窗口标题与进程名——**不读文档内容**。WPS / Word 的标题栏通常就是文件名，
 * 所以模型能知道"在写什么文件"，但不知道里面写了什么（要看内容得开截图，那是另一个开关）。
 * @param sample 快照
 * @returns 命中的软件名；没命中返回空串
 */
export function officeAppOf(sample: AwarenessSample | null | undefined): string {
  if (!sample) return '';
  const hay = `${String(sample.windowTitle ?? '')} ${String(sample.windowProcess ?? '')}`;
  for (const [re, name] of OFFICE_PATTERNS) if (re.test(hay)) return name;
  return '';
}

/** 深夜办公的判定结果。 */
export interface OfficeNightHit {
  /** 是否"深夜 + 办公软件" */
  hit: boolean;
  /** 命中的软件名 */
  app: string;
  /** 去重键：同一份文档不重复念叨 */
  key: string;
  /** 给模型看的由头（人话，不暴露"我在看你屏幕"） */
  hint: string;
}

/**
 * 判断"是不是深夜还在办公"。
 *
 * 这是用户要的那个场景：晚上十点多打开 WPS/Office → 主动说一句体贴的话。
 * 深夜窗口默认 22:00–06:00（跨零点要按"或"判断，不能用 from < h < to）。
 * @param sample 快照
 * @param now 当前时间（调用方传入，便于测试）
 * @param opts 深夜窗口
 * @returns 判定结果（未命中时 hit=false，其余字段为空）
 */
export function officeAtNight(
  sample: AwarenessSample | null | undefined,
  now: Date,
  opts: { fromHour?: number; toHour?: number } = {},
): OfficeNightHit {
  const miss: OfficeNightHit = { hit: false, app: '', key: '', hint: '' };
  const app = officeAppOf(sample);
  if (app === '') return miss;
  const h = now.getHours();
  if (!Number.isFinite(h)) return miss;
  const from = Number.isFinite(opts.fromHour) ? Number(opts.fromHour) : 22;
  const to = Number.isFinite(opts.toHour) ? Number(opts.toHour) : 6;
  const isNight = from > to ? h >= from || h < to : h >= from && h < to;
  if (!isNight) return miss;

  const title = String(sample?.windowTitle ?? '').trim();
  const hhmm = `${String(h).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const hint =
    `现在是 ${hhmm}，主人这会儿还在用 ${app}` +
    (title === '' ? '忙' : `，窗口是「${title}」`) +
    '。可以说一句体贴的话（一句、20 字以内）；不要追问在做什么，也不要提你看到了他的屏幕。';
  return { hit: true, app, key: `${app}|${title}`, hint };
}

/** 一条窗口信息。 */
export interface WindowInfo {
  /** 进程名（`wps` / `winword` / `code` …） */
  process: string;
  /** 窗口标题（`周报.docx - WPS Office`；常含文件名） */
  title: string;
}

/** 执行外部命令的注入点（默认 spawn powershell；测试传假实现，就能离线验解析）。 */
export type Runner = (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string }>;

/**
 * 读当前所有"有窗口"的进程标题（**Windows**）。
 *
 * 为什么用 `Get-Process` 而不是 Win32 前台窗口 API：`MainWindowTitle` 不需要编译 .NET
 * （`Add-Type` 在本项目的运行环境里不可用），一条内联命令就能拿到"开着什么、文件名是什么"，
 * 足以支撑"晚上十点你还在写周报"这种关心。代价是**拿不到焦点在哪个窗口**——
 * 只知道开着，不知道正对着哪个。
 * @param run 命令执行器
 * @param timeoutMs 超时
 * @returns 窗口列表（失败返回空数组，不抛）
 */
export async function collectWindows(run: Runner, timeoutMs = 6000): Promise<WindowInfo[]> {
  if (process.platform !== 'win32') return [];
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName)`t$($_.MainWindowTitle)" }';
  try {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs);
    if (r.code !== 0 || r.stdout.trim() === '') return [];
    const out: WindowInfo[] = [];
    const seen = new Set<string>();
    for (const line of r.stdout.split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const proc = line.slice(0, tab).trim();
      const title = line.slice(tab + 1).trim();
      if (proc === '' || title === '') continue;
      const key = `${proc}|${title}`;
      if (seen.has(key)) continue; // 同一进程多个同名窗口（多开）只留一条
      seen.add(key);
      out.push({ process: proc, title });
    }
    return out;
  } catch {
    return [];
  }
}

/** 常见"在干活"的进程名（小写匹配用）。命中就优先播报，比"还开着微信"更贴场景。 */
const WORK_PROCESSES = [
  'wps',
  'et',
  'wpp',
  'winword',
  'excel',
  'powerpnt',
  'outlook',
  'onenote',
  'code',
  'cursor',
  'webstorm',
  'idea64',
  'pycharm64',
  'devenv',
  'photoshop',
  'illustrator',
  'figma',
  'notion',
  'obsidian',
  'typora',
];

/**
 * 永远不值得播报的进程：输入法、UWP 外壳、开始菜单这一类。
 * 它们也有 `MainWindowTitle`，不滤掉的话"优先挑"会挑到「Microsoft Text Input Application」。
 */
const NOISE_PROCESSES = new Set([
  'textinputhost',
  'applicationframehost',
  'shellexperiencehost',
  'searchhost',
  'startmenuexperiencehost',
  'lockapp',
  'systemsettings',
  'dwм',
]);

/** 标题里出现"文件名 + 扩展名"时，说明这是个正在编辑的文档，价值等同工作类进程。 */
const FILE_LIKE = /\.(docx?|xlsx?|pptx?|pdf|md|markdown|txt|csv|py|ts|tsx|js|json|ya?ml|psd|ai|fig|sketch)\b/i;

/**
 * 从窗口列表里挑出最值得说的几条。
 *
 * 打分而不是只按顺序：聊天软件/播放器不该抢在"周报.docx"前面，输入法这类噪声直接丢掉。
 * 分数相同保持原顺序（稳定排序），避免同一份列表每次挑出不同结果。
 * @param windows 窗口列表
 * @param max 最多几条
 * @returns 挑选结果
 */
export function pickNotableWindows(windows: readonly WindowInfo[], max = 2): WindowInfo[] {
  const scored: { w: WindowInfo; score: number; i: number }[] = [];
  (Array.isArray(windows) ? windows : []).forEach((w, i) => {
    const title = String(w?.title ?? '').trim();
    const proc = String(w?.process ?? '').trim();
    if (title === '' || proc === '') return;
    const lower = proc.toLowerCase();
    if (NOISE_PROCESSES.has(lower)) return;
    const score = WORK_PROCESSES.includes(lower) || FILE_LIKE.test(title) ? 2 : 1;
    scored.push({ w: { process: proc, title }, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, Math.max(1, max)).map((x) => x.w);
}

/**
 * 把采样到的窗口拼成人话（给 formatAwareness 用）。
 * @param windows 窗口列表
 * @returns 一句；没有可说的返回空串
 */
export function describeWindows(windows: readonly WindowInfo[]): string {
  const picked = pickNotableWindows(windows, 2);
  if (picked.length === 0) return '';
  const parts = picked.map((w) => {
    const title = String(w.title ?? '').trim();
    const proc = String(w.process ?? '').trim();
    // 标题里通常已经带应用名（`周报.docx - WPS Office`），不再重复括注进程
    return /office|wps|word|excel|powerpoint/i.test(title) || proc === '' ? `「${title}」` : `「${title}」（${proc}）`;
  });
  return `桌面上开着${parts.join('、')}`;
}

/** 最近一拍快照（模块级缓存，只活这一拍，不落盘）。 */let lastSample: AwarenessSample | null = null;

/** 记下这一拍的快照（采集循环调用；传 null 表示清空）。 */
export function rememberAwareness(sample: AwarenessSample | null): void {
  lastSample = sample;
}

/** 取最近一拍快照（可能为 null：没开、或还没采过）。 */
export function lastAwareness(): AwarenessSample | null {
  return lastSample;
}

/** 给提示词用的那一句（没开/没采到 → 空串，调用方据此不加这一行）。 */
export function awarenessText(): string {
  return formatAwareness(lastSample);
}

/** 采集入参。 */
export interface CollectOptions {
  /** 总开关；false 时直接返回 null，一个源都不碰 */
  enabled: boolean;
  /** 是否读专用浏览器当前标签 */
  browser: boolean;
  /** CDP 端口 */
  port: number;
  /** 桌面探针：返回窗口列表。不传 = 不采桌面 */
  desktop?: () => Promise<WindowInfo[]>;
}

/**
 * 采一拍：先浏览器，再桌面（若有探针）。
 *
 * 任何一路失败都只是"这拍少一个信号"，不抛错——感知不该把别的功能带崩。
 * @param opts 采集选项
 * @returns 快照；总开关关着、或什么都没采到，返回 null
 */
export async function collectAwareness(opts: CollectOptions): Promise<AwarenessSample | null> {
  if (opts?.enabled !== true) return null;
  const sample: AwarenessSample = { at: Date.now() };
  if (opts.browser === true) {
    const page = await collectBrowser(opts.port).catch(() => null);
    if (page !== null) sample.browser = page;
  }
  if (typeof opts.desktop === 'function') {
    const list = await opts.desktop().catch(() => []);
    if (Array.isArray(list) && list.length > 0) sample.windows = list;
  }
  const hasAny =
    sample.browser !== undefined || sample.windows !== undefined || sample.windowTitle !== undefined || sample.idleSec !== undefined;
  return hasAny ? sample : null;
}

/**
 * 定时采样后判断"这一拍值不值得开口"。
 *
 * 为什么不是"定时就说"：用户明确反感插件刷存在感。所以定时**采样**、事件**触发**：
 * - 首次采样只记录不开口（否则一开机就冒一句）；
 * - 页面换了 / 窗口换了 → 开口（这是真正的"你切走了"）；
 * - 同一个页面盯太久 → 只提醒一次（同一 pageKey 不重复）；
 * - 离开很久后回来 → 开口一次。
 * @param prev 上一拍快照（首次传 null）
 * @param cur 这一拍快照
 * @param opts 阈值
 * @returns 结论
 */
export function speakReason(
  prev: AwarenessSample | null,
  cur: AwarenessSample,
  opts: SpeakOptions = {},
): SpeakDecision {
  const stallSec = Number(opts.stallSec ?? 1800);
  const awaySec = Number(opts.awaySec ?? 900);
  if (prev === null) return { speak: false, reason: '首拍只记录' };

  const prevPage = pageKey(prev.browser);
  const curPage = pageKey(cur.browser);
  const prevTitle = String(prev.windowTitle ?? '').trim();
  const curTitle = String(cur.windowTitle ?? '').trim();

  // 走开又回来：idle 从"很久"回落到"刚动过"
  const prevIdle = Number(prev.idleSec);
  const curIdle = Number(cur.idleSec);
  if (Number.isFinite(prevIdle) && Number.isFinite(curIdle) && prevIdle >= awaySec && curIdle < 120) {
    return { speak: true, reason: '离开后回来' };
  }

  if (curPage !== '' && prevPage !== '' && curPage !== prevPage) {
    return { speak: true, reason: '换了页面' };
  }
  // 桌面窗口集合变了（例如刚打开 WPS/Office）——"晚上十点还在写东西"那类搭话的触发点。
  // 比的是集合指纹：我们拿不到焦点，只能看"开着的东西变了没"。
  const prevWinKey = windowsKey(prev.windows);
  const curWinKey = windowsKey(cur.windows);
  if (curWinKey !== '' && prevWinKey !== '' && curWinKey !== prevWinKey) {
    return { speak: true, reason: '窗口有变化' };
  }
  // 单窗口字段（旧数据/其他平台）仍按原样比较
  if (prevTitle !== '' && curTitle !== '' && prevTitle !== curTitle) {
    return { speak: true, reason: '换了窗口' };
  }

  // 盯同一个页面太久：只在跨过阈值的那一拍说一次
  if (stallSec > 0 && curPage !== '' && curPage === prevPage) {
    const watchedSec = (cur.at - prev.at) / 1000;
    if (watchedSec >= stallSec) return { speak: true, reason: `同一页面已盯 ${Math.round(watchedSec / 60)} 分钟` };
  }

  return { speak: false, reason: '没变化' };
}
