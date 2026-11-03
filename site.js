(function () {
  const OWNER = 'kanade6929';
  const REPO = 'design-refs';
  const BRANCH = 'main';
  const TOKEN_KEY = 'design-refs.githubToken';
  const Lib = window.GalleryLib;

  const $ = (id) => document.getElementById(id);
  const state = {
    rows: [],
    doc: { categories: [] },
    token: '',
    admin: false,
    c1: '全部',
    c2: '全部',
    tag: '全部',
    q: '',
    blobUrls: new Map(),
    openPath: null,
    lbDraft: null,
    busy: false,
  };
  const layers = [];
  let toastTimer = 0;
  let pressTimer = 0;
  let pressPoint = null;
  let suppressClick = false;
  let dragDepth = 0;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 4600);
  }

  function githubError(status, data) {
    const api = data && data.message ? String(data.message).slice(0, 180) : '';
    if (status === 401) return '令牌无效或已过期，请重新粘贴。';
    if (status === 403) return '没有写入权限。请确认令牌只选择了 kanade6929/design-refs，且 Contents 为 Read and write。';
    if (status === 404) return '找不到仓库或文件。';
    if (status === 409 || status === 422) return api || '仓库刚刚被更新，请再试一次。';
    return api || `GitHub 请求失败（${status}）`;
  }

  async function gh(token, path, options) {
    const opts = options || {};
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`https://api.github.com${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = { message: text.slice(0, 180) };
      }
    }
    if (!response.ok) {
      const error = new Error(githubError(response.status, data));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function decodeBase64Utf8(b64) {
    const binary = atob(String(b64 || '').replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function loadSnapshot(token) {
    const ref = await gh(token, `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    const commitSha = ref.object.sha;
    const commit = await gh(token, `/repos/${OWNER}/${REPO}/git/commits/${commitSha}`);
    const tree = await gh(token, `/repos/${OWNER}/${REPO}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('仓库文件太多，无法一次读取');
    const byPath = new Map();
    (tree.tree || []).forEach((entry) => {
      if (entry.type === 'blob') byPath.set(entry.path, entry.sha);
    });
    const csvSha = byPath.get('index.csv');
    if (!csvSha) throw new Error('仓库里没有 index.csv');
    const csvBlob = await gh(token, `/repos/${OWNER}/${REPO}/git/blobs/${csvSha}`);
    const csvText = decodeBase64Utf8(csvBlob.content);
    let categoriesText = null;
    const catSha = byPath.get('categories.json');
    if (catSha) {
      const catBlob = await gh(token, `/repos/${OWNER}/${REPO}/git/blobs/${catSha}`);
      categoriesText = decodeBase64Utf8(catBlob.content);
    }
    return { commitSha, treeSha: commit.tree.sha, byPath, csvText, categoriesText };
  }

  async function applyCommit(token, snap, plan) {
    const tree = [];
    const uploads = (plan.writes || []).filter((item) => !item.blobSha);
    const reused = (plan.writes || []).filter((item) => item.blobSha);
    const created = await Promise.all(uploads.map(async (item) => {
      const blob = await gh(token, `/repos/${OWNER}/${REPO}/git/blobs`, {
        method: 'POST',
        body: { content: item.content, encoding: item.encoding || 'utf-8' },
      });
      return { path: item.path, sha: blob.sha };
    }));
    created.forEach((item) => {
      tree.push({ path: item.path, mode: '100644', type: 'blob', sha: item.sha });
    });
    reused.forEach((item) => {
      tree.push({ path: item.path, mode: '100644', type: 'blob', sha: item.blobSha });
    });
    (plan.deletes || []).forEach((path) => {
      tree.push({ path, mode: '100644', type: 'blob', sha: null });
    });
    const newTree = await gh(token, `/repos/${OWNER}/${REPO}/git/trees`, {
      method: 'POST',
      body: { base_tree: snap.treeSha, tree },
    });
    const newCommit = await gh(token, `/repos/${OWNER}/${REPO}/git/commits`, {
      method: 'POST',
      body: { message: plan.message, tree: newTree.sha, parents: [snap.commitSha] },
    });
    await gh(token, `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      body: { sha: newCommit.sha, force: false },
    });
    return newCommit.sha;
  }

  function movesToWrites(moves, byPath) {
    return (moves || []).map((move) => {
      const sha = byPath.get(move.from);
      if (!sha) throw new Error('仓库里找不到原图文件');
      return { path: move.to, blobSha: sha };
    });
  }

  async function commitOperation(token, message, mutate) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snap = await loadSnapshot(token);
      const rows = Lib.parseCSV(snap.csvText);
      const doc = Lib.normalizeCategories(snap.categoriesText ? JSON.parse(snap.categoriesText) : { categories: [] });
      const newline = Lib.detectNewline(snap.csvText);
      const result = mutate({ rows, doc, byPath: snap.byPath, newline });
      const nextRows = result.rows;
      const nextDoc = Lib.normalizeCategories(result.doc || doc);
      const writes = [...(result.writes || []), ...movesToWrites(result.moves, snap.byPath)];
      if (JSON.stringify(nextRows) !== JSON.stringify(rows)) {
        writes.push({ path: 'index.csv', content: Lib.serializeCSV(nextRows, newline), encoding: 'utf-8' });
      }
      if (JSON.stringify(doc) !== JSON.stringify(nextDoc)) {
        writes.push({
          path: 'categories.json',
          content: `${JSON.stringify(nextDoc, null, 2)}\n`,
          encoding: 'utf-8',
        });
      }
      const deletes = result.deletes || [];
      if (!writes.length && !deletes.length) {
        return { rows: nextRows, doc: nextDoc, extra: result.extra || null, commitSha: snap.commitSha };
      }
      try {
        const commitSha = await applyCommit(token, snap, {
          message: result.message || message,
          writes,
          deletes,
        });
        return { rows: nextRows, doc: nextDoc, extra: result.extra || null, commitSha };
      } catch (error) {
        lastError = error;
        if (attempt === 0 && (error.status === 409 || error.status === 422)) continue;
        throw error;
      }
    }
    throw lastError;
  }

  function items() {
    return state.rows.map(Lib.decorateRow);
  }

  function taxonomy() {
    return Lib.listTaxonomy(state.rows, state.doc);
  }

  function subParent() {
    if (state.c1 !== '全部') return state.c1;
    const tops = taxonomy();
    return tops.length === 1 ? tops[0].name : '';
  }

  function visibleItems() {
    return Lib.filterItems(items(), state);
  }

  function findItem(path) {
    return items().find((item) => item.path === path) || null;
  }

  function tagChoices() {
    const pool = Lib.filterItems(items(), { c1: state.c1, c2: state.c2, tag: '全部', q: '' });
    const tags = new Set();
    pool.forEach((item) => item.tags.forEach((tag) => tags.add(tag)));
    return [...tags].sort((a, b) => a.localeCompare(b, 'zh'));
  }

  function rawUrl(path) {
    return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${Lib.encodePath(path)}`;
  }

  function bindImg(img, path) {
    const relative = Lib.encodePath(path);
    const raw = rawUrl(path);
    const blob = state.blobUrls.get(path);
    img.alt = Lib.titleFromFilename(path);
    img.draggable = false;
    const fail = () => {
      if (img.dataset.step === 'raw') return;
      if (blob && img.dataset.step !== 'rel') {
        img.dataset.step = 'rel';
        img.src = relative;
        return;
      }
      img.dataset.step = 'raw';
      img.src = raw;
    };
    img.onerror = fail;
    img.src = blob || relative;
  }

  function renderCount(shown) {
    const total = state.rows.length;
    $('count').textContent = `共 ${total} 张 · 显示 ${shown} 张`;
  }

  function chip(label, pressed, attrs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = label;
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    Object.entries(attrs || {}).forEach(([key, value]) => button.setAttribute(key, value));
    return button;
  }

  function renderBars() {
    const catBar = $('cat-bar');
    const subBar = $('sub-bar');
    catBar.replaceChildren();
    subBar.replaceChildren();
    const tops = taxonomy();
    const addChip = (bar, label, pressed, data) => {
      const wrap = document.createElement('span');
      wrap.className = 'chip-wrap';
      const button = chip(label, pressed, data);
      wrap.appendChild(button);
      if (state.admin && data['data-kind'] !== 'all') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chip-x';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `删除分类 ${label}`);
        remove.dataset.remove = '1';
        remove.dataset.c1 = data['data-c1'] || '';
        remove.dataset.c2 = data['data-c2'] || '';
        wrap.appendChild(remove);
      }
      bar.appendChild(wrap);
    };
    addChip(catBar, '全部', state.c1 === '全部', { 'data-kind': 'all', 'data-level': 'c1' });
    tops.forEach((cat) => {
      addChip(catBar, cat.name, state.c1 === cat.name, { 'data-kind': 'cat', 'data-level': 'c1', 'data-c1': cat.name });
    });
    if (state.admin) {
      const plus = chip('+', false, { 'data-add': 'category', 'aria-label': '新增分类' });
      plus.classList.add('chip-add');
      catBar.appendChild(plus);
    }

    const parent = subParent();
    const parentCat = tops.find((cat) => cat.name === parent);
    const subs = parentCat ? parentCat.subs : [];
    const showSubs = !!parent && (subs.length > 0 || state.admin);
    subBar.hidden = !showSubs;
    if (!showSubs) return;
    addChip(subBar, '全部', state.c2 === '全部', { 'data-kind': 'all', 'data-level': 'c2' });
    subs.forEach((sub) => {
      addChip(subBar, sub, state.c2 === sub, { 'data-kind': 'cat', 'data-level': 'c2', 'data-c1': parent, 'data-c2': sub });
    });
    if (state.admin && parent) {
      const plus = chip('+', false, { 'data-add': 'sub', 'data-c1': parent, 'aria-label': '新增子分类' });
      plus.classList.add('chip-add');
      subBar.appendChild(plus);
    }
  }

  function renderTagSelect() {
    const select = $('tag-select');
    const tags = tagChoices();
    if (state.tag !== '全部' && !tags.includes(state.tag)) state.tag = '全部';
    const current = state.tag;
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '全部';
    all.textContent = '全部标签';
    select.appendChild(all);
    tags.forEach((tag) => {
      const option = document.createElement('option');
      option.value = tag;
      option.textContent = tag;
      select.appendChild(option);
    });
    select.value = current;
  }

  function renderGrid() {
    const shown = visibleItems();
    renderCount(shown.length);
    const grid = $('grid');
    grid.replaceChildren();
    $('empty').hidden = shown.length !== 0;
    shown.forEach((item, index) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.path = item.path;
      if (state.admin) {
        const actions = document.createElement('div');
        actions.className = 'card-actions';
        actions.innerHTML = `
          <button type="button" data-act="edit">编辑</button>
          <button type="button" data-act="move">移动</button>
          <button type="button" data-act="delete">删除</button>`;
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'card-more';
        more.textContent = '⋯';
        more.setAttribute('aria-label', `${item.title} 的操作`);
        more.dataset.act = 'menu';
        card.append(actions, more);
      }
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'thumb';
      thumb.setAttribute('aria-label', `查看 ${item.title}`);
      const img = document.createElement('img');
      img.loading = index < 4 ? 'eager' : 'lazy';
      img.decoding = 'async';
      bindImg(img, item.path);
      thumb.appendChild(img);
      const body = document.createElement('div');
      body.className = 'card-body';
      const cat = item.c2 ? `${item.c1} / ${item.c2}` : item.c1;
      const tags = item.tags.map((tag) => `<button type="button" class="tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('');
      const source = item.source
        ? `<a class="source" href="${escapeHtml(item.source)}" target="_blank" rel="noopener noreferrer">来源</a>`
        : '';
      body.innerHTML = `
        <h2 class="card-title">${escapeHtml(item.title)}</h2>
        <p class="card-cat">${escapeHtml(cat)}</p>
        ${item.note ? `<p class="card-note">${escapeHtml(item.note)}</p>` : ''}
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        ${source}`;
      card.append(thumb, body);
      grid.appendChild(card);
    });
    $('fab').hidden = !state.admin;
    document.body.classList.toggle('is-admin', state.admin);
    const icon = $('token-icon');
    icon.innerHTML = state.admin
      ? '<path fill="currentColor" d="M17 9h-1V7a4 4 0 0 0-8 0H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2ZM9 7a3 3 0 0 1 6 0v2H9V7Z"/>'
      : '<path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z"/>';
  }

  function renderAll() {
    const parent = subParent();
    const subs = (taxonomy().find((cat) => cat.name === parent) || { subs: [] }).subs;
    if (state.c2 !== '全部' && !subs.includes(state.c2)) state.c2 = '全部';
    renderBars();
    renderTagSelect();
    renderGrid();
  }

  function pushLayer(el, onDismiss) {
    layers.push({ el, onDismiss });
    document.body.classList.add('no-scroll');
  }

  function dismissTop() {
    const layer = layers.pop();
    if (!layer) return false;
    layer.el.remove();
    if (!layers.length && $('lightbox').hidden) document.body.classList.remove('no-scroll');
    if (layer.onDismiss) layer.onDismiss();
    return true;
  }

  function openLayer(html, setup) {
    const el = document.createElement('div');
    el.className = 'backdrop';
    el.innerHTML = html;
    let settled = false;
    const close = () => {
      if (settled) return;
      settled = true;
      dismissTop();
    };
    document.body.appendChild(el);
    pushLayer(el, () => {
      settled = true;
    });
    el.addEventListener('click', (event) => {
      if (event.target === el) close();
    });
    setup(el, close);
    return el;
  }

  function confirmDialog({ title, text, confirmText, danger }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      openLayer(`
        <div class="dialog" role="alertdialog" aria-modal="true">
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(text)}</p>
          <div class="actions">
            <button type="button" data-cancel>取消</button>
            <button type="button" data-ok class="${danger ? 'danger' : 'primary'}">${escapeHtml(confirmText || '确定')}</button>
          </div>
        </div>`, (el, close) => {
        el.querySelector('[data-cancel]').onclick = () => { finish(false); close(); };
        el.querySelector('[data-ok]').onclick = () => { finish(true); close(); };
        const layer = layers[layers.length - 1];
        const prev = layer.onDismiss;
        layer.onDismiss = () => { prev(); finish(false); };
      });
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function extOfFile(file) {
    const match = (file.name || '').match(/\.([a-zA-Z0-9]+)$/);
    let ext = match ? match[1].toLowerCase() : '';
    if (!ext) {
      const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
      ext = map[file.type] || '';
    }
    return Lib.cleanExtension(ext);
  }

  function defaultTitle(name) {
    return Lib.sanitizeBaseName(String(name || '').replace(/\.[^.]+$/, ''));
  }

  async function runBusy(button, label, work) {
    if (state.busy) return;
    state.busy = true;
    const previous = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = label;
    }
    try {
      await work();
    } finally {
      state.busy = false;
      if (button) {
        button.disabled = false;
        button.textContent = previous;
      }
    }
  }

  function applySaved(result, blobMap) {
    state.rows = result.rows;
    state.doc = result.doc;
    if (blobMap) {
      blobMap.forEach((url, path) => state.blobUrls.set(path, url));
    }
    renderAll();
    if (state.openPath && !findItem(state.openPath)) closeLightbox();
    else if (state.openPath) fillLightbox(findItem(state.openPath));
  }

  function openUpload(fileList) {
    const files = [...fileList].filter((file) => extOfFile(file) && file.size <= 15 * 1024 * 1024);
    if (!files.length) {
      toast('请上传 15MB 以内的 jpg、png、webp 或 gif');
      return;
    }
    const drafts = files.map((file) => ({
      file,
      url: URL.createObjectURL(file),
      title: defaultTitle(file.name),
      ext: extOfFile(file),
    }));
    const dateStamp = Lib.todayStamp();
    const tops = taxonomy();
    const selectedC1 = state.c1 !== '全部' ? state.c1 : (tops[0] ? tops[0].name : '');
    const selectedC2 = state.c2 !== '全部' ? state.c2 : '';
    const release = () => drafts.forEach((draft) => URL.revokeObjectURL(draft.url));
    openLayer(`
      <form class="sheet">
        <h2>上传 ${drafts.length} 张</h2>
        <p class="hint">文件会存成 ${escapeHtml(dateStamp)}_标题.扩展名，并写入 index.csv。</p>
        <div id="upload-list"></div>
        <label class="field">分类
          <select name="c1" required></select>
        </label>
        <label class="field" id="new-c1-wrap" hidden>新分类名称
          <input name="newC1" type="text" maxlength="40">
        </label>
        <label class="field">子分类
          <select name="c2"></select>
        </label>
        <label class="field" id="new-c2-wrap" hidden>新子分类名称
          <input name="newC2" type="text" maxlength="40">
        </label>
        <label class="field">标签（用 | 分隔）
          <input name="tags" type="text" placeholder="亚克力立牌|哥特暗黑">
        </label>
        <label class="field">备注
          <textarea name="note" rows="3"></textarea>
        </label>
        <label class="field">来源
          <input name="source" type="url" placeholder="https://">
        </label>
        <p class="error" data-error hidden></p>
        <div class="actions">
          <button type="button" data-cancel>取消</button>
          <button type="submit" class="primary">上传到 GitHub</button>
        </div>
      </form>`, (el, close) => {
      const list = el.querySelector('#upload-list');
      const c1 = el.querySelector('[name="c1"]');
      const c2 = el.querySelector('[name="c2"]');
      const error = el.querySelector('[data-error]');
      const paintFiles = () => {
        list.replaceChildren();
        drafts.forEach((draft, index) => {
          const row = document.createElement('div');
          row.className = 'upload-row';
          row.innerHTML = `
            <img alt="">
            <div>
              <div class="row-title">
                <strong>标题</strong>
                <button type="button" data-remove="${index}">移除</button>
              </div>
              <input data-title="${index}" type="text" value="${escapeHtml(draft.title)}" maxlength="80" required>
              <p class="hint" data-preview="${index}"></p>
            </div>`;
          row.querySelector('img').src = draft.url;
          list.appendChild(row);
        });
        list.querySelectorAll('[data-title]').forEach((input) => {
          const update = () => {
            const draft = drafts[Number(input.dataset.title)];
            draft.title = input.value;
            const preview = list.querySelector(`[data-preview="${input.dataset.title}"]`);
            const safe = Lib.sanitizeBaseName(input.value);
            preview.textContent = safe ? `${dateStamp}_${safe}.${draft.ext}` : '请填写标题';
          };
          input.addEventListener('input', update);
          update();
        });
        list.querySelectorAll('[data-remove]').forEach((button) => {
          button.onclick = () => {
            const index = Number(button.dataset.remove);
            URL.revokeObjectURL(drafts[index].url);
            drafts.splice(index, 1);
            if (!drafts.length) {
              close();
              return;
            }
            paintFiles();
          };
        });
      };
      const fillC1 = () => {
        c1.replaceChildren();
        tops.forEach((cat) => {
          const option = document.createElement('option');
          option.value = cat.name;
          option.textContent = cat.name;
          c1.appendChild(option);
        });
        const created = document.createElement('option');
        created.value = '__new__';
        created.textContent = '＋ 新建分类';
        c1.appendChild(created);
        if ([...c1.options].some((option) => option.value === selectedC1)) c1.value = selectedC1;
      };
      const fillC2 = () => {
        const parent = c1.value;
        c2.replaceChildren();
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '（无子分类）';
        c2.appendChild(none);
        const cat = tops.find((item) => item.name === parent);
        (cat ? cat.subs : []).forEach((sub) => {
          const option = document.createElement('option');
          option.value = sub;
          option.textContent = sub;
          c2.appendChild(option);
        });
        const created = document.createElement('option');
        created.value = '__new__';
        created.textContent = '＋ 新建子分类';
        c2.appendChild(created);
        if (selectedC2 && [...c2.options].some((option) => option.value === selectedC2)) c2.value = selectedC2;
        el.querySelector('#new-c2-wrap').hidden = c2.value !== '__new__';
      };
      fillC1();
      fillC2();
      paintFiles();
      c1.onchange = () => {
        el.querySelector('#new-c1-wrap').hidden = c1.value !== '__new__';
        fillC2();
      };
      c2.onchange = () => {
        el.querySelector('#new-c2-wrap').hidden = c2.value !== '__new__';
      };
      el.querySelector('[data-cancel]').onclick = () => { release(); close(); };
      const layer = layers[layers.length - 1];
      const prev = layer.onDismiss;
      layer.onDismiss = () => { release(); prev(); };
      el.querySelector('form').onsubmit = (event) => {
        event.preventDefault();
        const button = el.querySelector('[type="submit"]');
        runBusy(button, '正在提交…', async () => {
          error.hidden = true;
          try {
            const c1Name = c1.value === '__new__' ? el.querySelector('[name="newC1"]').value : c1.value;
            const c2Name = c2.value === '__new__' ? el.querySelector('[name="newC2"]').value : c2.value;
            if (c1.value === '__new__' && !String(c1Name).trim()) throw new Error('请填写新分类名称');
            if (c2.value === '__new__' && !String(c2Name).trim()) throw new Error('请填写新子分类名称');
            const meta = {
              c1: c1Name,
              c2: c2Name,
              tags: el.querySelector('[name="tags"]').value,
              note: el.querySelector('[name="note"]').value,
              source: el.querySelector('[name="source"]').value.trim(),
            };
            const payloads = await Promise.all(drafts.map(async (draft) => ({
              title: draft.title,
              ext: draft.ext,
              base64: await fileToBase64(draft.file),
              url: draft.url,
            })));
            const result = await commitOperation(state.token, `图库：上传 ${payloads.length} 张`, ({ rows, doc }) => {
              const planned = Lib.planUploads(rows, doc, payloads, meta, dateStamp);
              return {
                rows: planned.rows,
                doc: planned.doc,
                writes: planned.planned.map((item, index) => ({
                  path: item.path,
                  content: payloads[index].base64,
                  encoding: 'base64',
                })),
                extra: { paths: planned.planned.map((item) => item.path) },
                message: `图库：上传 ${payloads.length} 张到 ${Lib.formatCategory(Lib.sanitizeCategoryName(meta.c1), meta.c2 ? Lib.sanitizeCategoryName(meta.c2) : '')}`,
              };
            });
            const map = new Map();
            (result.extra.paths || []).forEach((path, index) => map.set(path, payloads[index].url));
            drafts.forEach((draft) => { draft.url = ''; });
            applySaved(result, map);
            close();
            toast('已上传。Pages 可能还要一两分钟才同步，这台设备会先显示刚传的图。');
          } catch (err) {
            error.textContent = err.message || '上传失败';
            error.hidden = false;
          }
        });
      };
    });
  }

  function openMetaEditor(path) {
    const item = findItem(path);
    if (!item) return;
    openLayer(`
      <form class="sheet">
        <h2>编辑「${escapeHtml(item.title)}」</h2>
        <label class="field">标签（用 | 分隔）
          <input name="tags" type="text" value="${escapeHtml(item.tags.join('|'))}">
        </label>
        <label class="field">备注
          <textarea name="note" rows="4">${escapeHtml(item.note)}</textarea>
        </label>
        <label class="field">来源
          <input name="source" type="url" value="${escapeHtml(item.source)}">
        </label>
        <p class="error" data-error hidden></p>
        <div class="actions">
          <button type="button" data-cancel>取消</button>
          <button type="submit" class="primary">保存</button>
        </div>
      </form>`, (el, close) => {
      el.querySelector('[data-cancel]').onclick = close;
      el.querySelector('form').onsubmit = (event) => {
        event.preventDefault();
        const button = el.querySelector('[type="submit"]');
        runBusy(button, '正在保存…', async () => {
          const tags = Lib.parseTags(el.querySelector('[name="tags"]').value);
          const note = el.querySelector('[name="note"]').value;
          const source = el.querySelector('[name="source"]').value.trim();
          try {
            const result = await commitOperation(state.token, `图库：更新「${item.title}」`, ({ rows, doc }) => {
              const updated = Lib.updateImage(rows, path, { tags, note, source });
              return { rows: updated.rows, doc, message: `图库：更新「${item.title}」` };
            });
            applySaved(result);
            close();
            toast('已保存');
          } catch (err) {
            const error = el.querySelector('[data-error]');
            error.textContent = err.message;
            error.hidden = false;
          }
        });
      };
    });
  }

  function openMoveEditor(path) {
    const item = findItem(path);
    if (!item) return;
    const buckets = [];
    taxonomy().forEach((cat) => {
      if (!cat.subs.length) buckets.push({ c1: cat.name, c2: '', label: cat.name });
      cat.subs.forEach((sub) => buckets.push({ c1: cat.name, c2: sub, label: `${cat.name} / ${sub}` }));
    });
    openLayer(`
      <form class="sheet">
        <h2>移动「${escapeHtml(item.title)}」</h2>
        <p class="hint">分类变了会把文件移到对应目录，index.csv 里的路径一起改。</p>
        <label class="field">移动到
          <select name="dest"></select>
        </label>
        <p class="error" data-error hidden></p>
        <div class="actions">
          <button type="button" data-cancel>取消</button>
          <button type="submit" class="primary">移动</button>
        </div>
      </form>`, (el, close) => {
      const select = el.querySelector('[name="dest"]');
      buckets.forEach((bucket, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = bucket.label;
        if (bucket.c1 === item.c1 && bucket.c2 === item.c2) option.selected = true;
        select.appendChild(option);
      });
      el.querySelector('[data-cancel]').onclick = close;
      el.querySelector('form').onsubmit = (event) => {
        event.preventDefault();
        const bucket = buckets[Number(select.value)];
        const button = el.querySelector('[type="submit"]');
        runBusy(button, '正在移动…', async () => {
          try {
            const result = await commitOperation(state.token, `图库：移动「${item.title}」`, ({ rows, doc, byPath }) => {
              const updated = Lib.updateImage(rows, path, { c1: bucket.c1, c2: bucket.c2 });
              if (!updated.moves.length) throw new Error('已经在这个分类里');
              updated.moves.forEach((move) => {
                if (!byPath.get(move.from)) throw new Error('仓库里找不到原图文件');
              });
              return {
                rows: updated.rows,
                doc,
                moves: updated.moves,
                deletes: updated.deletes,
                message: `图库：移动「${item.title}」到 ${bucket.label}`,
              };
            });
            if (state.openPath === path) state.openPath = result.rows.find((row) => row.category === Lib.formatCategory(bucket.c1, bucket.c2) && Lib.titleFromFilename(row.path) === item.title)?.path || null;
            applySaved(result);
            close();
            toast('已移动');
          } catch (err) {
            const error = el.querySelector('[data-error]');
            error.textContent = err.message;
            error.hidden = false;
          }
        });
      };
    });
  }

  async function deleteImage(path) {
    const item = findItem(path);
    if (!item) return;
    const ok = await confirmDialog({
      title: '删除图片',
      text: `确定删除「${item.title}」？图片会从仓库移除，index.csv 会同步更新。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await commitOperation(state.token, `图库：删除「${item.title}」`, ({ rows, doc }) => {
        const removed = Lib.removeImage(rows, path);
        return { rows: removed.rows, doc, deletes: removed.deletes, message: `图库：删除「${item.title}」` };
      });
      if (state.openPath === path) closeLightbox();
      applySaved(result);
      toast('已删除');
    } catch (err) {
      toast(err.message);
    }
  }

  function openCardMenu(path) {
    const item = findItem(path);
    if (!item) return;
    openLayer(`
      <div class="menu" role="menu">
        <p class="menu-title">${escapeHtml(item.title)}</p>
        <button type="button" data-act="edit">编辑标签和备注</button>
        <button type="button" data-act="move">移动分类</button>
        <button type="button" data-act="delete" class="danger">删除</button>
        <button type="button" data-act="cancel">取消</button>
      </div>`, (el, close) => {
      el.querySelector('[data-act="cancel"]').onclick = close;
      el.querySelector('[data-act="edit"]').onclick = () => { close(); openMetaEditor(path); };
      el.querySelector('[data-act="move"]').onclick = () => { close(); openMoveEditor(path); };
      el.querySelector('[data-act="delete"]').onclick = () => { close(); deleteImage(path); };
    });
  }

  function destinationBuckets(c1, c2) {
    const buckets = [];
    taxonomy().forEach((cat) => {
      const whole = !c2 && cat.name === c1;
      if (whole) return;
      if (!cat.subs.length && !(cat.name === c1 && !c2)) buckets.push({ c1: cat.name, c2: '', label: cat.name });
      cat.subs.forEach((sub) => {
        if (cat.name === c1 && sub === c2) return;
        if (whole) return;
        buckets.push({ c1: cat.name, c2: sub, label: `${cat.name} / ${sub}` });
      });
    });
    return buckets;
  }

  async function deleteCategory(c1, c2) {
    const label = c2 ? `${c1} / ${c2}` : c1;
    const count = Lib.imagesIn(state.rows, c1, c2).length;
    let action = null;
    if (!count) {
      const ok = await confirmDialog({
        title: '删除分类',
        text: `确定删除空分类「${label}」？`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      action = { type: 'empty' };
    } else {
      action = await new Promise((resolve) => {
        const buckets = destinationBuckets(c1, c2);
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          resolve(value);
        };
        openLayer(`
          <form class="dialog">
            <h2>删除分类</h2>
            <p>「${escapeHtml(label)}」里还有 ${count} 张图片。可以先移到其他分类，或连图片一起删除。</p>
            ${buckets.length ? '<label class="field">移动到<select name="dest"></select></label>' : '<p class="hint">没有其他分类可移动。</p>'}
            <div class="actions">
              <button type="button" data-cancel>取消</button>
              ${buckets.length ? '<button type="button" data-move class="primary">移动后删除分类</button>' : ''}
              <button type="button" data-drop class="danger">删除图片和分类</button>
            </div>
          </form>`, (el, close) => {
          const select = el.querySelector('[name="dest"]');
          buckets.forEach((bucket, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = bucket.label;
            select.appendChild(option);
          });
          el.querySelector('[data-cancel]').onclick = () => { finish(null); close(); };
          const move = el.querySelector('[data-move]');
          if (move) {
            move.onclick = () => {
              const bucket = buckets[Number(select.value)];
              finish({ type: 'move', c1: bucket.c1, c2: bucket.c2 });
              close();
            };
          }
          el.querySelector('[data-drop]').onclick = () => { finish({ type: 'delete-images' }); close(); };
          const layer = layers[layers.length - 1];
          const prev = layer.onDismiss;
          layer.onDismiss = () => { prev(); finish(null); };
        });
      });
      if (!action) return;
    }
    try {
      const result = await commitOperation(state.token, `图库：删除分类「${label}」`, ({ rows, doc, byPath }) => {
        const removed = Lib.deleteCategory(rows, doc, c1, c2, action.type === 'empty' ? { type: 'delete-images' } : action);
        (removed.moves || []).forEach((move) => {
          if (!byPath.get(move.from)) throw new Error('仓库里找不到原图文件');
        });
        return {
          rows: removed.rows,
          doc: removed.doc,
          moves: removed.moves,
          deletes: removed.deletes,
          message: `图库：删除分类「${label}」`,
        };
      });
      if (c2) {
        if (state.c2 === c2) state.c2 = '全部';
      } else if (state.c1 === c1) {
        state.c1 = '全部';
        state.c2 = '全部';
      }
      applySaved(result);
      toast('已删除分类');
    } catch (err) {
      toast(err.message);
    }
  }

  function openCategoryCreator(preset) {
    const presetParent = preset && preset.c2Only ? preset.c1 : '';
    openLayer(`
      <form class="sheet">
        <h2>${presetParent ? '新增子分类' : '新增分类'}</h2>
        ${presetParent ? '' : `<label class="field">类型
          <select name="kind">
            <option value="top">顶级分类</option>
            <option value="sub">子分类</option>
          </select>
        </label>`}
        <label class="field" id="parent-wrap">所属分类
          <select name="parent"></select>
        </label>
        <label class="field">名称
          <input name="name" type="text" maxlength="40" required>
        </label>
        <p class="hint">空分类会记在 categories.json 里，有图片之后仍以 index.csv 为准一起显示。</p>
        <p class="error" data-error hidden></p>
        <div class="actions">
          <button type="button" data-cancel>取消</button>
          <button type="submit" class="primary">添加</button>
        </div>
      </form>`, (el, close) => {
      const kind = el.querySelector('[name="kind"]');
      const parent = el.querySelector('[name="parent"]');
      const parentWrap = el.querySelector('#parent-wrap');
      taxonomy().forEach((cat) => {
        const option = document.createElement('option');
        option.value = cat.name;
        option.textContent = cat.name;
        parent.appendChild(option);
      });
      if (presetParent) {
        parent.value = presetParent;
        parentWrap.hidden = false;
      }
      const sync = () => {
        const isSub = presetParent || (kind && kind.value === 'sub');
        parentWrap.hidden = !isSub;
      };
      if (kind) kind.onchange = sync;
      sync();
      el.querySelector('[data-cancel]').onclick = close;
      el.querySelector('form').onsubmit = (event) => {
        event.preventDefault();
        const button = el.querySelector('[type="submit"]');
        runBusy(button, '正在添加…', async () => {
          const isSub = !!presetParent || (kind && kind.value === 'sub');
          const name = el.querySelector('[name="name"]').value;
          const parentName = isSub ? parent.value : name;
          const subName = isSub ? name : '';
          try {
            if (!parentName) throw new Error('请先有一个顶级分类');
            if (Lib.categoryExists(state.rows, state.doc, Lib.sanitizeCategoryName(parentName), subName ? Lib.sanitizeCategoryName(subName) : '')) {
              throw new Error('这个分类已经存在');
            }
            const result = await commitOperation(state.token, '图库：新增分类', ({ rows, doc }) => {
              const added = Lib.addCategory(doc, parentName, subName);
              if (!added.created) throw new Error('这个分类已经存在');
              return {
                rows,
                doc: added.doc,
                message: `图库：新增分类「${added.c2 ? `${added.c1} / ${added.c2}` : added.c1}」`,
              };
            });
            applySaved(result);
            close();
            toast('已添加分类');
          } catch (err) {
            const error = el.querySelector('[data-error]');
            error.textContent = err.message;
            error.hidden = false;
          }
        });
      };
    });
  }

  function fillLightbox(item) {
    if (!item) return;
    state.lbDraft = { tags: item.tags.slice(), note: item.note, source: item.source };
    const img = $('lb-img');
    bindImg(img, item.path);
    const panel = $('lb-panel');
    const cat = item.c2 ? `${item.c1} / ${item.c2}` : item.c1;
    panel.innerHTML = `
      <h2>${escapeHtml(item.title)}</h2>
      <p class="muted">${escapeHtml(cat)}${item.saved ? ` · ${escapeHtml(item.saved)}` : ''}</p>
      ${state.admin ? `<label class="field">备注<textarea id="lb-note" rows="4">${escapeHtml(item.note)}</textarea></label>` : `<p class="lb-note">${escapeHtml(item.note)}</p>`}
      <div class="tag-editor" id="lb-tags"></div>
      ${state.admin ? '<p class="hint">回车添加标签。改完后保存，会写回 index.csv。</p><button type="button" class="primary" id="lb-save" disabled>保存</button>' : ''}
      ${item.source ? `<p><a class="source" id="lb-source" href="${escapeHtml(item.source)}" target="_blank" rel="noopener noreferrer">打开来源</a></p>` : ''}`;
    const tags = $('lb-tags');
    const paintTags = () => {
      tags.replaceChildren();
      state.lbDraft.tags.forEach((tag, index) => {
        if (state.admin) {
          const chip = document.createElement('span');
          chip.className = 'tag-chip';
          chip.append(document.createTextNode(tag));
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '×';
          remove.setAttribute('aria-label', `移除标签 ${tag}`);
          remove.onclick = () => {
            state.lbDraft.tags.splice(index, 1);
            paintTags();
            syncSave();
          };
          chip.appendChild(remove);
          tags.appendChild(chip);
        } else {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'tag';
          button.textContent = tag;
          button.onclick = () => {
            state.tag = tag;
            closeLightbox();
            renderAll();
          };
          tags.appendChild(button);
        }
      });
      if (state.admin) {
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '添加标签';
        input.setAttribute('aria-label', '添加标签');
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const value = input.value.trim();
          if (!value) return;
          try {
            state.lbDraft.tags = Lib.joinTags(state.lbDraft.tags.concat(value.split(/[|]/)));
            paintTags();
            syncSave();
          } catch (err) {
            toast(err.message);
          }
        });
        tags.appendChild(input);
      }
    };
    const syncSave = () => {
      const button = $('lb-save');
      if (!button) return;
      const note = $('lb-note') ? $('lb-note').value : item.note;
      const dirty = note.trim() !== item.note || state.lbDraft.tags.join('|') !== item.tags.join('|');
      button.disabled = !dirty;
    };
    paintTags();
    const note = $('lb-note');
    if (note) note.addEventListener('input', syncSave);
    const save = $('lb-save');
    if (save) {
      save.onclick = () => {
        runBusy(save, '正在保存…', async () => {
          try {
            const tags = state.lbDraft.tags.slice();
            const noteValue = $('lb-note').value;
            const result = await commitOperation(state.token, `图库：更新「${item.title}」`, ({ rows, doc }) => {
              const fresh = rows.find((row) => row.path === item.path);
              if (!fresh) throw new Error('这张图片已经不在 index.csv 里');
              const patch = {};
              if (Lib.parseTags(fresh.tags).join('|') !== tags.join('|')) patch.tags = tags;
              if ((fresh.note || '') !== noteValue.trim()) patch.note = noteValue;
              const updated = Object.keys(patch).length ? Lib.updateImage(rows, item.path, patch) : { rows, moves: [], deletes: [] };
              return { rows: updated.rows, doc, message: `图库：更新「${item.title}」的标签` };
            });
            applySaved(result);
            toast('已保存');
          } catch (err) {
            toast(err.message);
          }
        });
      };
    }
  }

  function openLightbox(path) {
    const item = findItem(path);
    if (!item) return;
    state.openPath = path;
    $('lightbox').hidden = false;
    document.body.classList.add('lb-open', 'no-scroll');
    fillLightbox(item);
    $('lb-close').focus();
  }

  function closeLightbox() {
    state.openPath = null;
    state.lbDraft = null;
    $('lightbox').hidden = true;
    $('lb-img').removeAttribute('src');
    document.body.classList.remove('lb-open');
    if (!layers.length) document.body.classList.remove('no-scroll');
  }

  function clearToken() {
    state.token = '';
    state.admin = false;
    try { localStorage.removeItem(TOKEN_KEY); } catch (err) { /* ignore */ }
    renderAll();
  }

  function tokenInstructions() {
    return `
      <p class="hint">访客只能浏览。令牌只留在这台设备的 localStorage，不会上传，也不会写进仓库。</p>
      <ol class="steps">
        <li>打开 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Fine-grained tokens</a>，Generate new token。</li>
        <li>Token name 可填「design-refs 图库」。Resource owner 选 <strong>kanade6929</strong>。</li>
        <li>Repository access 选 <strong>Only select repositories</strong>，只勾选 <strong>design-refs</strong>。</li>
        <li>Permissions → Repository permissions → <strong>Contents</strong> 设为 <strong>Read and write</strong>。其他权限保持 No access。</li>
        <li>Generate token，复制 github_pat_ 开头的令牌，粘贴到下面。</li>
      </ol>
      <p class="hint">不用了就在 GitHub 撤销令牌，并在这里清除。</p>`;
  }

  function openTokenSheet() {
    openLayer(`
      <form class="sheet">
        <h2>编辑令牌</h2>
        ${tokenInstructions()}
        ${state.token ? '<p>此浏览器已保存令牌。</p>' : ''}
        <label class="field">个人访问令牌
          <input name="token" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="github_pat_…">
        </label>
        <p class="error" data-error hidden></p>
        <div class="actions">
          <button type="button" data-cancel>关闭</button>
          ${state.token ? '<button type="button" data-clear class="danger">清除令牌</button>' : ''}
          <button type="submit" class="primary">保存令牌</button>
        </div>
      </form>`, (el, close) => {
      el.querySelector('[data-cancel]').onclick = close;
      const clear = el.querySelector('[data-clear]');
      if (clear) clear.onclick = () => { clearToken(); close(); toast('已清除本机令牌'); };
      el.querySelector('form').onsubmit = (event) => {
        event.preventDefault();
        const button = el.querySelector('[type="submit"]');
        const value = el.querySelector('[name="token"]').value.trim();
        if (!value) {
          el.querySelector('[data-error]').textContent = '请先粘贴令牌';
          el.querySelector('[data-error]').hidden = false;
          return;
        }
        runBusy(button, '正在检查…', async () => {
          try {
            const repo = await gh(value, `/repos/${OWNER}/${REPO}`);
            if (!repo.permissions || repo.permissions.push !== true) {
              throw new Error('这个令牌不能写入此仓库。请确认只选择了 kanade6929/design-refs，且 Contents 为 Read and write。');
            }
            localStorage.setItem(TOKEN_KEY, value);
            state.token = value;
            const snap = await loadSnapshot(value);
            state.rows = Lib.parseCSV(snap.csvText);
            state.doc = Lib.normalizeCategories(snap.categoriesText ? JSON.parse(snap.categoriesText) : { categories: [] });
            state.admin = true;
            renderAll();
            close();
            toast('已开启编辑');
          } catch (err) {
            const error = el.querySelector('[data-error]');
            error.textContent = err.message;
            error.hidden = false;
          }
        });
      };
    });
  }

  function onCardAction(path, act) {
    if (act === 'menu') openCardMenu(path);
    if (act === 'edit') openMetaEditor(path);
    if (act === 'move') openMoveEditor(path);
    if (act === 'delete') deleteImage(path);
  }

  function bindEvents() {
    $('search').addEventListener('input', (event) => {
      state.q = event.target.value;
      renderGrid();
    });
    $('tag-select').addEventListener('change', (event) => {
      state.tag = event.target.value;
      renderGrid();
    });
    $('cat-bar').addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove]');
      if (remove) {
        deleteCategory(remove.dataset.c1, remove.dataset.c2 || '');
        return;
      }
      const add = event.target.closest('[data-add="category"]');
      if (add) {
        openCategoryCreator();
        return;
      }
      const button = event.target.closest('.chip');
      if (!button) return;
      state.c1 = button.dataset.kind === 'all' ? '全部' : button.dataset.c1;
      state.c2 = '全部';
      renderAll();
    });
    $('sub-bar').addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove]');
      if (remove) {
        deleteCategory(remove.dataset.c1, remove.dataset.c2 || '');
        return;
      }
      const add = event.target.closest('[data-add="sub"]');
      if (add) {
        openCategoryCreator({ c2Only: true, c1: add.dataset.c1 });
        return;
      }
      const button = event.target.closest('.chip');
      if (!button) return;
      state.c2 = button.dataset.kind === 'all' ? '全部' : button.dataset.c2;
      renderAll();
    });
    $('grid').addEventListener('click', (event) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const action = event.target.closest('[data-act]');
      if (action) {
        onCardAction(action.closest('.card').dataset.path, action.dataset.act);
        return;
      }
      const tag = event.target.closest('.tag');
      if (tag) {
        state.tag = tag.dataset.tag;
        renderTagSelect();
        renderGrid();
        return;
      }
      const thumb = event.target.closest('.thumb');
      if (thumb) openLightbox(thumb.closest('.card').dataset.path);
    });
    $('grid').addEventListener('contextmenu', (event) => {
      if (!state.admin) return;
      const card = event.target.closest('.card');
      if (!card) return;
      event.preventDefault();
      openCardMenu(card.dataset.path);
    });
    $('grid').addEventListener('touchstart', (event) => {
      if (!state.admin) return;
      if (event.target.closest('.card-actions, .card-more, a, .tag')) return;
      const card = event.target.closest('.card');
      if (!card) return;
      const touch = event.touches[0];
      pressPoint = { x: touch.clientX, y: touch.clientY, path: card.dataset.path };
      pressTimer = window.setTimeout(() => {
        suppressClick = true;
        openCardMenu(pressPoint.path);
        pressPoint = null;
      }, 520);
    }, { passive: true });
    const cancelPress = () => {
      clearTimeout(pressTimer);
      pressPoint = null;
    };
    $('grid').addEventListener('touchmove', (event) => {
      if (!pressPoint) return;
      const touch = event.touches[0];
      if (Math.hypot(touch.clientX - pressPoint.x, touch.clientY - pressPoint.y) > 12) cancelPress();
    }, { passive: true });
    $('grid').addEventListener('touchend', cancelPress);
    $('grid').addEventListener('touchcancel', cancelPress);
    $('lb-close').addEventListener('click', (event) => {
      event.stopPropagation();
      closeLightbox();
    });
    $('lightbox').addEventListener('click', (event) => {
      if (event.target.closest('.lb-panel') || event.target.closest('.lb-close')) return;
      if (event.target.closest('.lb-stage') || event.target === $('lightbox')) closeLightbox();
    });
    $('token-btn').addEventListener('click', openTokenSheet);
    $('fab').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', () => {
      if ($('file-input').files.length) openUpload($('file-input').files);
      $('file-input').value = '';
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (dismissTop()) return;
      if (!$('lightbox').hidden) closeLightbox();
    });
    window.addEventListener('dragenter', (event) => {
      if (!state.admin || layers.length) return;
      if (!event.dataTransfer || ![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      $('drop-overlay').hidden = false;
    });
    window.addEventListener('dragover', (event) => {
      if (!state.admin) return;
      event.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('drop-overlay').hidden = true;
    });
    window.addEventListener('drop', (event) => {
      if (!state.admin) return;
      event.preventDefault();
      dragDepth = 0;
      $('drop-overlay').hidden = true;
      if (layers.length) return;
      if (event.dataTransfer && event.dataTransfer.files.length) openUpload(event.dataTransfer.files);
    });
  }

  async function boot() {
    bindEvents();
    const csvRes = await fetch('index.csv', { cache: 'no-cache' });
    if (!csvRes.ok) throw new Error('读不到 index.csv');
    state.rows = Lib.parseCSV(await csvRes.text());
    const catRes = await fetch('categories.json', { cache: 'no-cache' });
    if (catRes.ok) state.doc = Lib.normalizeCategories(await catRes.json());
    renderAll();
    try { state.token = localStorage.getItem(TOKEN_KEY) || ''; } catch (err) { state.token = ''; }
    if (!state.token) return;
    try {
      const repo = await gh(state.token, `/repos/${OWNER}/${REPO}`);
      if (!repo.permissions || repo.permissions.push !== true) {
        const error = new Error('保存的令牌没有写入权限，已退出编辑。');
        error.status = 403;
        throw error;
      }
      const snap = await loadSnapshot(state.token);
      state.rows = Lib.parseCSV(snap.csvText);
      state.doc = Lib.normalizeCategories(snap.categoriesText ? JSON.parse(snap.categoriesText) : { categories: [] });
      state.admin = true;
      renderAll();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        clearToken();
        toast(err.message || '令牌无效，已退出编辑');
      } else {
        state.admin = true;
        renderAll();
        toast('暂时连不上 GitHub，先显示站点上的版本');
      }
    }
  }

  boot().catch((err) => {
    $('count').textContent = '图库加载失败';
    $('empty').hidden = false;
    $('empty').textContent = err.message || '无法读取 index.csv';
  });
}());
