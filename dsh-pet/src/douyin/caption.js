/**
 * 文案：模板变量替换、话题/@ 归一、成品文案拼装。
 *
 * 半自动模式下，文案是**唯一真正被"设置"决定的东西**——可见范围、定时这些抖音
 * 都只认发布页上的手点，所以文案必须做到「全选复制、粘进去就对」：
 * `文案.txt` 里只有文案本身，不带任何说明性文字。
 *
 * @module dsh-pet-douyin/caption
 */
import { fmtDuration } from './util.js';

/** 抖音作品描述的长度上限（超出会被发布页截断） */
export const CAPTION_MAX = 1000;

/** 标题建议长度（超过会在发布页显示为折行，不算错） */
export const TITLE_SOFT_MAX = 30;

/** 可见范围 → 中文说明（半自动模式下这是给人看的提醒） */
export const VISIBILITY_LABEL = {
  public: '公开',
  friends: '好友可见',
  private: '仅自己',
};

/**
 * 模板变量表。
 *
 * | 变量 | 含义 |
 * | --- | --- |
 * | `{name}` | 文件名（不含扩展名） |
 * | `{date}` | 视频修改日期 `YYYY-MM-DD` |
 * | `{time}` | 视频修改时间 `HH:mm` |
 * | `{index}` | 今天第几条（从 1 开始） |
 * | `{total}` | 历史累计第几条 |
 * | `{duration}` | 时长 `mm:ss` |
 * | `{dir}` | 所在目录名 |
 * @param {{name: string, mtime: Date, index: number, total: number, durationSec: number, dir: string}} ctx 变量来源
 * @returns {Record<string, string>} 变量表
 */
export function templateVars(ctx) {
  const p = (n) => String(n).padStart(2, '0');
  const d = ctx.mtime instanceof Date && !Number.isNaN(ctx.mtime.getTime()) ? ctx.mtime : new Date();
  return {
    name: ctx.name,
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    index: String(ctx.index),
    total: String(ctx.total),
    duration: fmtDuration(ctx.durationSec),
    dir: ctx.dir,
  };
}

/**
 * 渲染一个模板：把 `{var}` 换成值，未知变量原样保留并记一条告警。
 * @param {string} template 模板字符串
 * @param {Record<string, string>} vars 变量表
 * @param {string[]} [warnings] 告警收集数组
 * @returns {string} 渲染结果（已 trim）
 */
export function renderTemplate(template, vars, warnings) {
  const text = String(template ?? '');
  return text
    .replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, key) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
      warnings?.push(`文案模板里的 {${key}} 不是已知变量（可用：${Object.keys(vars).join(' / ')}）`);
      return whole;
    })
    .trim();
}

/**
 * 拼出最终会被粘贴到抖音发布页的那段文本。
 *
 * 结构固定为：标题 → 正文 → 追加行 → 话题与 @。空行只在有内容时才出现，
 * 免得粘进去一坨空白。
 * @param {object} caption 配置里的 `caption` 段
 * @param {{name: string, mtime: Date, index: number, total: number, durationSec: number, dir: string}} ctx 变量来源
 * @returns {{title: string, desc: string, text: string, tags: string[], mention: string[], visibility: string, warnings: string[]}} 成品文案
 */
export function composeCaption(caption, ctx) {
  const warnings = [];
  const vars = templateVars(ctx);
  const title = renderTemplate(caption.titleTemplate, vars, warnings);
  const desc = renderTemplate(caption.descTemplate, vars, warnings).replace(/\\n/g, '\n');
  const extras = (caption.extraLines ?? []).map((line) => renderTemplate(line, vars, warnings)).filter(Boolean);
  const tags = caption.tags ?? [];
  const mention = caption.mention ?? [];

  const blocks = [title, desc, extras.join('\n'), [...tags, ...mention].join(' ')].filter(
    (block) => typeof block === 'string' && block.trim() !== '',
  );
  let text = blocks.join('\n\n');
  if (text.length > CAPTION_MAX) {
    text = text.slice(0, CAPTION_MAX);
    warnings.push(`文案超过抖音上限 ${CAPTION_MAX} 字，已截断`);
  }
  if (title.length > TITLE_SOFT_MAX) warnings.push(`标题 ${title.length} 字，超过建议的 ${TITLE_SOFT_MAX} 字`);

  return {
    title,
    desc,
    text,
    tags,
    mention,
    visibility: VISIBILITY_LABEL[caption.visibility] ?? '公开',
    warnings,
  };
}
