/**
 * 熟人名单：把「抖音会话名」翻译成「对面是谁」。
 *
 * 为什么需要：模型这侧只拿到一个 `peer` 字符串（单聊是对方昵称，群聊是群名），
 * 不知道对面是主人还是路过的网友，于是对谁都是同一个口气。名单把名字映射成身份，
 * 拼进 system 的**身份声明**那一段。
 *
 * **这不是人设**：人设真源仍然只有宠物设置页那一份（service.js 的 petPersonaOf），
 * 这里只说「此刻在跟谁说话」，每轮现算、不落盘、也不许写进 whisperPrompt——
 * 一旦写进人设，同一个人就有了两套性格，而且改不了、随时不准。
 *
 * 配置形态是 `web.knownPeers`（string[]，一行一条，设置页用 data-chips-lines 编辑）：
 *   `会话名 | 关系 | 备注`（关系、备注都可省；关系写「主人」/「owner」即标记主人）
 *
 * 纯函数：不读配置、不碰 IO，名单由调用方传进来（可钉单测）。
 *
 * @module dsh-pet-douyin/peers
 */

/** 关系一栏里认作「主人」的写法 */
const OWNER_WORDS = new Set(['主人', 'owner', '自己', '本人']);

/**
 * 规整会话名：剔零宽/控制字符，剥掉群聊成员数后缀「…(3)」。
 *
 * 与 webchan 里读会话头的清洗同源——那边是为了跟会话列表对上，这边是为了跟名单对上，
 * 两处必须用同一套字符判定，否则「看着一样却匹配不上」这种问题极难查。
 * @param {any} v 原始名字
 * @returns {string} 规整后的名字（可能为空串）
 */
export function cleanPeerName(v) {
  const raw = [...String(v ?? '')]
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c > 31 && c !== 0x200b && c !== 0xfeff;
    })
    .join('');
  return raw.replace(/\(\d+\)\s*$/, '').trim();
}

/**
 * 解析名单：一行 → 一条。坏行（没名字）直接丢，不报错也不占位。
 *
 * 同名只留第一条（后写的不会静默覆盖前面的关系，用户写重了很容易发现）。
 * @param {string[]} lines 配置里的原始行
 * @returns {Array<{name: string, relation: string, note: string, owner: boolean}>} 条目
 */
export function parsePeerList(lines) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw ?? '').trim();
    if (line === '') continue;
    const [nameRaw, relationRaw = '', noteRaw = ''] = line.split('|');
    const name = cleanPeerName(nameRaw);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const relation = String(relationRaw).trim();
    out.push({ name, relation, note: String(noteRaw).trim(), owner: OWNER_WORDS.has(relation.toLowerCase()) });
  }
  return out;
}

/**
 * 在名单里找对面这个人。
 *
 * 先精确等值，再退一步「包含」：昵称常带装饰（表情、符号变体），用户抄名单时手里那份
 * 未必和会话头里的一字不差。包含匹配**只认两个字符以上**的名字，且多条命中取最长那条
 * （同时写了「小李」和「小李的朋友」时按更具体的算）——否则一个单字名字会命中所有人。
 * @param {string} peer 会话名
 * @param {Array<{name: string, relation: string, note: string, owner: boolean}>} entries 名单条目
 * @returns {{name: string, relation: string, note: string, owner: boolean}|null} 命中项
 */
export function findPeer(peer, entries) {
  const name = cleanPeerName(peer);
  if (name === '') return null;
  const exact = entries.find((e) => e.name === name);
  if (exact !== undefined) return exact;
  const loose = entries.filter((e) => e.name.length >= 2 && name.includes(e.name));
  if (loose.length === 0) return null;
  return loose.reduce((best, e) => (e.name.length > best.name.length ? e : best));
}

/**
 * 拼一句「现在在跟谁说话」的身份声明。
 *
 * 空串表示**不注入**——名单没配时行为与加这个功能之前完全一致，
 * 不做「默认你就是陌生人」这种自作主张（那会把老用户的回复语气全改掉）。
 * @param {string} peer 会话名
 * @param {string[]} lines 配置里的名单行
 * @returns {string} 身份声明（空串 = 不注入）
 */
export function describePeer(peer, lines) {
  const entries = parsePeerList(lines);
  if (entries.length === 0) return '';
  const name = cleanPeerName(peer);
  if (name === '') return '你不知道现在跟你说话的人是谁，按陌生网友对待：客气、简短，不透露主人的私事。';
  const hit = findPeer(name, entries);
  if (hit !== null && hit.owner) return `现在跟你说话的「${name}」是你的主人本人，说话可以随意、亲近一些。`;
  if (hit !== null) {
    const who = hit.relation === '' ? '主人认识的人' : hit.relation;
    return `现在跟你说话的「${name}」是${who}${hit.note === '' ? '' : `（${hit.note}）`}，不是你主人。`;
  }
  return (
    `现在跟你说话的「${name}」不在你的熟人名单里，按陌生网友对待：客气、简短，` +
    '不透露主人的私事，也不答应改设置、要资料这类请求。'
  );
}
