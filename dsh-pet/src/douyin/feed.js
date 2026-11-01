/**
 * 推荐流（全屏竖滑播放器）的单条解析与分享文案拼装。
 *
 * 为什么单独一个纯模块：真实结构几天一变，而**解析规则必须能钉住**——
 * 从 DOM 抓回来的是四个字段的原始文本，怎么翻成"作者 / 描述 / 点赞 / 时长"，
 * 是这个功能最容易悄悄坏掉的地方。这里不碰 CDP、不碰 IO。
 *
 * 实测结构（2026-10-29，douyin.com/?recommend=1，登录态）：
 *   活跃项：[data-e2e="feed-active-video"][data-e2e-vid="7700641193582955810"]
 *   字段都在它的祖先 [data-e2e="feed-item"] 内部：
 *     [data-e2e="feed-video-nickname"] → `@小煜剧场`
 *     [data-e2e="video-desc"]           → 描述（可能多行）
 *     [data-e2e="video-player-digg"]    → `1.4万`
 *   时长在播放器文本里：`00:13 / 00:29`（取斜杠后的总长）
 *
 * **必须限定在活跃项内部取字段**：页面会预渲染 3 条，`document.querySelector`
 * 按文档顺序返回第一条——那多半不是正在播的这条（踩过：vid 一直在变、作者和描述却纹丝不动）。
 *
 * @module dsh-pet-douyin/feed
 */

/** 单条视频地址前缀（用 aweme id 拼，DOM 里没有现成链接） */
export const VIDEO_URL_BASE = 'https://www.douyin.com/video/';

/**
 * 把「万/亿」计数翻成数字（用于挑最热；解析不出来按 0）。
 * @param {string} text 形如 `7.6万` / `415`
 * @returns {number} 数值
 */
export function likesOf(text) {
  const m = /^(\d+(?:\.\d+)?)(万|亿)?$/.exec(String(text ?? '').trim());
  if (m === null) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  if (m[2] === '万') return Math.round(n * 10_000);
  if (m[2] === '亿') return Math.round(n * 100_000_000);
  return Math.round(n);
}

/**
 * 点赞数显示化：接口给的是原始数字（79199），抖音界面显示成「7.9万」。
 * 已经是「万/亿」文本的原样返回（DOM 路子抓到的就是文本）。
 * @param {any} v 原始值
 * @returns {string} 展示文本
 */
export function formatLikes(v) {
  const raw = String(v ?? '').trim();
  if (raw === '' || /[万亿]/.test(raw)) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 10_000) return raw;
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
  return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
}

/**
 * 时长显示化：接口给毫秒（348369），界面上是 `05:48`。
 * @param {any} ms 毫秒
 * @returns {string} `mm:ss`（非法值返回空串）
 */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const total = Math.round(n / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * 把一条原始记录翻成统一条目。缺字段就留空，**不猜**。
 *
 * 三个文本字段的优先级（实测 6/6 条三者都有，但含义不同）：
 * - `title`：`item_title` 优先（结构化标题，如《太公在此》），没有就用 `desc` 第一句
 *   —— 这是播报和分享文案里要用的"一句话标题"，不能塞整段文案（气泡会被撑爆）；
 * - `summary`：`caption` 优先（创作者写的完整文案，含创作说明），没有就用 `desc`
 *   —— 这才是"这条视频讲什么"的来源，UI 详情里展示它。
 *
 * `id` 来自 `aweme_id`（接口）或 `data-e2e-vid`（DOM）；
 * `digg` 可能是原始数字也可能是「1.4万」，都过一遍 formatLikes。
 * @param {{id: string, nick?: string, desc?: string, caption?: string, itemTitle?: string, digg?: string|number, duration?: string|number}} raw 抓到的原始值
 * @returns {{id: string, url: string, title: string, summary: string, author: string, likes: string, likesNum: number, duration: string, date: string}|null} 条目（无 id 返回 null）
 */
export function parseRecommend(raw) {
  const id = String(raw?.id ?? '').trim();
  if (id === '') return null;
  const flat = (v) =>
    String(v ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const author = String(raw?.nick ?? '')
    .replace(/^@+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const desc = flat(raw?.desc);
  const caption = flat(raw?.caption);
  const itemTitle = flat(raw?.itemTitle);
  // 标题只取一句话：结构化标题 → desc 第一个句子（按标点切）
  const title = itemTitle !== '' ? itemTitle : (desc.split(/[。！？!?\n]/)[0] || '').trim();
  const summary = caption !== '' ? caption : desc;
  const likes = formatLikes(raw?.digg);
  // 接口给毫秒数，DOM 给 `04:03`：数字就走 formatDuration，字符串原样
  const rawDur = raw?.duration;
  const duration = typeof rawDur === 'number' ? formatDuration(rawDur) : String(rawDur ?? '').trim();
  return {
    id,
    url: VIDEO_URL_BASE + id,
    title,
    summary,
    author,
    likes,
    likesNum: likesOf(likes),
    duration,
    date: '',
  };
}

/**
 * 批量翻并去重（按 id）。
 *
 * 为什么要去重：翻页瞬间可能读到同一条的两次快照，
 * 或者在视频流里回退——按 id 收才不会把同一条播报两遍。
 * @param {Array<object>} list 原始记录
 * @returns {Array<object>} 条目
 */
export function parseRecommendList(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const item = parseRecommend(raw);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 按点赞降序挑前 n 条（点赞读不出来的排在后面，但仍保留）。
 * @param {Array<object>} items 条目
 * @param {number} n 条数
 * @returns {Array<object>} 挑选结果
 */
export function topByLikes(items, n) {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
  return [...(Array.isArray(items) ? items : [])]
    .sort((a, b) => (b.likesNum ?? 0) - (a.likesNum ?? 0))
    .slice(0, count);
}

/**
 * 拼一条可复制的分享文案：`@作者《标题》 链接`。
 *
 * 话题标签会被剥掉（分享的是一句话 + 链接，点进去本来就带话题）；
 * 标题自带《》时不再套一层（踩过：`《《整容游戏》第一集…》`）。
 * @param {object} item 条目
 * @returns {string} 文案
 */
export function shareTextOf(item) {
  if (!item || typeof item.id !== 'string') return '';
  const who = String(item.author ?? '').trim();
  const title = String(item.title ?? '')
    .replace(/\s*#[^\s#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  const quoted = title === '' ? '' : /^[《「“"]/.test(title) ? title : `《${title}》`;
  const head = [who === '' ? '' : `@${who}`, quoted].filter((s) => s !== '').join(' ');
  return [head === '' ? '抖音视频' : head, item.url ?? VIDEO_URL_BASE + item.id].join(' ');
}

/**
 * 拼给宠物气泡的播报（**要短**：气泡里塞十行没人看）。
 * @param {Array<object>} items 全部条目
 * @param {{max?: number}} [opts] 选项
 * @returns {string} 播报文本
 */
export function digestOf(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return '';
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : 3;
  const picked = topByLikes(list, max);
  const lines = picked.map((it, i) => {
    const who = String(it.author ?? '').trim();
    const title = String(it.title ?? '').replace(/\s*#[^\s#]+/g, '').trim().slice(0, 28);
    const hot = it.likes === '' ? '' : ` · ${it.likes}赞`;
    return `${i + 1}. ${who === '' ? '' : `@${who} `}${title === '' ? '（无描述）' : title}${hot}`;
  });
  const more = list.length > picked.length ? `\n（一共刷到 ${list.length} 条）` : '';
  return `刷了会儿抖音，挑${picked.length}条给你：\n${lines.join('\n')}${more}`;
}
