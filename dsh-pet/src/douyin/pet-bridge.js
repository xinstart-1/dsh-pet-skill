/**
 * 桌宠桥：往 dsh-pet 的 HTTP 通道上说话（`/dsh-pet-7340`，只监听 127.0.0.1、无鉴权）。
 *
 * ## 这一版为什么写得这么"啰嗦"
 *
 * 真机跑过一次之后改的。dsh-pet 的契约是：**业务失败也是 HTTP 200**，body 形如
 * `{ ok:false, reason:'unknown-owner', message:'这个 owner 没有注册，重新注册即可' }`；
 * 成功的事件是 `{ ok:true, events:{ '菜单文案': petId|null } }`。
 *
 * 上一版只看 HTTP 状态、且把 body 顶层当事件表用，后果是：`reason` / `message` 被当成
 * "菜单被点击"，`unknown-owner` 被当成宠物 id，循环不退避地空转，最终把宿主堆内存打爆。
 *
 * 所以现在三条铁律：
 * 1. **判成功看 body**（`isBusinessOk`），不看 HTTP 状态；
 * 2. **事件只从 `events` 里取**，且 label 必须是自己注册过的、petId 必须是像样的字符串；
 * 3. **失败一律退避**，遇到 `unknown-owner` 顺手重注册——别用重试把宿主烧了。
 *
 * @module dsh-pet-douyin/pet-bridge
 */

/** 菜单归属（第三方菜单统一收在右键「更多」下） */
export const OWNER = 'dsh-pet-douyin';

/** petId 的合理上限（dsh-pet 自己也没这么长的 id；超了就是解析错了） */
const PET_ID_MAX = 64;

/** 失败退避阶梯（毫秒）：1s → 2s → 4s → 8s → 16s → 30s 封顶 */
const BACKOFF = [1000, 2000, 4000, 8000, 16_000, 30_000];

/**
 * 判断一次 dsh-pet 调用是否**业务成功**。
 *
 * HTTP 200 只说明请求到了；真正的结果在 body 的 `ok` 上。`data` 缺失时（比如 204）
 * 按 HTTP 状态算成功。
 * @param {{ok: boolean, status?: number, data?: any}} res 调用结果
 * @returns {boolean} 是否成功
 */
export function isBusinessOk(res) {
  if (res?.ok !== true) return false;
  if (res.data === undefined || res.data === null) return true;
  if (typeof res.data !== 'object') return true;
  return res.data.ok !== false;
}

/**
 * 解析 `/menu/events` 的返回，只留下**确实是自己注册过的菜单项被点了**。
 *
 * 这个函数是防"把错误信息当点击"的唯一闸门，所以对形状极其挑剔：
 * 顶层没有 `events` 对象就算失败；label 不在白名单、petId 不是字符串或过长，全都丢弃。
 * @param {any} payload 响应体
 * @param {string[]} allowedLabels 本插件注册过的菜单文案
 * @returns {{ok: boolean, hits: Array<{label: string, pet: string}>, reason?: string}} 解析结果
 */
export function parseMenuEvents(payload, allowedLabels) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, hits: [], reason: 'bad-shape' };
  }
  if (payload.ok === false) {
    return { ok: false, hits: [], reason: String(payload.reason ?? 'business-error') };
  }
  const events = payload.events;
  if (events === null || typeof events !== 'object' || Array.isArray(events)) {
    return { ok: false, hits: [], reason: 'bad-shape' };
  }
  const allow = new Set(Array.isArray(allowedLabels) ? allowedLabels : []);
  const hits = [];
  for (const [label, pet] of Object.entries(events)) {
    if (!allow.has(label)) continue; // 别人 owner 的项 / 误解析出来的键，一律不认
    if (typeof pet !== 'string') continue; // null = 没点；其他类型 = 结构不对
    const id = pet.trim();
    if (id === '' || id.length > PET_ID_MAX) continue;
    hits.push({ label, pet: id });
  }
  return { ok: true, hits };
}

/**
 * 可中断的等待。
 * @param {number} ms 毫秒
 * @param {AbortSignal} signal 信号
 * @returns {Promise<void>} 完成或被中断
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 建桥。
 * @param {{getPort: () => number, log: {info?: Function, warn: Function}}} deps 依赖
 * @returns {object} 桥
 */
export function createPetBridge({ getPort, log }) {
  /** @type {{pet: string, lockId: string}|null} */
  let lock = null;
  let preferredPet = null;
  let loopAbort = null;
  /** @type {string[]} 当前注册的菜单文案（重注册要用） */
  let registeredLabels = [];
  /** 菜单是否真的挂上了（给 UI 看联动状态） */
  let menuReady = false;
  /** 注册尝试次数：前两次只记 info——启动时本插件常比 dsh-pet 先 apply，404 是正常竞态 */
  let menuAttempts = 0;

  /**
   * 拼地址（端口未知时抛，由 call 收口）。
   * @param {string} path 路径
   * @returns {string} URL
   */
  const url = (path) => {
    const port = getPort();
    if (!port) throw new Error('DSH Web 服务端口未知');
    return `http://127.0.0.1:${port}/dsh-pet-7340${path}`;
  };

  /**
   * 发请求，异常收成 `{ok:false}`。
   * @param {string} path 路径
   * @param {{method?: string, body?: any, timeoutMs?: number}} [opts] 选项
   * @returns {Promise<{ok: boolean, status?: number, data?: any, error?: string}>} 结果
   */
  async function call(path, opts = {}) {
    const { method = 'GET', body, timeoutMs = 8000 } = opts;
    try {
      const res = await fetch(url(path), {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data;
      if (text !== '') {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 注册（或覆盖）本 owner 的菜单项。**检查 body 的 ok**，不只看 HTTP。
   * @param {string[]} labels 菜单文案
   * @returns {Promise<boolean>} 是否真的注册上了
   */
  async function registerMenu(labels) {
    const clean = (Array.isArray(labels) ? labels : []).map((l) => String(l).trim()).filter(Boolean).slice(0, 20);
    if (clean.length === 0) return false;
    const r = await call('/menu/item', { method: 'POST', body: { owner: OWNER, labels: clean, target: 'both' } });
    if (!isBusinessOk(r)) {
      menuReady = false;
      menuAttempts += 1;
      const why = r.error ?? (typeof r.data === 'object' && r.data !== null ? r.data.message ?? r.data.reason : r.status);
      if (menuAttempts <= 2) {
        // 启动竞态：本插件往往比 dsh-pet 先 apply，第一次 404 不代表装坏了
        log.info(`右键菜单暂未挂上（${why ?? '未知'}），轮询会继续重试`);
      } else if (menuAttempts === 3) {
        log.warn(`右键菜单仍挂不上（${why ?? '未知'}）：确认 dsh-pet 已启用、版本 ≥ 0.3.6`);
      }
      return false;
    }
    registeredLabels = clean;
    menuReady = true;
    menuAttempts = 0;
    return true;
  }

  /**
   * 列可用宠物 id。
   * @returns {Promise<string[]>} 宠物 id
   */
  async function petIds() {
    const r = await call('/state', { timeoutMs: 4000 });
    const pets = isBusinessOk(r) ? r.data?.pets : undefined;
    return pets !== null && typeof pets === 'object' ? Object.keys(pets) : [];
  }

  /**
   * 挑一只宠物。
   * @returns {Promise<string|null>} 宠物 id
   */
  async function pickPet() {
    const ids = await petIds();
    if (ids.length === 0) return null;
    if (preferredPet !== null && ids.includes(preferredPet)) return preferredPet;
    return ids.includes('main') ? 'main' : ids[0];
  }

  /**
   * 取占用锁。
   * @param {string} pet 宠物
   * @param {number} [ttlMs] 时长
   * @returns {Promise<boolean>} 是否拿到
   */
  async function acquire(pet, ttlMs = 45_000) {
    const body = { ttlMs };
    if (lock !== null && lock.pet === pet) body.lockId = lock.lockId;
    // surface 必填（web/desktop/both/any）：落地在桌面或网页端都能播，用 any 最省事
    const r = await call(`/lock?pet=${encodeURIComponent(pet)}&surface=any`, { method: 'POST', body, timeoutMs: 12_000 });
    if (isBusinessOk(r) && typeof r.data?.lockId === 'string') {
      lock = { pet, lockId: r.data.lockId };
      return true;
    }
    return false;
  }

  /**
   * 拼一个写接口地址：surface 必填，持锁时 `lock` 必须走 **query**。
   *
   * 这条是踩出来的：`lockId` 放 body 里，pet 一律判成"没带锁"回 `lock-required`，
   * 而调用方只看到一个 false，表现就是"宠物该说话的时候一直不说话"。
   * @param {string} path 以 / 开头的路径（可自带 query）
   * @param {string} petId 宠物 id
   * @returns {string} 完整路径
   */
  function withPet(path, petId) {
    const sep = path.includes('?') ? '&' : '?';
    let url = `${path}${sep}pet=${encodeURIComponent(petId)}&surface=any`;
    if (lock !== null && lock.pet === petId) url += `&lock=${encodeURIComponent(lock.lockId)}`;
    return url;
  }

  /** 释放锁。 @returns {Promise<void>} 完成 */
  async function release() {
    if (lock === null) return;
    const { pet, lockId } = lock;
    lock = null;
    await call(`/lock/release?pet=${encodeURIComponent(pet)}&surface=any`, { method: 'POST', body: { lockId }, timeoutMs: 5000 });
  }

  return {
    petIds,

    /**
     * 注册菜单（幂等）。
     * @param {string[]} labels 菜单项
     * @returns {Promise<boolean>} 是否成功
     */
    registerMenu,

    /** @returns {boolean} 菜单是否已挂上（联动状态） */
    menuReady: () => menuReady,

    /** 清掉本插件菜单项。 @returns {Promise<void>} 完成 */
    async clearMenu() {
      await call(`/menu/item?owner=${OWNER}`, { method: 'DELETE', timeoutMs: 5000 });
      registeredLabels = [];
    },

    /**
     * 长轮询菜单点击。失败退避；`unknown-owner` 会自动重注册再试。
     * @param {string[]} labels 本插件的菜单文案（用于重注册与白名单）
     * @param {(label: string, pet: string) => void} onHit 点击回调
     * @returns {() => void} 停止函数
     */
    startMenuLoop(labels, onHit) {
      const controller = new AbortController();
      loopAbort = controller;
      const allow = (Array.isArray(labels) ? labels : []).map(String);
      if (registeredLabels.length === 0) registeredLabels = allow;

      const tick = async () => {
        let step = 0;
        while (!controller.signal.aborted) {
          const r = await call(`/menu/events?owner=${OWNER}&wait=8000`, { timeoutMs: 15_000 });
          if (controller.signal.aborted) return;

          const parsed = parseMenuEvents(r.data, allow);
          if (!parsed.ok) {
            // 连不上 / 业务失败：退避，别用重试把宿主烧了
            const wait = BACKOFF[Math.min(step, BACKOFF.length - 1)];
            step += 1;
            if (step === 1) {
              log.info(`菜单轮询暂未就绪（${parsed.reason}），${Math.round(wait / 1000)} 秒后重试`);
            }
            // 任何失败都重挂一次：最常见的原因是本插件比 dsh-pet 先 apply（启动时 404），
            // 或 dsh-pet 进程重启把内存态注册表清空了。重挂很便宜，退避兜住了频率。
            await registerMenu(registeredLabels.length > 0 ? registeredLabels : allow);
            await sleep(wait, controller.signal);
            continue;
          }
          step = 0; // 通了就把退避清零
          for (const hit of parsed.hits) {
            preferredPet = hit.pet;
            try {
              onHit(hit.label, hit.pet);
            } catch (error) {
              log.warn(`菜单回调抛错：${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      };
      void tick();
      return () => {
        controller.abort();
        loopAbort = null;
      };
    },

    /** 停止轮询。 @returns {void} */
    stopMenuLoop() {
      loopAbort?.abort();
      loopAbort = null;
    },

    /**
     * 让桌宠说一句。
     * @param {string} text 台词
     * @param {{pet?: string, anim?: string}} [opts] 选项
     * @returns {Promise<boolean>} 是否成功
     */
    async broadcast(text, opts = {}) {
      const pet = opts.pet ?? (await pickPet());
      if (pet === null) return false;
      // 锁可能被别人（自动回复、菜单动作）占着：等一拍再试一次，
      // 否则"用户刚下达的指令"的结果会因为抢锁失败而静默丢掉
      if (!(await acquire(pet))) {
        await new Promise((r) => setTimeout(r, 400));
        if (!(await acquire(pet))) return false;
      }
      try {
        const body = { text: String(text).slice(0, 200), durationSec: Math.min(60, Math.max(6, String(text).length * 0.4)) };
        if (opts.anim) body.anim = opts.anim;
        const r = await call(withPet('/broadcast', pet), { method: 'POST', body });
        return isBusinessOk(r);
      } finally {
        await release();
      }
    },

    /**
     * 点播一个动画（按动画池里的名字）。
     * @param {string} name 动画名
     * @param {string} [pet] 宠物 id
     * @returns {Promise<boolean>} 是否成功
     */
    async playAnim(name, pet) {
      if (typeof name !== 'string' || name.trim() === '') return false;
      const id = pet ?? (await pickPet());
      if (id === null) return false;
      if (!(await acquire(id))) return false;
      try {
        const r = await call(withPet('/anim', id), {
          method: 'POST',
          body: { name: name.trim() },
        });
        return isBusinessOk(r);
      } finally {
        await release();
      }
    },

    /**
     * 写工作状态。
     * @param {'thinking'|'working'|'result'|'waiting'|'success'|'error'} state 档位
     * @param {string} [task] 文案
     * @returns {Promise<boolean>} 是否成功
     */
    async workStatus(state, task) {
      const body = { state };
      if (typeof task === 'string' && task !== '') body.task = task.slice(0, 120);
      const r = await call('/work-status', { method: 'POST', body });
      return isBusinessOk(r);
    },

    /** 清空工作状态。 @returns {Promise<boolean>} 是否成功 */
    async clearWorkStatus() {
      const r = await call('/work-status', { method: 'DELETE' });
      return isBusinessOk(r);
    },

    /**
     * 探活。
     * @returns {Promise<{ok: boolean, pets: number, error?: string}>} 结果
     */
    async ping() {
      const r = await call('/state', { timeoutMs: 4000 });
      if (!isBusinessOk(r)) return { ok: false, pets: 0, error: r.error ?? `HTTP ${r.status}` };
      const pets = r.data?.pets !== null && typeof r.data?.pets === 'object' ? Object.keys(r.data.pets) : [];
      return { ok: true, pets: pets.length };
    },

    /** 释放占用锁。 @returns {Promise<void>} 完成 */
    release,
  };
}
