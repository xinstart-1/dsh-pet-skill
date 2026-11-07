/**
 * 设置页前端：无框架、无构建，一个文件管五个标签页。
 *
 * 五个约定：
 * 1. **表单是配置的影子**：`data-path` 指向配置键路径，保存时从 DOM 收集，读配置时回填；
 * 2. **保存后用服务端返回的成品配置重填**，用户能立刻看到自己被纠正了什么；
 * 3. **授牌表是唯一权限开关**：勾了才生效，撤销是一等公民；
 * 4. **人工操作与宠物通行分开**：试验台/出包按钮是本机人工路径，不走授牌；
 * 5. 所有失败弹 toast 说人话，控制台只是辅助。
 */
(() => {
  'use strict';

  const API = './api';
  const WEEKDAYS = ['1 周一', '2 周二', '3 周三', '4 周四', '5 周五', '6 周六', '7 周日'];
  const MODE_TEXT = { manual: '手动', interval: '按间隔', daily: '每天固定时刻' };

  /** @type {any} 最近一次 /api/state */
  let state = null;
  /** @type {any} 当前成品配置（保存时作底稿） */
  let config = null;
  /** @type {Map<string, {get: () => any[], set: (v: any[]) => void}>} chips 字段 */
  const chipFields = new Map();

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const getPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

  /**
   * 按点号路径写值。
   * @param {any} obj 目标
   * @param {string} path 路径
   * @param {any} value 值
   * @returns {void}
   */
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

  /**
   * HTML 转义。
   * @param {string} s 原文
   * @returns {string} 转义结果
   */
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
      kind === 'err' ? 6500 : 3400,
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
        data = { error: text };
      }
    }
    if (!res.ok) {
      const err = new Error((data && (data.reason || data.error)) || `HTTP ${res.status}`);
      err.payload = data;
      throw err;
    }
    return data;
  }

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');
  const human = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
    return String(v);
  };
  const fmtSize = (bytes) => {
    const mb = (Number(bytes) || 0) / 1024 / 1024;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
  };
  const fmtDur = (sec) => {
    const t = Math.max(0, Math.round(Number(sec) || 0));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  /* ---------------- chips ---------------- */

  /**
   * 数组型字段的增删组件。
   * @param {HTMLElement} host `[data-chips]`
   * @param {string} path 配置路径
   * @returns {void}
   */
  function mountChips(host, path) {
    /** @type {string[]} */
    let values = [];
    const input = document.createElement('input');
    input.placeholder = host.dataset.placeholder ?? '回车添加';
    const render = () => {
      $$('.chip', host).forEach((el) => el.remove());
      values.forEach((value, index) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const label = document.createElement('span');
        label.textContent = path === 'schedule.weekdays' ? (WEEKDAYS[Number(value) - 1] ?? value) : value;
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '×';
        del.addEventListener('click', () => {
          values.splice(index, 1);
          render();
          schedulePreview();
        });
        chip.append(label, del);
        host.insertBefore(chip, input);
      });
    };
    const add = (raw) => {
      const text = String(raw).trim();
      if (text === '') return;
      let value = text;
      if (path === 'caption.tags') value = `#${text.replace(/^#+/, '')}`;
      else if (path === 'caption.mention') value = `@${text.replace(/^@+/, '')}`;
      else if (path === 'source.extensions') value = `.${text.replace(/^\.+/, '').toLowerCase()}`;
      if (!values.includes(value)) values.push(value);
      render();
      if (path.startsWith('caption.')) schedulePreview();
    };
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
    input.addEventListener('blur', () => {
      if (input.value.trim() !== '') {
        add(input.value);
        input.value = '';
      }
    });
    host.append(input);
    render();
    chipFields.set(path, {
      get: () => values.slice(),
      set: (next) => {
        values = Array.isArray(next) ? next.map(String) : [];
        render();
      },
    });
  }

  /* ---------------- 表单 ---------------- */

  /**
   * 回填表单。
   * @param {any} cfg 配置
   * @param {boolean} hasSecret 是否已存 secret
   * @returns {void}
   */
  function fillForm(cfg, hasSecret) {
    config = cfg;
    for (const el of $$('[data-path]')) {
      const value = getPath(cfg, el.dataset.path);
      if (el.type === 'checkbox') el.checked = value === true;
      else if (el.type === 'radio') el.checked = String(value) === el.value;
      else if (el.dataset.list !== undefined) el.value = Array.isArray(value) ? value.join(', ') : '';
      else el.value = value ?? '';
    }
    for (const el of $$('[data-chips-lines]')) {
      const v = getPath(cfg, el.dataset.chipsLines);
      el.value = Array.isArray(v) ? v.join('\n') : '';
    }
    for (const [path, field] of chipFields) field.set(getPath(cfg, path) ?? []);
    $('#enabled').checked = cfg.enabled === true;
  }

  /**
   * 从 DOM 收集配置。
   * @returns {any} 配置
   */
  function collectForm() {
    const out = JSON.parse(JSON.stringify(config ?? {}));
    for (const el of $$('[data-path]')) {
      const path = el.dataset.path;
      if (el.type === 'radio') {
        if (el.checked) setPath(out, path, el.value);
        continue;
      }
      if (el.type === 'checkbox') {
        setPath(out, path, el.checked);
        continue;
      }
      if (el.dataset.list !== undefined) {
        setPath(
          out,
          path,
          el.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        continue;
      }
      if (el.type === 'number') {
        const n = Number(el.value);
        if (Number.isFinite(n)) setPath(out, path, n);
        continue;
      }
      setPath(out, path, el.value);
    }
    for (const el of $$('[data-chips-lines]')) {
      setPath(
        out,
        el.dataset.chipsLines,
        el.value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    for (const [path, field] of chipFields) setPath(out, path, field.get());
    return out;
  }

  /** 保存配置。 @returns {Promise<void>} 完成 */
  async function save() {
    if (config === null) {
      toast('还没读到配置，先点「重新读取」', 'err');
      return;
    }
    const btn = $('#btn-save');
    btn.disabled = true;
    $('#save-state').textContent = '保存中…';
    try {
      const sent = collectForm();
      const r = await api('/config', { method: 'PUT', body: sent });
      fillForm(r.state.config, r.state.hasSecret);
      await refresh();
      // 静态页每次请求读盘、后端代码却是进程启动时加载的：改了源码没重启时，
      // 页面会先长出后端不认识的字段，保存时被静默丢掉、表单回填成空——
      // 用户看到的是"点了保存反而把我填的清了"。这里把丢掉的值填回去并说清原因。
      const lost = restoreDropped(sent, r.state.config);
      $('#save-state').textContent = lost > 0 ? `${lost} 项没存上` : '已保存';
      if (lost > 0) {
        toast(`有 ${lost} 项没存上：插件还没重启（后端不认识这些字段），内容已给你留着，重启后再保存一次`, 'err');
      } else {
        toast(
          r.warnings?.length ? `已保存，${r.warnings.length} 处被纠正` : '已保存，立即生效',
          r.warnings?.length ? 'err' : 'ok',
        );
      }
    } catch (error) {
      $('#save-state').textContent = '保存失败';
      toast(`保存失败：${error.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * 对照「送过去的」与「后端返回的」：某个按行编辑的列表被整段丢掉，就把原文填回输入框。
   *
   * 判据只管一种：**送过去非空、拿回来空**。后端正常的归一化纠正（补 #、夹区间、去重）
   * 都不算丢，否则每次保存都在喊"没存上"。只扫 data-chips-lines 不扫普通输入框——
   * 密钥那类字段后端本来就会脱敏返回空，一起扫会误报，还会把密钥留在 DOM 里。
   * @param {any} sent 提交的配置
   * @param {any} got 后端返回的成品配置
   * @returns {number} 被丢掉的项数（0 = 一切正常）
   */
  function restoreDropped(sent, got) {
    let lost = 0;
    for (const el of $$('[data-chips-lines]')) {
      const path = el.dataset.chipsLines;
      const a = getPath(sent, path);
      const lines = Array.isArray(a) ? a : [];
      const b = getPath(got, path);
      if (lines.length === 0 || (Array.isArray(b) && b.length > 0)) continue;
      el.value = lines.join('\n');
      lost += 1;
    }
    return lost;
  }

  /* ---------------- 渲染 ---------------- */

  /**
   * 顶部胶囊 + 概览卡。
   * @param {any} s 状态
   * @returns {void}
   */
  /** ffmpeg 的完整版本串很长（如 9.0.2-essentials_build-www.gyan.dev），卡片里只留版本号 */
  const shortFfmpeg = (v) => String(v ?? '').split('-')[0] || '—';

  function renderHead(s) {
    const link = $('#pill-link');
    link.textContent = s.link?.petMenu ? '宠物已联动' : '宠物未联动';
    link.className = `pill ${s.link?.petMenu ? 'pill-on' : 'pill-off'}`;

    const ff = s.ffmpeg ?? {};
    // 只留真正在用的：网页通道那套 + 发布包 + 授牌。
    // 「账号 / 应用凭据 / 读作品」是官方 API 路线的状态，个人号那条路走不通，不再占位置。
    const w = s.config?.web ?? {};
    const cards = [
      {
        k: '网页通道',
        v: w.enabled === false ? '未启用' : `已启用 · 端口 ${w.port}`,
        cls: w.enabled === false ? 'warn' : 'ok',
      },
      {
        k: '自动回复',
        v: w.autoReply !== true ? '关' : w.allowAutoSend === true ? '开 · 会替你发送' : '开 · 只写草稿',
        cls: '',
      },
      { k: '监听界面', v: w.surface === 'panel' ? '右侧消息面板' : '专用消息页', cls: '' },
      { k: '今日发布包', v: `${s.ledger.todayCount} / ${s.config.schedule.maxPerDay}`, cls: '' },
      {
        k: 'ffmpeg',
        v: ff.ok ? `可用 ${shortFfmpeg(ff.version)}` : '未找到（原样使用）',
        cls: ff.ok ? 'ok' : 'warn',
        sm: true,
      },
      { k: '授牌', v: `${s.grants.length} 只宠物`, cls: s.grants.length === 0 ? 'warn' : '', sm: true },
    ];
    $('#status-cards').innerHTML = cards
      .map(
        (c) =>
          `<div class="stat ${c.cls}"><div class="k">${c.k}</div><div class="v ${c.sm ? 'sm' : ''}">${esc(c.v)}</div></div>`,
      )
      .join('');
    $('#ffmpeg-hint').textContent = ff.ok ? `ffmpeg ${shortFfmpeg(ff.version)}` : `ffmpeg 未找到：${ff.reason ?? ''}`;
    $('#pet-hint').textContent = s.link?.petMenu ? '桌宠已联动' : '等待桌宠';
  }

  /**
   * 授牌表：账号 / 能力 / 配额 / 自主 / 状态 / 有效期。
   * @param {any} s 状态
   * @returns {void}
   */
  function renderGrants(s) {
    const host = $('#grants-table');
    const pets = s.pets ?? [];
    if (pets.length === 0) {
      host.className = 'empty';
      host.textContent = '没发现宠物（dsh-pet 没装？），可以先手动给 main 授牌。';
      return;
    }
    const byPet = new Map((s.grants ?? []).map((g) => [g.pet, g]));
    host.className = 'grants-wrap';
    host.innerHTML = `<table class="grants"><thead><tr>
      <th>宠物</th><th>能力</th><th>每日上限</th><th>自主</th><th>状态</th><th>有效期</th><th></th>
    </tr></thead><tbody>${pets
      .map((pet) => {
        const g = byPet.get(pet);
        const caps = g?.caps ?? {};
        const quota = g?.quota ?? {};
        const usage = g?.usage ?? { browse: 0, share: 0, dm: 0, publish: 0 };
        const auto = g?.autonomy ?? { enabled: false, perDay: 3 };
        const status =
          g === undefined
            ? '<span class="tag off">未授牌</span>'
            : g.alive
              ? '<span class="tag on">生效中</span>'
              : '<span class="tag expired">已过期</span>';
        const num = (cap, label) =>
          `<label class="q"><span>${label}</span><input class="input tiny" type="number" min="0" max="999" data-quota="${cap}" value="${quota[cap] > 0 ? quota[cap] : ''}" placeholder="不限" /></label>`;
        return `<tr data-pet="${esc(pet)}">
          <td class="pet">${esc(pet)}</td>
          <td>${(s.caps ?? [])
            .map(
              (c) =>
                `<label class="cap"><input type="checkbox" data-cap="${c.key}" ${caps[c.key] === true ? 'checked' : ''}/> ${esc(c.label)}</label>`,
            )
            .join('')}</td>
          <td class="quota">${num('browse', '浏')}${num('share', '享')}${num('dm', '信')}${num('publish', '发')}<div class="hint">今日 浏${usage.browse}/享${usage.share}/信${usage.dm}/发${usage.publish}</div></td>
          <td>
            <label class="cap"><input type="checkbox" data-auto ${auto.enabled === true ? 'checked' : ''}/> 自己看</label>
            <input class="input tiny" type="number" min="1" max="50" data-auto-perday value="${auto.perDay}" title="每天几次" />
          </td>
          <td>${status}</td>
          <td>
            <select class="input" data-ttl style="width:100px">
              <option value="0">永久</option><option value="1">1 小时</option><option value="24">1 天</option><option value="168">7 天</option>
            </select>
          </td>
          <td class="row-actions">
            <button class="btn btn-ghost btn-sm" data-save-grant>保存</button>
            <button class="btn btn-ghost btn-sm" data-revoke>撤销</button>
          </td>
        </tr>`;
      })
      .join('')}</tbody></table>
      <p class="tip" style="margin-top:10px">「每日上限」留空 = 不限；手动点过的也算进配额。「自己看」只跑「浏览」，永不发送。</p>`;
  }

  /**
   * 扫描结果。
   * @param {any} r 扫描返回
   * @returns {void}
   */
  function renderScan(r) {
    const body = $('#scan-body');
    if (r.error) {
      body.className = 'empty';
      body.textContent = r.error;
      return;
    }
    const skipped = r.skipped ?? {};
    if (!r.items || r.items.length === 0) {
      body.className = 'empty';
      body.textContent = `没有可发的新视频（已发过 ${skipped.seen ?? 0}，关键词/体积过滤 ${(skipped.keyword ?? 0) + (skipped.size ?? 0)}）`;
      return;
    }
    body.className = '';
    body.innerHTML = `<table class="cand"><thead><tr><th>文件名</th><th>体积</th><th>修改时间</th></tr></thead><tbody>${r.items
      .map(
        (it) =>
          `<tr><td class="name" title="${esc(it.path)}">${esc(it.name)}</td><td>${fmtSize(it.size)}</td><td>${fmt(it.mtimeMs)}</td></tr>`,
      )
      .join('')}</tbody></table>
      ${r.remaining > 0 ? `<p class="tip">还有 ${r.remaining} 条没列出来。</p>` : ''}`;
  }

  /**
   * 发布包列表。
   * @returns {Promise<void>} 完成
   */
  async function loadPacks() {
    const host = $('#pack-list');
    try {
      const { packs } = await api('/packs?limit=12');
      if (!packs || packs.length === 0) {
        host.className = 'empty';
        host.textContent = '还没有发布包。';
        return;
      }
      host.className = 'list';
      host.innerHTML = packs
        .map(
          (p) => `<div class="item-card">
          <div class="item-head">
            <div>
              <div class="item-title">${esc(p.caption?.title ?? p.packId)}</div>
              <div class="item-meta">${esc(p.packId)} · ${fmtDur(p.video?.durationSec ?? 0)} · ${fmtSize(p.source?.size ?? 0)} · ${fmt(p.createdAt ?? 0)}</div>
            </div>
            <div class="row-actions">
              <span class="tag ${esc(p.status ?? 'packed')}">${p.status === 'published' ? '已发布' : p.status === 'skipped' ? '作废' : '待发'}</span>
              <button class="btn btn-ghost btn-sm" data-copy="${esc(p.caption?.text ?? '')}">复制文案</button>
              <button class="btn btn-ghost btn-sm" data-open-dir="${esc(p.dir ?? '')}">打开目录</button>
              <button class="btn btn-ghost btn-sm" data-mark="${esc(p.packId)}" data-status="published">标为已发</button>
            </div>
          </div>
        </div>`,
        )
        .join('');
    } catch (error) {
      toast(`读取发布包失败：${error.message}`, 'err');
    }
  }

  /**
   * 审计与日志。
   * @returns {Promise<void>} 完成
   */
  async function loadRecords() {
    const host = $('#audit-list');
    const rows = state?.audit ?? [];
    if (rows.length === 0) {
      host.className = 'empty';
      host.textContent = '还没有记录。';
    } else {
      host.className = '';
      host.innerHTML = `<table class="audit"><thead><tr><th>时间</th><th>宠物</th><th>动作</th><th>结果</th><th>说明</th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr><td>${fmt(r.t)}</td><td>${esc(r.pet ?? '—')}</td><td>${esc(r.action ?? '')}</td>
          <td>${r.ok ? '<span class="tag on">成功</span>' : '<span class="tag expired">失败</span>'}</td><td>${esc(r.detail ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table>`;
    }
    try {
      const { file, entries } = await api('/log?limit=60');
      $('#log-path').textContent = file;
      $('#log').textContent =
        entries.length === 0
          ? '还没有日志。'
          : entries
              .map(
                (e) =>
                  `${new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false })} ${e.level.toUpperCase()} ${e.msg}`,
              )
              .join('\n');
    } catch {
      /* 日志拿不到不影响别的 */
    }
  }

  /** 文案预览（防抖）。 @returns {void} */
  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try {
        const cfg = collectForm();
        const r = await api('/caption-preview', {
          method: 'POST',
          body: { caption: cfg.caption, name: '海边日落.mp4', durationSec: 18 },
        });
        $('#caption-preview').textContent = r.text || '（文案是空的）';
        $('#preview-hint').textContent = r.warnings?.length ? r.warnings.join('；') : `${(r.text ?? '').length} 字`;
      } catch (error) {
        $('#caption-preview').textContent = `预览失败：${error.message}`;
      }
    }, 350);
  }

  /**
   * 应用状态到页面。
   * @param {any} s 状态
   * @returns {void}
   */
  /** 动作 → 人话 */
  const ACTION_LABEL = { dm: '写草稿', chats: '读会话', browse: '看作品', publish: '出发布包', help: '没听懂' };

  /**
   * 对话面板：宠物下拉 + 示例按钮。
   * 示例来自后端 state.examples，不在前端另写一份——两处文案迟早会漂。
   * @param {any} s 状态
   * @returns {void}
   */
  function renderSay(s) {
    const sel = $('#say-pet');
    if (sel === null) return;
    const pets = s.pets ?? [];
    const prev = sel.value;
    sel.innerHTML = (pets.length === 0 ? ['main'] : pets)
      .map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)
      .join('');
    if (prev !== '' && pets.includes(prev)) sel.value = prev;

    const box = $('#say-examples');
    if (box !== null && box.dataset.done !== '1') {
      box.dataset.done = '1';
      box.innerHTML = (s.examples ?? [])
        .map(
          (e) =>
            `<button class="btn btn-ghost btn-sm say-eg" data-text="${esc(e.text)}" title="${esc(e.hint)}">${esc(e.text)}</button>`,
        )
        .join('');
    }
  }

  /**
   * 把 say 的结果摊成一张卡。
   * @param {any} r 后端返回
   * @returns {void}
   */
  function showSayResult(r) {
    const out = $('#say-out');
    if (out === null) return;
    const intent = r.intent ?? {};
    const lines = [];
    lines.push(
      `识别：${ACTION_LABEL[intent.action] ?? intent.action}${intent.to ? ` → 「${intent.to}」` : ''}${intent.rule ? `（${intent.rule}）` : ''}`,
    );
    if (intent.topic) lines.push(`正文：${intent.topic}`);
    if (Array.isArray(r.items) && r.items.length > 0) {
      for (const c of r.items.slice(0, 6)) lines.push(`· ${c.name} — ${c.last}`);
    }
    for (const step of r.draft?.steps ?? []) lines.push(`› ${step}`);

    out.className = 'list';
    out.innerHTML = `
      <div class="item-card">
        <div class="item-head">
          <span class="item-title">${r.ok ? '宠物回了' : '没做成'}</span>
          <span class="tag ${r.ok ? 'on' : 'off'}">${esc(ACTION_LABEL[intent.action] ?? '—')}</span>
        </div>
        <div class="item-body">${esc(r.reply ?? '')}</div>
        <div class="item-meta">${lines.map((l) => esc(l)).join('<br>')}</div>
      </div>`;
  }

  /** 读网页通道状态（那个专用浏览器开着没）。 @returns {Promise<void>} 完成 */
  async function loadWebStatus() {
    const el = $('#say-web-state');
    if (el === null) return;
    try {
      const st = await api('/web/status');
      el.textContent = st.ok
        ? `网页通道：已连上 ${st.browser ?? ''}（端口 ${st.port}）${st.loggedIn ? '· 已登录' : '· 未登录'}`
        : `网页通道：${st.reason ?? '不可用'}`;
      el.dataset.ok = st.ok ? '1' : '0';
    } catch (error) {
      el.textContent = `网页通道：检查失败（${error.message}）`;
    }
  }

  function applyState(s) {
    const first = state === null;
    state = s;
    renderHead(s);
    renderGrants(s);
    renderSay(s);
    if (first) fillForm(s.config, s.hasSecret);
  }

  /** 拉状态。 @returns {Promise<void>} 完成 */
  async function refresh() {
    try {
      applyState(await api('/state'));
    } catch (error) {
      toast(`连不上插件后端：${error.message}`, 'err');
    }
  }

  /* ---------------- 事件 ---------------- */

  /**
   * 切标签。抽成函数是为了让地址栏 hash 也能直达——发给别人 `#account`
   * 就能直接落在账号页，不用再说"点一下上面第三个标签"。
   * @param {string} name 标签名
   * @returns {void}
   */
  function switchTab(name) {
    const tab = document.querySelector(`.tab[data-tab="${name}"]`);
    if (tab === null) return;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'records') void loadRecords();
    if (name === 'publish') void loadPacks();
    if (name === 'grants') void refresh();
    if (name === 'say') void loadWebStatus();
  }

  /** 接线。 @returns {void} */
  function wire() {
    $('#tabs').addEventListener('click', (ev) => {
      const tab = ev.target.closest('.tab');
      if (tab === null) return;
      switchTab(tab.dataset.tab);
      history.replaceState(null, '', `#${tab.dataset.tab}`);
    });

    for (const el of $$('[data-chips]')) mountChips(el, el.dataset.chips);

    $('#enabled').addEventListener('change', async (ev) => {
      try {
        await api('/toggle', { method: 'POST', body: { enabled: ev.target.checked } });
        await refresh();
        toast(ev.target.checked ? '已启用' : '已关闭', 'ok');
      } catch (error) {
        toast(`切换失败：${error.message}`, 'err');
      }
    });

    $('#btn-save').addEventListener('click', () => void save());
    $('#btn-reload').addEventListener('click', async () => {
      await refresh();
      fillForm(state.config, state.hasSecret);
      toast('已重新读取', 'ok');
    });
    $('#btn-refresh-audit').addEventListener('click', () => void refresh().then(loadRecords));
    $('#btn-refresh-packs').addEventListener('click', () => void loadPacks());

    // 发布包
    $('#btn-scan').addEventListener('click', async () => {
      const body = $('#scan-body');
      body.className = 'empty';
      body.textContent = '扫描中…';
      try {
        renderScan(await api('/candidates'));
      } catch (error) {
        body.textContent = `扫描失败：${error.message}`;
      }
    });
    $('#btn-open-source').addEventListener('click', async () => {
      const dir = collectForm()?.source?.dir ?? '';
      if (dir === '') return toast('先填目录路径', 'err');
      const r = await api('/open-path', { method: 'POST', body: { path: dir } });
      if (!r.ok) toast(`打不开：${r.reason ?? ''}`, 'err');
    });
    const doPrepare = async (btn) => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '准备中…';
      try {
        const r = await api('/prepare', { method: 'POST', body: { reason: '设置页手动' } });
        toast(`已备好「${r.pack.caption.title}」`, 'ok');
        await refresh();
        await loadPacks();
      } catch (error) {
        toast(`没准备好：${error.message}`, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    };
    $('#btn-prepare').addEventListener('click', (ev) => void doPrepare(ev.target));
    $('#btn-publish').addEventListener('click', (ev) => void doPrepare(ev.target));

    /**
     * 试一句：先静默保存表单（否则后端读到的还是旧人设），再按当前人设生成一条。
     * 走的是真链路（同一套提示词拼装 + 同一个宿主模型），只是不落到聊天窗口。
     */
    $('#btn-preview').addEventListener('click', async (ev) => {
      const btn = ev.target;
      const out = $('#preview-out');
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '生成中…';
      out.textContent = '';
      try {
        await api('/config', { method: 'PUT', body: collectForm() });
        const r = await api('/reply-preview', {
          method: 'POST',
          body: { peer: $('#preview-peer').value.trim(), text: $('#preview-text').value.trim() },
        });
        out.textContent =
          r.ok === true
            ? `${r.text ?? '(空)'}`
            : `没生成出来：${r.error ?? '未知原因'}（回复只走大模型，取不到正文就不发）`;
      } catch (error) {
        out.textContent = `失败：${error.message}`;
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });

    /**
     * 网页发布：把最近一个发布包投到创作者中心。
     *
     * 默认停在「发布」按钮前（只有设置里开了自动发布才走到最后），
     * 所以两种结果的提示文案必须不一样——不然用户会以为已经发出去了。
     */
    $('#btn-upload-web').addEventListener('click', async (ev) => {
      const btn = ev.target;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '上传中…（转码可能要几分钟）';
      try {
        const r = await api('/publish-web', { method: 'POST', body: {} });
        if (r.ok === true && r.mode === 'published') {
          toast(`发出去了：${r.title || '视频'}`, 'ok');
        } else if (r.ok === true) {
          toast(
            r.titleSet === true ? '传好了、标题也填了——去浏览器里点「发布」' : '传好了，标题没填上，去浏览器里补一下',
            'ok',
          );
        } else {
          toast(`没发成：${r.reason ?? '未知原因'}`, 'err');
        }
      } catch (error) {
        toast(`没发成：${error.message}`, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });

    // ---- 对话面板 ----
    /** 把一句话交给宠物；`text` 为空时读输入框 */
    async function say(text) {
      const input = $('#say-input');
      const value = String(text ?? input.value ?? '').trim();
      if (value === '') {
        toast('先说一句话', 'err');
        return;
      }
      input.value = value;
      const btn = $('#say-send');
      const hint = $('#say-state');
      btn.disabled = true;
      hint.textContent = '宠物在做事…';
      try {
        const r = await api('/say', { method: 'POST', body: { pet: $('#say-pet').value, text: value } });
        showSayResult(r);
        hint.textContent = '';
        toast(r.ok ? '做完了' : (r.reply ?? '没做成'), r.ok ? 'ok' : 'err');
        await refresh();
        await loadWebStatus();
      } catch (error) {
        hint.textContent = '';
        toast(`失败：${error.message}`, 'err');
      } finally {
        btn.disabled = false;
      }
    }

    $('#say-send').addEventListener('click', () => void say());

    /**
     * 刷推荐流：只读一次，按表单里选的分享方式收尾。
     *
     * 分享方式取**当前表单值**而不是先保存——用户点一下就想立刻看到结果，
     * 逼他先点保存会把"看一眼"变成两步；真要改默认值再保存即可。
     * @returns {Promise<void>} 完成
     */
    async function scanFeed() {
      const btn = $('#btn-feed');
      const out = $('#feed-out');
      const state = $('#feed-state');
      const shareEl = $('[data-path="behavior.feedShareMode"]');
      const to = $('#feed-to').value.trim();
      btn.disabled = true;
      state.textContent = '刷着…';
      out.className = 'empty';
      out.textContent = '正在读推荐流…';
      try {
        const r = await api('/feed/scan', {
          method: 'POST',
          body: {
            pet: $('#say-pet').value || 'main',
            share: shareEl ? shareEl.value : 'notify',
            ...(to === '' ? {} : { to }),
          },
        });
        if (r.ok !== true) {
          state.textContent = '没刷成';
          out.textContent = r.reason ?? r.error ?? '刷推荐流失败';
          toast(r.reason ?? r.error ?? '刷推荐流失败', 'err');
          return;
        }
        state.textContent = r.frames > 0 ? `刷到 ${r.total} 条 · 看了 ${r.frames} 帧画面` : `刷到 ${r.total} 条`;
        const items = Array.isArray(r.items) ? r.items : [];
        const head =
          r.mode === 'copy'
            ? r.copied?.ok
              ? '分享文案已复制到剪贴板：'
              : '复制没成功，文案在下面：'
            : r.mode === 'dm'
              ? r.sent?.ok
                ? `已发给「${r.sent.to}」：`
                : '没发出去：'
              : '';
        out.className = '';
        out.innerHTML =
          (head === '' ? '' : `<p class="tip"><b>${esc(head)}</b></p>`) +
          `<p class="tip" style="white-space: pre-wrap">${esc(r.text ?? '')}</p>` +
          (items.length === 0
            ? ''
            : `<table class="audit"><thead><tr><th>作者</th><th>讲的是什么</th><th>赞</th><th>时长</th></tr></thead><tbody>${items
                .slice(0, 20)
                .map(
                  (it) =>
                    `<tr><td>@${esc(it.author || '—')}</td><td>${esc(String(it.summary || it.title || '').slice(0, 80))}</td><td>${esc(it.likes || '—')}</td><td>${esc(it.duration || '—')}</td></tr>`,
                )
                .join('')}</tbody></table>`);
        toast(`刷到 ${r.total} 条`, 'ok');
        await refresh();
      } catch (error) {
        state.textContent = '没刷成';
        out.textContent = error.message;
        toast(`刷推荐流失败：${error.message}`, 'err');
      } finally {
        btn.disabled = false;
      }
    }

    $('#btn-feed').addEventListener('click', () => void scanFeed());
    $('#say-input').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void say();
      }
    });
    $('#say-examples').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.say-eg');
      if (btn !== null) void say(btn.dataset.text);
    });

    $('#btn-pet-test').addEventListener('click', async () => {
      try {
        const r = await api('/pet-test', { method: 'POST' });
        toast(r.ok ? `连上了，共 ${r.pets} 只宠物${r.said ? '，已让它说了一句' : ''}` : r.reason, r.ok ? 'ok' : 'err');
      } catch (error) {
        toast(`测试失败：${error.message}`, 'err');
      }
    });

    // 委托：授牌、账号、作品、发布包
    document.addEventListener('click', async (ev) => {
      const hit = (attr) => ev.target.closest(`[${attr}]`);

      const saveGrant = hit('data-save-grant');
      if (saveGrant !== null) {
        const row = saveGrant.closest('tr');
        const caps = {};
        for (const box of row.querySelectorAll('[data-cap]')) caps[box.dataset.cap] = box.checked;
        const quota = {};
        for (const box of row.querySelectorAll('[data-quota]')) {
          const n = Number(box.value);
          if (Number.isFinite(n) && n > 0) quota[box.dataset.quota] = n;
        }
        try {
          const r = await api('/grants', {
            method: 'POST',
            body: {
              pet: row.dataset.pet,
              caps,
              quota,
              ttlHours: Number(row.querySelector('[data-ttl]').value),
              autonomy: {
                enabled: row.querySelector('[data-auto]').checked,
                perDay: Number(row.querySelector('[data-auto-perday]').value) || 3,
              },
            },
          });
          toast(r.grant === null ? `已清空「${row.dataset.pet}」` : `已给「${row.dataset.pet}」授牌`, 'ok');
          await refresh();
        } catch (error) {
          toast(`授牌失败：${error.message}`, 'err');
        }
        return;
      }

      const revoke = hit('data-revoke');
      if (revoke !== null) {
        try {
          await api('/grants/revoke', { method: 'POST', body: { pet: revoke.closest('tr').dataset.pet } });
          toast('已撤销', 'ok');
          await refresh();
        } catch (error) {
          toast(`撤销失败：${error.message}`, 'err');
        }
        return;
      }

      const cur = hit('data-current');
      if (cur !== null) {
        try {
          await api('/auth/current', { method: 'POST', body: { openId: cur.dataset.current } });
          toast('已切换默认账号', 'ok');
          await refresh();
        } catch (error) {
          toast(`切换失败：${error.message}`, 'err');
        }
        return;
      }

      const unlink = hit('data-unlink');
      if (unlink !== null) {
        try {
          await api('/auth/unlink', { method: 'POST', body: { openId: unlink.dataset.unlink } });
          toast('已解绑', 'ok');
          await refresh();
        } catch (error) {
          toast(`解绑失败：${error.message}`, 'err');
        }
        return;
      }

      const share = hit('data-share');
      if (share !== null) {
        const pet = $('#say-pet').value || 'main';
        try {
          const r = await api('/share', { method: 'POST', body: { pet, itemId: share.dataset.share } });
          toast(r.copied?.ok ? '分享卡已复制' : `分享卡好了（没复制：${r.copied?.reason ?? ''}）`, 'ok');
        } catch (error) {
          toast(`分享失败：${error.message}`, 'err');
        }
        return;
      }

      const openItem = hit('data-open-item');
      if (openItem !== null && openItem.dataset.openItem) {
        await api('/open-url', { method: 'POST', body: { url: openItem.dataset.openItem } });
        return;
      }

      const copy = hit('data-copy');
      if (copy !== null) {
        const r = await api('/clipboard', { method: 'POST', body: { text: copy.dataset.copy } });
        toast(r.ok ? '文案已复制' : `复制失败：${r.reason ?? ''}`, r.ok ? 'ok' : 'err');
        return;
      }

      const openDir = hit('data-open-dir');
      if (openDir !== null && openDir.dataset.openDir) {
        await api('/open-path', { method: 'POST', body: { path: openDir.dataset.openDir } });
        return;
      }

      const mark = hit('data-mark');
      if (mark !== null) {
        try {
          await api('/packs/mark', { method: 'POST', body: { id: mark.dataset.mark, status: mark.dataset.status } });
          toast('已更新', 'ok');
          await loadPacks();
        } catch (error) {
          toast(`更新失败：${error.message}`, 'err');
        }
      }
    });

    for (const el of $$('[data-path^="caption."], [data-chips]')) {
      el.addEventListener('input', schedulePreview);
      el.addEventListener('change', schedulePreview);
    }

    document.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        void save();
      }
    });
  }

  /** 启动。 @returns {void} */
  function boot() {
    wire();
    // 地址栏带 #account 之类就先切过去；不认识的 hash 保持默认标签
    const initial = location.hash.replace(/^#/, '');
    if (initial !== '') switchTab(initial);
    void refresh().then(() => {
      schedulePreview();
      void loadRecords();
    });
    setInterval(() => {
      if (!document.hidden) void refresh();
    }, 20_000);
  }

  boot();

  /* ---------------- 内嵌模式（?embed=1） ---------------- */
  // 嵌在宠物设置页里时：去掉"另一个应用"的页面感（靠 body.embed 的样式覆盖），
  // 并把内容真实高度报给父窗口——iframe 用固定高度会和内容打架，出现两层滚动条。
  if (new URLSearchParams(location.search).get('embed') === '1') {
    document.body.classList.add('embed');
    const report = () => {
      const height = Math.ceil(document.body.scrollHeight);
      if (height > 0) window.parent.postMessage({ type: 'dsh-douyin-height', height }, location.origin);
    };
    // 切页签、展开折叠、异步刷新都会改变高度，统一交给 ResizeObserver
    new ResizeObserver(report).observe(document.body);
    window.addEventListener('load', report);
    setTimeout(report, 150);
  }
})();
