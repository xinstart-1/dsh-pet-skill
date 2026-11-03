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
    const fromLabel =
      napcat.zipSource === 'downloaded'
        ? '已下载最新版'
        : napcat.zipSource === 'bundle'
          ? '随包内置'
          : '无（点「下载最新安装器」）';
    $('#napcat-version').textContent = napcat.version
      ? `NapCat ${napcat.version} · ${fromLabel} · 非商业许可`
      : `安装器来源：${fromLabel}`;
    if (napcat.supported !== true) {
      $('#napcat-warn').textContent =
        '内置安装器只有 Windows 版：这个平台请自己装 NapCat，然后把地址与令牌填到上面的「网关」里。';
    }
    $('#btn-napcat-unpack').disabled = napcat.unpacked === true || napcat.supported !== true;
    $('#btn-napcat-fetchlatest').disabled =
      napcat.supported !== true || napcat.unpacked === true || napcat.running === true;
    $('#btn-napcat-config').disabled = napcat.installed !== true;
    $('#btn-napcat-launch').disabled = napcat.installed !== true || napcat.running === true;
    $('#btn-napcat-stop').disabled = napcat.running !== true;

    // 「快速开始」两段按钮的状态随安装进度走：装好前只亮①，装好后②变主按钮
    const quickSetup = $('#btn-quick-setup');
    const quickConnect = $('#btn-quick-connect');
    const quickStatus = $('#quick-status');
    const quickHint = $('#quick-hint');
    if (quickSetup && quickConnect && quickStatus && quickHint) {
      quickSetup.disabled = napcat.supported !== true || napcat.installed === true || napcat.installing === true;
      quickConnect.disabled = napcat.installed !== true || napcat.running === true || napcat.installing === true;
      if (napcat.installing === true) {
        quickHint.textContent = '后台安装中…';
        quickStatus.textContent = '不用守着，装完会提示';
      } else if (napcat.running === true) {
        quickHint.textContent = `网关运行中（pid=${napcat.pid}）`;
        quickStatus.textContent = '就差扫码登录了——登录后自动连上';
      } else if (napcat.installed === true) {
        quickHint.textContent = '网关已安装';
        quickStatus.textContent = '点 ② 自动写配置并连接';
      } else if (napcat.installPhase === 'failed') {
        quickHint.textContent = '上次安装失败';
        quickStatus.textContent = napcat.installError || '可重试';
      } else {
        quickHint.textContent = napcat.supported === true ? '还没安装' : '此平台不支持内置安装器';
        quickStatus.textContent = '';
      }
    }
    renderInstallProgress();
  }

  /**
   * 渲染一键安装的真进度条。
   *
   * 数据全部来自安装器自身的输出（后端 GBK 解码后按行解析），所以百分比是真实的，
   * 不是「轮询了几次」估出来的。安装器要人按键时不会卡住我们——看门狗会兜底。
   */
  function renderInstallProgress() {
    const wrap = $('#install-progress');
    if (!wrap) return;
    const running = napcat?.installing === true;
    const phase = String(napcat?.installPhase ?? 'idle');
    const percent = Math.max(0, Math.min(100, Number(napcat?.installPercent ?? 0)));
    // 只在「安装中」或「刚装完/刚失败」时显示；从没装过就不占地方
    const show = running || phase === 'done' || phase === 'failed';
    wrap.hidden = !show;
    if (!show) return;

    $('#install-label').textContent = napcat?.installLabel || (phase === 'done' ? '安装完成' : '准备中');
    $('#install-percent').textContent = `${percent}%`;
    const bar = $('#install-bar');
    bar.style.width = `${percent}%`;
    bar.className = 'progress-fill' + (phase === 'failed' ? ' is-failed' : phase === 'done' ? ' is-done' : running ? ' is-running' : '');
    $('#install-detail').textContent = napcat?.installDetail || (phase === 'failed' ? napcat?.installError ?? '' : '');
    // 已耗时（安装中）/ 总耗时提示
    const startedAt = Number(napcat?.installStartedAt ?? 0);
    const elapsed = $('#install-elapsed');
    if (running && startedAt > 0) {
      const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      elapsed.textContent = `已用 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    } else if (phase === 'done') {
      elapsed.textContent = '完成';
    } else {
      elapsed.textContent = '';
    }
  }

  /** 拉最新安装器：禁用按钮 → 调用 → 弹提示 → 用返回的状态重画。 */
  async function fetchLatestAction(btn) {
    btn.disabled = true;
    try {
      const r = await api('/napcat/fetchlatest', { method: 'POST' });
      if (r.ok === true) {
        toast(
          r.already === true
            ? `已经是最新（v${r.version}）`
            : `已下载最新安装器 v${r.version}（SHA-256 校验通过）。现在点「解压安装器」`,
          'ok',
        );
      } else {
        toast(r.reason || '下载失败', 'err');
      }
      if (r.status !== undefined) napcat = r.status;
      else await refreshNapcat();
      renderNapcat();
      return r;
    } finally {
      renderNapcat();
    }
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

    // ---- 快速开始 ①：一键装网关（后台自动：下载 QQ + Shell，不用人守着）----
    $('#btn-quick-setup').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        const r = await api('/napcat/setup', { method: 'POST' });
        if (r.ok === true) {
          toast('后台安装已开始：自动下载 QQ 与 NapCat（几分钟，不用管）', 'ok');
          if (r.status !== undefined) {
            napcat = r.status;
            renderNapcat();
          }
          // 轮询安装进度；装完自动提示点②（2 秒一次，进度条才跟得上）
          const poll = setInterval(async () => {
            await refreshNapcat();
            if (napcat?.installing === false && napcat?.installPhase === 'done') {
              clearInterval(poll);
              toast('网关安装完成！点「② 一键连接」自动配置并连上', 'ok');
            } else if (napcat?.installing === false && napcat?.installPhase === 'failed') {
              clearInterval(poll);
              toast(napcat?.installError || '安装失败，可重试', 'err');
            }
          }, 2000);
          setTimeout(() => clearInterval(poll), 30 * 60 * 1000);
        } else {
          toast(r.reason || '启动后台安装失败', 'err');
        }
      } finally {
        renderNapcat();
      }
    });

    // ---- 快速开始 ②：一键连接（写配置 → 启动网关 → 连接，后端一条龙）----
    $('#btn-quick-connect').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        const r = await api('/napcat/onekey', { method: 'POST' });
        if (r.ok === true) {
          toast('已自动写配置、启动网关并发起连接。最后一步：用小号在网关窗口扫码登录，登录后状态变在线', 'ok');
        } else {
          toast(r.reason || '一键连接失败', 'err');
        }
        if (r.status !== undefined) napcat = r.status;
        await refreshNapcat();
        setTimeout(() => void refresh(), 1500);
      } finally {
        renderNapcat();
      }
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

    $('#btn-napcat-fetchlatest').addEventListener('click', (event) =>
      void fetchLatestAction(event.currentTarget),
    );

    // 彻底卸载并清理：二次确认（先问意图、再复述后果），确认后才调接口删盘
    $('#btn-uninstall').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      if (!window.confirm('确定要彻底卸载 dsh-pet 并清理全部用户数据吗？\n\n这会删除 QQ 网关、登录态与宠物配置。')) {
        return;
      }
      if (!window.confirm('最后一次确认：QQ 小号登录态和全部配置将不可恢复。点「确定」立即删除。')) {
        return;
      }
      btn.disabled = true;
      try {
        const includeElectron = $('#uninstall-electron').checked === true;
        const r = await api('/uninstall', { method: 'POST', body: { includeElectron } });
        if (r.ok === true) {
          toast(`已清理：${(r.removed || []).join('、') || '无'}。请到 DSH 里移除插件。`, 'ok');
        } else {
          const failed = Array.isArray(r.failed) ? r.failed.map((f) => f.path).join('、') : '';
          toast(`清理未全部完成${failed ? `，失败：${failed}` : ''}`, 'err');
        }
        $('#uninstall-hint').textContent = `home=${r.home || ''} · 已删=${(r.removed || []).join(',')}`;
      } finally {
        btn.disabled = false;
      }
    });

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
    // 进度条的「已用时间」要每秒走，不能等 5 秒一次的 refresh；
    // 安装中同时把 napcat 状态拉快一点（2 秒），百分比才跟得上安装器输出。
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (napcat?.installing === true) {
        renderInstallProgress();
        void refreshNapcat();
      } else if (napcat?.installPhase === 'done' || napcat?.installPhase === 'failed') {
        renderInstallProgress();
      }
    }, 1000);
  }

  void boot();
})();
