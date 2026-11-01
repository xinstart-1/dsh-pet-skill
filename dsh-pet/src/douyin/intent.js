/**
 * 一句话 → 结构化动作。
 *
 * 为什么要单独一个纯函数：这是整条"宠物听懂人话"链路里唯一有歧义的部分。
 * 把它和 IO 隔开，就能用几十条真实说法把边界钉死，而不是等线上把一个叫
 * 「给我发消息的星⭐心」的账号名截错才发现。
 *
 * 设计原则：
 * 1. **宁可问，不要猜**。识别不出收件人就返回 `needs`，让上层追问，绝不默认发给谁。
 * 2. **不把用户说的话改写**。content 原样保留（只去首尾空白），表情符号、换行都不动。
 * 3. **动作只有六个**，且都是插件真实具备的能力；不认识就 `help`，不硬凑。
 *    `reply` 与 `dm` 的区别：reply 会先读会话里的最新入站消息（引用着回），
 *    不带正文时由上层让大模型现写；dm 是"凭空发一条"。
 *
 * @module dsh-pet-douyin/intent
 */

/** 支持的动作 */
export const INTENT_ACTIONS = /** @type {const} */ (['dm', 'reply', 'chats', 'browse', 'publish', 'help']);

/** 寒暄前缀：出现就剥掉，剥不动就算了 */
const POLITE_RE = /^(?:请|麻烦|劳驾|帮我|帮忙|你帮我|替我|给我|能不能|可不可以|可以)+/;

/**
 * 句尾语气词与标点。
 * 只剥末尾——剥中间会把名字和环境弄坏（「给阿呢发消息」里的"呢"不能动）。
 */
const TAIL_RE = /[。！!？?~～…吧啊呀哦啦哈嘛]+$/;

/** 收件人外面可能带的引号 */
const QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
  ['\'', '\''],
  ['《', '》'],
];

/**
 * 去掉包装：礼貌前缀、句尾标点、收件人的引号。
 * @param {string} name 原始收件人
 * @returns {string} 干净的名字
 */
function cleanName(name) {
  let out = String(name ?? '').trim();
  for (const [l, r] of QUOTE_PAIRS) {
    if (out.startsWith(l) && out.endsWith(r) && out.length > l.length + r.length) {
      out = out.slice(l.length, out.length - r.length).trim();
    }
  }
  return out;
}

/**
 * 正文清理：只做"去掉引导词"，不动内容本身。
 * @param {string} text 原始正文
 * @returns {string} 正文
 */
function cleanTopic(text) {
  return String(text ?? '')
    .replace(/^[\s：:,，\-—]+/, '')
    .replace(/^(?:说|内容是|内容|告诉他|告诉她|说道)\s*[：:,，]?\s*/, '')
    .trim();
}

/**
 * 带正文的说法。顺序即优先级——越具体的排越前，避免被宽松规则截错。
 * 每个模板的 `name` 字段只用于排障时看是哪条规则命中。
 */
const WITH_TOPIC = [
  // 给星⭐心发一条消息：内容
  { name: '给X发消息', re: /^给\s*(.+?)\s*(?:发|发一?条|发一?个|发条)\s*(?:消息|私信|信息)?\s*[：:,，]\s*([\s\S]+)$/ },
  // 给星⭐心发一条消息 内容（无标点，正文里带"说"）
  { name: '给X发消息说…', re: /^给\s*(.+?)\s*(?:发|发一?条|发一?个|发条)\s*(?:消息|私信|信息)\s*(?:说|内容是|内容为)\s*([\s\S]+)$/ },
  // 发消息给星⭐心：内容
  { name: '发消息给X', re: /^发\s*(?:一?条|一?个)?\s*(?:消息|私信)\s*给\s*(.+?)\s*[：:,，]\s*([\s\S]+)$/ },
  // 私信星⭐心：内容
  { name: '私信X', re: /^私信\s*(.+?)\s*[：:,，]\s*([\s\S]+)$/ },
  // 对星⭐心说：内容
  { name: '对X说', re: /^对\s*(.+?)\s*说\s*[：:,，]?\s*([\s\S]+)$/ },
];

/** 只有收件人、没有正文的说法。 */
const NAME_ONLY = [
  { name: '给X发消息', re: /^给\s*(.+?)\s*(?:发|发一?条|发一?个|发条)\s*(?:消息|私信|信息)?$/ },
  { name: '发消息给X', re: /^发\s*(?:一?条|一?个)?\s*(?:消息|私信)\s*给\s*(.+?)$/ },
  { name: '私信X', re: /^私信\s*(.+?)$/ },
  { name: '对X说', re: /^对\s*(.+?)\s*说$/ },
];

/**
 * 回复类说法（先于 dm 判定：'回复X'一旦命中就是 reply，不再落回 dm）。
 * reply 的收件人可以空——空表示"回当前打开的那个会话"。
 */
const REPLY_WITH_TOPIC = [
  { name: '回复X', re: /^回(?:复)?\s*(.+?)\s*[：:,，]\s*([\s\S]+)$/ },
];

const REPLY_NAME_ONLY = [{ name: '回复X', re: /^回(?:复)?\s*(.+?)$/ }];

/** 指代"当前会话"的词：单独出现时不当作收件人名字 */
const GENERIC_TARGETS = new Set(['他', '她', '它', '一下', '消息', '个消息', '条消息', '信息']);

/**
 * 解析一句话。
 * @param {string} raw 用户原话
 * @returns {{action: 'dm'|'reply'|'chats'|'browse'|'publish'|'help', to: string, topic: string, needs: string, rule: string, raw: string}} 结果
 */
export function parseIntent(raw) {
  const rawText = String(raw ?? '').trim();
  const base = { action: /** @type {any} */ ('help'), to: '', topic: '', needs: '', rule: '', raw: rawText };
  if (rawText === '') return { ...base, needs: '说点什么' };

  // 剥礼貌前缀与句尾语气词；只影响判定用的文本，不影响 raw
  let text = rawText.replace(POLITE_RE, '').replace(TAIL_RE, '').trim();
  if (text === '') text = rawText;

  // 0) 光杆"回复"：回当前打开的会话
  if (/^回(?:复)?(?:一?下|他|她|它|消息)?$/.test(text)) {
    return { ...base, action: 'reply', to: '', topic: '', rule: '回复当前会话' };
  }

  // 1) 回复X：内容 / 回复X
  for (const { name, re } of REPLY_WITH_TOPIC) {
    const m = re.exec(text);
    if (m === null) continue;
    let to = cleanName(m[1]);
    if (GENERIC_TARGETS.has(to)) to = '';
    if (to === '') return { ...base, action: 'reply', to: '', topic: cleanTopic(m[2]), rule: name };
    return { ...base, action: 'reply', to, topic: cleanTopic(m[2]), rule: name };
  }
  for (const { name, re } of REPLY_NAME_ONLY) {
    const m = re.exec(text);
    if (m === null) continue;
    let to = cleanName(m[1]);
    if (GENERIC_TARGETS.has(to)) to = '';
    return { ...base, action: 'reply', to, topic: '', rule: name };
  }

  for (const { name, re } of WITH_TOPIC) {
    const m = re.exec(text);
    if (m === null) continue;
    const to = cleanName(m[1]);
    const topic = cleanTopic(m[2]);
    if (to === '') break;
    return { ...base, action: 'dm', to, topic, rule: name };
  }

  for (const { name, re } of NAME_ONLY) {
    const m = re.exec(text);
    if (m === null) continue;
    const to = cleanName(m[1]);
    if (to === '') break;
    return { ...base, action: 'dm', to, topic: '', rule: name };
  }

  // 读会话：只要在问"消息/会话/谁找我"，且没识别出收件人
  if (/(消息|会话|聊天|私信)/.test(text) && /(看|读|有|查|谁|什么|多少|没|新)/.test(text)) {
    return { ...base, action: 'chats', rule: '看消息' };
  }

  // 刷推荐流：只说"刷/看 + 抖音/推荐"就算——不必要求说全"刷会儿抖音"
  if (/(刷|翻).{0,3}(抖音|视频|推荐|精选|首页)/.test(text) && !/消息|私信|会话|发布|发视频|素材/.test(text)) {
    return { ...base, action: 'feed', rule: '刷推荐流' };
  }

  if (/(发布包|打包|发布|转码|剪|素材|发视频)/.test(text) && !/消息|私信|会话/.test(text)) {
    return { ...base, action: 'publish', rule: '出发布包' };
  }

  return { ...base, needs: '没听懂。可以说「给星⭐心发条消息：内容」「回复星⭐心：内容」「回复他」（回最新那条）「看看消息」「刷会儿抖音」「出个发布包」' };
}

/**
 * 这句话能不能由插件"接管代劳"，以及接管后先回一句什么。
 *
 * 为什么要单独判定：宠物对话框里的**每一句**话都会先问到这里，所以这个函数必须满足两条：
 * 1. **能完整执行才接管**。参数不全（"给星⭐心发条消息"但没说内容）就别接管——接管了只会让用户
 *    看到"我这就去"然后什么也没发生，还不如让宠物正常闲聊。
 * 2. **回执不承诺结果**。ack 只表示"我去办"，成败由后台执行完自己播报，
 *    否则一句"已发送"会和随后的失败播报自相矛盾。
 *
 * @param {{action: string, to: string, topic: string}} intent parseIntent 的结果
 * @returns {{claimable: boolean, ack: string}} 结论
 */
export function describeClaim(intent) {
  const none = { claimable: false, ack: '' };
  if (intent === null || typeof intent !== 'object') return none;
  const to = typeof intent.to === 'string' ? intent.to : '';
  const topic = typeof intent.topic === 'string' ? intent.topic : '';

  switch (intent.action) {
    case 'dm':
      // 收件人和正文缺一个都不动手：私信发错人/发空话是不可撤销的
      if (to === '' || topic === '') return none;
      return { claimable: true, ack: `收到，这就去跟「${to}」说一句。` };
    case 'reply':
      // 光杆"回复"= 回当前会话最新一条（读入站消息后再生成），仍然算完整意图
      return { claimable: true, ack: to === '' ? '我看看最新那条，然后回一句。' : `我看看「${to}」说了什么，再回一句。` };
    case 'chats':
      return { claimable: true, ack: '我去翻翻消息。' };
    case 'feed':
      return { claimable: true, ack: '我去刷会儿抖音，看到好的挑给你。' };
    case 'publish':
      return { claimable: true, ack: '我去扫一遍素材，打个发布包。' };
    default:
      return none;
  }
}

/**
 * 支持说法的提示（UI 与命令里复用，避免两处文案漂移）。
 * @returns {Array<{text: string, hint: string}>} 示例
 */
export function intentExamples() {
  return [
    { text: '给星⭐心发条消息：测试一下', hint: '写草稿 + 打开消息页' },
    { text: '回复星⭐心：今晚不行', hint: '读最新入站消息，直接发出去' },
    { text: '回复他', hint: '回当前会话的最新一条（正文由大模型现写）' },
    { text: '看看消息', hint: '列出会话和最后一条' },
    { text: '刷会儿抖音', hint: '刷推荐流，挑几条报给你（不发消息）' },
    { text: '出个发布包', hint: '扫目录、转 9:16、出包' },
  ];
}
