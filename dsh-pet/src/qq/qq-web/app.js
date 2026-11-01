/**
 * 设置页前端：无框架、无构建，一个文件管五个页签。
 *
 * 四个约定（与抖音页一致，改动时别破坏）：
 * 1. **表单是配置的影子**：`data-path` 指向配置键路径，保存时从 DOM 收集、读配置时回填；
 * 2. **保存后用服务端返回的成品配置重填**，用户能立刻看到自己被纠正了什么；
 * 3. **人工操作与服务路径分开**：手动发消息不走白名单也不看试运行——那是"你自己发的"；
 * 4. 失败一律弹 toast 说人话，控制台只作辅助。
 *
 * 「连接」按钮会先保存再连：用户改完地址直接点连接是本能，不该要求他先点保存。
 */
(() => {
  'use strict';

  const API = './api';

  /** @type {any} 最近一次 /api/state */
  let state = null;
  /** @type {any} 当前成品配置（保存时作底稿，保住不认识的键） */
  let config = null;
  /** @type {Map<string, {set: (v: any[]) => void, get: () => any[]}>} 列表字段 */
  const lists = new Map();

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** HTML 转义 */
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  /**
   * 弹提示。
   * @param {string} msg 文案
   * @param {'ok'|'err'|''} [kind] 类型
   * @returns {void}
   */
  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(
      () => {
        el.className = 'toast';
      },
      kind === 'err' ? 6500 : 3200,
    );
  }

  /**
   * 调接口。
   * @param {string} path 以 `/` 开头
   * @param {{method?: string, body?: any}} [opts] 选项
   * @returns {Promise<any>} 响应
   */
  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method ?? 'GET',
      headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = { reason: text };
      }
    }
    return data ?? { ok: false, reason: `HTTP ${res.status}` };
  }

  /** 按点号路径读值 */
  const getPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

  /** 按点号路径写值（只处理对象；数组整体赋值走最后一键） */
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const key = keys[i];
      if (cur[key] === null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
      cur = cur[key];
    }
    cur[keys[keys.length - 1]] = value;
  }

  /* ---------------- 列表编辑器（chips） ---------------- */

  /**
   * 把一个 `.chips[data-list]` 变成可增删的列表编辑器。
   * @param {HTMLElement} host 容器
   * @returns {{set: (v: any[]) => void, get: () => any[]}} 读写器
   */
  function makeList(host) {
    /** @type {string[]} */
    let values = [];
    const input = document.createElement('input');
    input.className = 'chip-input';
    input.placeholder = host.dataset.placeholder || '输入后回车添加';
    host.appendChild(input);

    function render() {
      $$('.chip', host).forEach((el) => el.remove());
      values.forEach((value, index) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `<span>${esc(value)}</span><button type="button" title="删掉">×</button>`;
        $('button', chip).addEventListener('click', () => {
          values.splice(index, 1);
          render();
        });
        host.insertBefore(chip, input);
      });
    }

    function add(raw) {
      const value = String(raw ?? '').trim();
      if (value === '') return;
      if (values.includes(value)) {
        toast('已经在列表里了');
        return;
      }
      values.push(value);
      render();
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        add(input.value);
        input.value = '';
      } else if (event.key === 'Backspace' && input.value === '' && values.length > 0) {
        values.pop();
        render();
      }
    });
    // 失焦时把没回车的内容也收下——用户很容易填完就去点保存
    input.addEventListener('blur', () => {
      if (input.value.trim() !== '') {
        add(input.value);
        input.value = '';
      }
    });

    render();
    return {
      set(next) {
        values = Array.isArray(next) ? next.map((v) => String(v)) : [];
        render();
      },
      get() {
        if (input.value.trim() !== '') {
          add(input.value);
          input.value = '';
        }
        return [...values];
      },
    };
  }

  /* ---------------- 表单 ---------------- */

  /** 配置 → 表单 */
  function fillForm() {
    if (config === null) return;
    $$('[data-path]').forEach((el) => {
      const value = getPath(config, el.dataset.path);
      if (el.type === 'checkbox') el.checked = value === true;
      else el.value = value === undefined || value === null ? '' : String(value);
    });
    $$('[data-range]').forEach((el) => {
      const arr = getPath(config, el.dataset.range);
      const index = Number(el.dataset.index) || 0;
      el.value = Array.isArray(arr) && arr[index] !== undefined ? String(arr[index]) : '';
    });
    lists.forEach((widget, path) => widget.set(getPath(config, path) ?? []));
    $('#enabled').checked = config.enabled === true;
    $('#token-hint').textContent = state?.hasToken
      ? '已保存一个令牌；留空表示不改动'
      : '还没设令牌（网关没设就不用填）';
  }

  /** 表单 → 配置补丁 */
  function collect() {
    const body = JSON.parse(JSON.stringify(config ?? {}));
    $$('[data-path]').forEach((el) => {
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'number') {
        value = el.value === '' ? 0 : Number(el.value);
        if (!Number.isFinite(value)) value = 0;
      } else value = el.value;
      setPath(body, el.dataset.path, value);
    });
    /** @type {Map<string, number[]>} */
    const ranges = new Map();
    $$('[data-range]').forEach((el) => {
      const key = el.dataset.range;
      if (!ranges.has(key)) ranges.set(key, []);
      ranges.get(key)[Number(el.dataset.index) || 0] = Number(el.value) || 0;
    });
    ranges.forEach((arr, key) => setPath(body, key, arr));
    lists.forEach((widget, path) => setPath(body, path, widget.get()));
    body.enabled = $('#enabled').checked;
    return body;
  }

  /** 保存（成功返回 true） */
  async function save(quiet = false) {
    const r = await api('/config', { method: 'PUT', body: collect() });
    if (r.ok !== true) {
      toast(r.reason || '保存失败', 'err');
      return false;
    }
    if (r.config !== undefined) config = r.config;
    if (r.state !== undefined) state = r.state;
    fillForm();
    if (!quiet) toast(r.restarted === true ? '已保存，并按新配置重连' : '已保存', 'ok');
    return true;
  }

  /* ---------------- 渲染 ---------------- */

  /** 状态点 */
  function renderPill() {
    const pill = $('#pill');
    const bot = state?.bot ?? {};
    if (state?.enabled !== true) {
      pill.className = 'pill pill-off';
      pill.textContent = bot.ok === true ? '已连上（总开关关）' : '总开关关';
      return;
    }
    if (bot.ok === true) {
      pill.className = 'pill pill-on';
      pill.textContent = `在线 · ${bot.nickname || bot.selfId || '已连接'}`;
      return;
    }
    if (bot.state === 'connecting') {
      pill.className = 'pill pill-warn';
      pill.textContent = '连接中…';
      return;
    }
    pill.className = 'pill pill-err';
    pill.textContent = `离线${bot.lastError === '' ? '' : ' · 连不上'}`;
  }

  /** 状态表 */
  function renderState() {
    const host = $('#state-kv');
    if (state?.ok !== true) {
      host.innerHTML = '<dt>状态</dt><dd>读不到状态（插件还没起来？）</dd>';
      return;
    }
    const bot = state.bot ?? {};
    const s = state.stats ?? {};
    const rows = [
      [
        '网关',
        bot.ok === true
          ? `在线（${bot.state}）`
          : `离线（${bot.state}${bot.lastError ? `：${esc(bot.lastError)}` : ''}）`,
      ],
      [
        '登录的号',
        bot.selfId === '' ? '未知（连上后会显示）' : `${esc(bot.nickname || '（无昵称）')}（${esc(bot.selfId)}）`,
      ],
      [
        '机器人号核对',
        bot.identity === 'mismatch'
          ? '<span style="color:var(--err)">不一致：网关登录的不是配置里那个号，不会自动回话</span>'
          : bot.identity === 'ok'
            ? '<span style="color:var(--ok)">一致</span>'
            : '还没核对（没配机器人号时按网关自报的号工作）',
      ],
      ['本次收到 / 回复', `${s.inbound ?? 0} 条 / ${s.replied ?? 0} 条`],
      ['跳过 / 失败 / 试运行', `${s.skipped ?? 0} / ${s.failed ?? 0} / ${s.dryRun ?? 0}`],
      ['今日已回', `${state.usage?.dayTotal ?? 0} 条（${state.usage?.peers ?? 0} 个会话有记录）`],
      ['回复用的模型', esc(state.model ?? '未知')],
      ['人设来源', state.persona === 'in-process' ? '宠物设置页（进程内直取）' : '宠物 HTTP 接口（带缓存）'],
      ['最后一条', s.lastPeer === '' ? '还没有收到消息' : `${esc(s.lastPeer)}：${esc(s.lastText ?? '')}`],
    ];
    host.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#state-at').textContent = s.lastEventAt > 0 ? `最后活动 ${new Date(s.lastEventAt).toLocaleTimeString()}` : '';
    $('#connect-hint').textContent = state.enabled === true ? '' : '总开关关着：可以点「连接」先试通，但不会自动回话';
    $('#token-hint').textContent = state.hasToken ? '已保存一个令牌；留空表示不改动' : '还没设令牌（网关没设就不用填）';
  }

  /* ---------------- 网关安装器（NapCat） ---------------- */

  /** @type {any} 最近一次 /api/napcat */
  let napcat = null;

  /** 状态表：未解压 → 已解压待安装 → 已安装 → 运行中 */
  function renderNapcat() {
    const host = $('#napcat-kv');
    if (napcat === null) {
      host.innerHTML = '<dt>状态</dt><dd>读不到（插件还没起来？）</dd>';
      return;
    }
    const phase = napcat.running
      ? `<span style="color:var(--ok)">运行中（pid ${esc(napcat.pid)}）</span>`
      : napcat.installed
        ? '已安装，未启动'
        : napcat.unpacked
          ? '安装器已解压，等你在资源管理器里跑一次'
          : '还没有解压';
    const rows = [
      ['状态', phase],
      ['安装目录（跑安装器时填这个）', esc(napcat.installRoot)],
      ['已装好的 Shell', napcat.installed ? esc(napcat.appPath) : '—'],
      ['配置文件', napcat.installed ? esc(napcat.configPath) : '装好后点「写入配置」生成'],
    ];
    host.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#napcat-version').textContent = napcat.version ? `内置 NapCat ${napcat.version} · 非商业许可` : '';
    if (napcat.supported !== true) {
      $('#napcat-warn').textContent =
        '内置安装器只有 Windows 版：这个平台请自己装 NapCat，然后把地址与令牌填到上面的「网关」里。';
    }
    $('#btn-napcat-unpack').disabled = napcat.unpacked === true || napcat.supported !== true;
    $('#btn-napcat-config').disabled = napcat.installed !== true;
    $('#btn-napcat-launch').disabled = napcat.installed !== true || napcat.running === true;
    $('#btn-napcat-stop').disabled = napcat.running !== true;
  }

  /** 拉一次安装器状态 */
  async function refreshNapcat() {
    const r = await api('/napcat');
    if (r.ok === true) {
      napcat = r;
      renderNapcat();
    }
  }

  /**
   * 调一个网关动作：禁用按钮 → 调用 → 弹提示 → 用返回的状态重画。
   * @param {string} path 接口
   * @param {(r: any) => string} okText 成功文案
   * @param {HTMLButtonElement} btn 触发按钮
   * @returns {Promise<any>} 响应
   */
  async function napcatAction(path, okText, btn) {
    btn.disabled = true;
    try {
      const r = await api(path, { method: 'POST' });
      if (r.ok === true) toast(okText(r), 'ok');
      else toast(r.reason || '操作失败', 'err');
      if (r.status !== undefined) {
        napcat = r.status;
      } else {
        await refreshNapcat();
      }
      renderNapcat();
      void refresh();
      return r;
    } finally {
      renderNapcat();
    }
  }

  /** 审计列表 */
  async function renderAudit() {
    const box = $('#audit-list');
    const r = await api('/audit?limit=80');
    const items = Array.isArray(r.items) ? r.items : [];
    if (items.length === 0) {
      box.innerHTML = '<div class="empty">还没有记录。收到一条消息后这里会有回话结果。</div>';
      return;
    }
    box.innerHTML = items
      .map(
        (it) => `<div class="item ${it.ok ? 'ok' : 'fail'}">
          <span class="t">${new Date(it.t).toLocaleTimeString()}</span>
          <span class="d"><strong>${esc(it.action)}</strong> · ${esc(it.peer)}
          <span class="flag">${it.ok ? '✓' : '✕'}</span><br />${esc(it.detail)}</span>
        </div>`,
      )
      .join('');
  }

  /** 日志 */
  async function renderLogs() {
    const r = await api('/logs?limit=200');
    const items = Array.isArray(r.items) ? r.items : [];
    $('#log-box').textContent =
      items.length === 0
        ? '还没有日志。'
        : items.map((it) => `${new Date(it.t).toLocaleString()} ${it.level.toUpperCase()} ${it.msg}`).join('\n');
  }

  /** 轮询状态 */
  async function refresh() {
    const r = await api('/state');
    if (r.ok !== true) return;
    state = r;
    if (r.config !== undefined) {
      // 只有在用户没在改表单时才回填，避免把输入中的内容冲掉
      const focused = document.activeElement;
      const editing = focused !== null && focused.closest('.panel') !== null && /INPUT|SELECT/.test(focused.tagName);
      config = r.config;
      if (!editing) fillForm();
    }
    renderPill();
    renderState();
    void refreshNapcat();
    if ($('.panel[data-panel="records"]').classList.contains('active')) {
      void renderAudit();
      void renderLogs();
    }
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
        if (tab.dataset.tab === 'records') {
          void renderAudit();
          void renderLogs();
        }
      });
    });

    $('#btn-save').addEventListener('click', () => void save());

    $('#enabled').addEventListener('change', async (event) => {
      const on = event.target.checked;
      const r = await api('/toggle', { method: 'POST', body: { enabled: on } });
      if (r.ok !== true) {
        toast(r.reason || '切换失败', 'err');
        event.target.checked = !on;
        return;
      }
      state = r.state ?? state;
      if (config !== null) config.enabled = on;
      renderPill();
      renderState();
      toast(on ? '总开关已打开（试运行还开着的话仍然不会发出去）' : '总开关已关，已断开', 'ok');
    });

    // 连接 = 先保存再连：用户改完地址直接点连接是本能
    $('#btn-connect').addEventListener('click', async () => {
      if (!(await save(true))) return;
      const r = await api('/connect', { method: 'POST' });
      toast(r.ok === true ? '开始连接…（几秒后看上面的状态）' : '连接请求失败', r.ok === true ? 'ok' : 'err');
      setTimeout(() => void refresh(), 1200);
    });

    $('#btn-disconnect').addEventListener('click', async () => {
      await api('/disconnect', { method: 'POST' });
      toast('已断开', 'ok');
      setTimeout(() => void refresh(), 400);
    });

    $('#btn-test').addEventListener('click', async () => {
      const r = await api('/test', { method: 'POST' });
      if (r.ok === true) toast(`通了：${r.nickname || '（无昵称）'}（${r.selfId}）`, 'ok');
      else toast(`不通：${r.reason ?? '未知原因'}`, 'err');
      void refresh();
    });

    $('#say-send').addEventListener('click', async () => {
      const btn = $('#say-send');
      btn.disabled = true;
      try {
        const r = await api('/say', {
          method: 'POST',
          body: { to: $('#say-to').value.trim(), kind: $('#say-kind').value, text: $('#say-text').value.trim() },
        });
        if (r.ok === true) {
          toast(`已发出${r.parts?.length > 1 ? `（${r.parts.length} 条）` : ''}`, 'ok');
          $('#say-text').value = '';
        } else {
          toast(r.reason || '发送失败', 'err');
        }
      } finally {
        btn.disabled = false;
      }
    });

    $('#btn-audit').addEventListener('click', () => void renderAudit());
    $('#btn-logs').addEventListener('click', () => void renderLogs());

    // 网关安装器：解压 → （用户跑一次安装器）→ 写配置 → 启动
    $('#btn-napcat-unpack').addEventListener(
      'click',
      (event) =>
        void napcatAction(
          '/napcat/unpack',
          (r) => `已解压到 ${r.dir}。现在打开这个目录运行 NapCatInstaller.exe，安装目录填上面显示的「安装目录」`,
          event.currentTarget,
        ),
    );

    $('#btn-napcat-config').addEventListener(
      'click',
      (event) =>
        void napcatAction(
          '/napcat/config',
          () => '配置已写入（WebSocket 服务器 127.0.0.1），令牌已回填到上面，不用手抄',
          event.currentTarget,
        ),
    );

    $('#btn-napcat-launch').addEventListener(
      'click',
      (event) =>
        void napcatAction(
          '/napcat/launch',
          () => '网关已启动：在弹出的窗口里扫码登录小号，几秒后看「现在什么情况」里的网关状态',
          event.currentTarget,
        ),
    );

    $('#btn-napcat-stop').addEventListener(
      'click',
      (event) => void napcatAction('/napcat/stop', () => '已停止网关', event.currentTarget),
    );
  }

  /* ---------------- 内嵌模式 ---------------- */

  function setupEmbed() {
    if (new URLSearchParams(location.search).get('embed') !== '1') return;
    document.body.classList.add('embed');
    const report = () => {
      const height = document.documentElement.scrollHeight;
      if (height > 0) window.parent.postMessage({ type: 'dsh-qq-height', height }, location.origin);
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.body);
    window.addEventListener('load', report);
    // 状态在变（连接中→在线），高度也会变：低频补报一次，避免依赖 ResizeObserver 的细节
    setInterval(report, 2000);
    report();
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    $$('.chips[data-list]').forEach((host) => lists.set(host.dataset.list, makeList(host)));
    bind();
    setupEmbed();
    // 深链：?tab=chat 直开某个页签（也方便截图与排查时直达）
    const wantTab = new URLSearchParams(location.search).get('tab');
    if (wantTab !== null) $(`.tab[data-tab="${wantTab}"]`)?.click();
    const r = await api('/state');
    if (r.ok === true) {
      state = r;
      config = r.config ?? null;
      fillForm();
      renderPill();
      renderState();
      void refreshNapcat();
    } else {
      toast('读不到插件状态，看看 DSH 是不是刚重启过', 'err');
    }
    setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
  }

  void boot();
})();
