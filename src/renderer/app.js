'use strict';
(() => {
  const api = window.removebg;
  const $ = id => document.getElementById(id);
  const items = new Map();       // id -> item from the app
  const thumbs = new Map();      // id -> data URL
  let S = null;                  // status from the app (settings, models, ...)
  let lang = 'th', queue = { running: false, total: 0, done: 0 }, stopping = false, lastDl = null;

  /* ---------- words ---------- */

  const t = (key, vars = {}) => {
    const s = (window.I18N[lang] && window.I18N[lang][key]) ?? window.I18N.en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : ''));
  };

  function applyWords() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    for (const o of $('size').options) o.textContent = o.value === '0' ? t('opt.size.0') : t('opt.size.n', { n: o.value });
    setSeg($('lang'), lang, 'lang');
  }

  /* ---------- small helpers ---------- */

  function setSeg(group, value, attr = 'v') {
    group.querySelectorAll('[role=radio]').forEach(b => {
      const on = b.dataset[attr] === value;
      b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1;
    });
  }

  function segKeys(group, onPick, attr = 'v') {
    group.addEventListener('click', e => { const b = e.target.closest('[role=radio]'); if (b && !b.disabled) onPick(b.dataset[attr]); });
    group.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const bs = [...group.querySelectorAll('[role=radio]:not([disabled])')], i = bs.findIndex(b => b.getAttribute('aria-checked') === 'true');
      const n = bs[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length];
      e.preventDefault(); n.focus(); onPick(n.dataset[attr]);
    });
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  const mb = b => Math.round(b / 1048576).toLocaleString();
  const modelName = id => (id ? t('model.' + id) : t('foot.none'));

  /* ---------- status & settings ---------- */

  async function refresh(status) {
    S = status || await api.status();
    lang = S.settings.lang;
    applyWords();
    const ready = !!S.settings.model;
    $('setup').hidden = ready; $('work').hidden = !ready;
    renderModels();
    renderOptions();
    renderFooter();
    renderList();
  }

  async function setSettings(patch) {
    S.settings = await api.setSettings(patch);
    renderOptions(); renderFooter();
  }

  /* ---------- models ---------- */

  function recommended() { return S.totalMemGB && S.totalMemGB < 12 ? 'lite' : 'general'; }

  function modelCard(id, compact) {
    const m = S.models[id], el = document.createElement('div');
    el.className = 'model' + (S.settings.model === id ? ' current' : '');
    const busy = !!S.downloading;
    el.innerHTML = `<div class="model-head"><strong></strong>${!compact && recommended() === id ? '<span class="pill"></span>' : ''}</div><p></p><div class="model-foot"><span class="size"></span><button type="button" class="btn"></button></div>`;
    el.querySelector('strong').textContent = t('model.' + id);
    if (el.querySelector('.pill')) el.querySelector('.pill').textContent = t('model.recommended');
    el.querySelector('p').textContent = t('model.' + id + '.note');
    el.querySelector('.size').textContent = t('model.size', { mb: mb(m.bytes) });
    const b = el.querySelector('button');
    if (m.installed) {
      b.textContent = S.settings.model === id ? t('model.inUse') : t('model.use');
      b.disabled = S.settings.model === id || queue.running;
      b.onclick = async () => { S.settings = await api.useModel(id); refresh(); };
    } else {
      b.textContent = t('model.download'); b.classList.add(compact ? 'small' : 'primary');
      b.disabled = busy || queue.running;
      b.onclick = () => startDownload(id);
    }
    return el;
  }

  function renderModels() {
    const low = S.totalMemGB && S.totalMemGB < 8;
    $('ram').textContent = S.totalMemGB ? t(low ? 'setup.ramLow' : 'setup.ram', { gb: S.totalMemGB }) : '';
    $('ram').classList.toggle('warn', !!low);
    for (const [box, compact] of [[$('models'), false], [$('models-adv'), true]]) {
      box.replaceChildren(...['general', 'lite'].map(id => modelCard(id, compact)));
    }
    const sel = $('model');
    sel.replaceChildren(...['general', 'lite'].filter(id => S.models[id].installed).map(id => new Option(t('model.' + id), id)));
    sel.value = S.settings.model; sel.disabled = queue.running;
    $('import').disabled = !!S.downloading;
    showDownload();
  }

  async function startDownload(id) {
    $('setup-msg').textContent = '';
    lastDl = { id, stage: 'download', done: 0, total: S.models[id].bytes };
    if (await api.downloadModel(id)) { S.downloading = id; renderModels(); }
  }

  function showDownload() {
    const on = !!S.downloading && lastDl;
    $('dl').hidden = !on;
    if (!on) return;
    const pct = lastDl.total ? Math.floor((lastDl.done / lastDl.total) * 100) : 0;
    $('dl-bar').style.width = pct + '%';
    $('dl-text').textContent = lastDl.stage === 'verify'
      ? t('dl.verify', { pct })
      : t('dl.download', { name: t('model.' + lastDl.id), done: mb(lastDl.done), total: mb(lastDl.total), pct });
  }

  api.onModelProgress(p => {
    if (p.id === 'import') return;
    if (p.stage === 'error') {
      const key = { NETWORK: 'dl.errorNetwork', INTERRUPTED: 'dl.errorInterrupted', CHECKSUM: 'dl.errorChecksum', CANCELLED: 'dl.cancelled' }[p.code];
      $('setup-msg').textContent = key ? t(key) : t('dl.error', { msg: p.message || '' });
      if (!$('work').hidden) toast($('setup-msg').textContent);
      return;
    }
    if (p.stage === 'done') { lastDl = null; return; }
    lastDl = { ...lastDl, ...p };
    showDownload();
  });
  api.onStatus(s => refresh(s));

  $('dl-cancel').onclick = () => api.cancelDownload();
  $('import').onclick = async () => {
    const r = await api.importModel();
    if (r.ok) { toast(t('import.ok')); refresh(); } else if (r.code) $('setup-msg').textContent = t('import.bad');
  };

  /* ---------- options ---------- */

  function renderOptions() {
    const s = S.settings, o = s.output, jpg = o.format === 'jpg';
    setSeg($('format'), o.format);
    setSeg($('bg'), o.background);
    $('bg').querySelector('[data-v=transparent]').disabled = jpg;
    $('jpg-note').hidden = !jpg;
    $('colour-row').hidden = o.background !== 'colour';
    $('colour').value = o.colour; $('colour-hex').textContent = o.colour.toUpperCase();
    $('trim').checked = o.trim;
    $('margin').value = o.margin; $('margin-label').textContent = t('opt.margin', { v: o.margin });
    $('margin-row').hidden = !o.trim;
    $('square').checked = o.square;
    $('size').value = String(o.maxSize);
    if ($('size').value !== String(o.maxSize)) { $('size').add(new Option(t('opt.size.n', { n: o.maxSize }), String(o.maxSize))); $('size').value = String(o.maxSize); }
    $('clean').value = o.cleanEdges;
    document.querySelectorAll('input[name=save]').forEach(r => { r.checked = r.value === s.outputMode; });
    $('out-dir').textContent = s.outputDir || '—';
    $('out-dir').title = s.outputDir || '';
    $('gpu').checked = s.useGpu;
    const lock = queue.running;
    document.querySelectorAll('.opts fieldset, #gpu, #model').forEach(el => { el.disabled = lock; });
  }

  const out = patch => setSettings({ output: patch });
  segKeys($('format'), v => out(v === 'jpg' && S.settings.output.background === 'transparent' ? { format: v, background: 'white' } : { format: v }));
  segKeys($('bg'), v => out({ background: v }));
  $('colour').addEventListener('input', e => { $('colour-hex').textContent = e.target.value.toUpperCase(); });
  $('colour').addEventListener('change', e => out({ colour: e.target.value }));
  $('trim').onchange = e => out({ trim: e.target.checked });
  $('margin').oninput = e => { $('margin-label').textContent = t('opt.margin', { v: e.target.value }); };
  $('margin').onchange = e => out({ margin: Number(e.target.value) });
  $('square').onchange = e => out({ square: e.target.checked });
  $('size').onchange = e => out({ maxSize: Number(e.target.value) });
  $('clean').onchange = e => out({ cleanEdges: e.target.value });
  document.querySelectorAll('input[name=save]').forEach(r => r.addEventListener('change', async e => {
    if (e.target.value === 'folder' && !S.settings.outputDir) { S.settings = await api.pickOutputDir(); renderOptions(); }
    else setSettings({ outputMode: e.target.value });
  }));
  $('choose-dir').onclick = async () => { S.settings = await api.pickOutputDir(); renderOptions(); };
  $('gpu').onchange = e => setSettings({ useGpu: e.target.checked });
  $('model').onchange = async e => { S.settings = await api.useModel(e.target.value); refresh(); };
  $('data-folder').onclick = () => api.openDataFolder();
  segKeys($('lang'), async v => { await setSettings({ lang: v }); lang = v; applyWords(); renderModels(); renderOptions(); renderFooter(); renderList(); }, 'lang');
  $('help').onclick = () => api.openExternal('help');
  $('source').onclick = () => api.openExternal('repo');

  function renderFooter() {
    $('foot-model').textContent = t('foot.model', { m: modelName(S.settings.model) });
    $('foot-device').textContent = S.provider ? t('foot.device', { d: S.provider === 'gpu' ? 'GPU (DirectML)' : 'CPU' }) : '';
    $('foot-version').textContent = t('foot.version', { v: S.version });
  }

  /* ---------- the list ---------- */

  function addItems(list) {
    for (const it of list) items.set(it.id, it);
    if (list.length) toast(t('list.added', { n: list.length }));
    renderList();
  }

  /* the photo, or the cut-out once it is done */
  async function loadThumb(it, img) {
    const key = (it.status === 'done' ? 'a' : 'b') + it.id;
    if (!thumbs.has(key)) thumbs.set(key, await api.thumb(it.id, it.status === 'done' ? 'after' : 'before'));
    if (thumbs.get(key)) img.src = thumbs.get(key);
  }

  function statusText(it) {
    if (it.status === 'working') return t('st.' + (it.stage || 'load'));
    if (it.status === 'done') return t('st.done') + (it.ms ? ' · ' + t('st.seconds', { s: Math.max(1, Math.round(it.ms / 1000)) }) : '');
    if (it.status === 'failed') return t('st.failed');
    return t('st.waiting');
  }

  function itemEl(it) {
    const li = document.createElement('li');
    li.className = 'item ' + it.status; li.dataset.id = it.id;
    li.innerHTML = '<button type="button" class="thumb"><img alt=""></button><div class="meta"><span class="name"></span><span class="state"></span><span class="err"></span></div><button type="button" class="x">×</button>';
    const name = li.querySelector('.name'); name.textContent = it.name; name.title = it.dir + '\\' + it.name;
    li.querySelector('.state').textContent = statusText(it);
    li.querySelector('.err').textContent = it.status === 'failed' ? t('err.' + (window.I18N.en['err.' + it.error] ? it.error : 'ERROR')) : '';
    const thumb = li.querySelector('.thumb');
    thumb.setAttribute('aria-label', t('item.open') + ' ' + it.name);
    thumb.onclick = () => openPreview(it.id);
    const x = li.querySelector('.x');
    x.setAttribute('aria-label', t('item.remove') + ' ' + it.name); x.title = t('item.remove');
    x.disabled = queue.running;
    x.onclick = async () => { if (await api.removeItems([it.id])) { items.delete(it.id); renderList(); } };
    loadThumb(it, li.querySelector('img'));
    return li;
  }

  function renderList() {
    if (!S) return;
    const all = [...items.values()], done = all.filter(i => i.status === 'done').length, failed = all.filter(i => i.status === 'failed').length;
    const waiting = all.filter(i => i.status === 'waiting').length;
    $('drop').hidden = all.length > 0; $('list').hidden = all.length === 0;
    $('summary').textContent = t('list.summary', { n: all.length, done, failed });
    const grid = $('grid'), have = new Map([...grid.children].map(li => [Number(li.dataset.id), li]));
    for (const [id, li] of have) if (!items.has(id)) li.remove();
    for (const it of all) {
      const old = have.get(it.id), fresh = itemEl(it);
      if (old) old.replaceWith(fresh); else grid.append(fresh);
    }
    for (const id of ['add-files', 'add-folder', 'clear-done', 'clear-all', 'pick-files', 'pick-folder']) $(id).disabled = queue.running;
    const start = $('start');
    start.hidden = queue.running; $('stop').hidden = !queue.running;
    const n = waiting || failed;
    start.textContent = waiting ? t('run.start', { n: waiting }) : failed ? t('run.retry', { n: failed }) : all.length ? t('run.allDone') : t('run.nothing');
    start.disabled = !n || !S.settings.model;
    $('open-out').hidden = queue.running || !done;
    $('progress').hidden = !queue.running && !(queue.total && queue.done === queue.total && queue.total > 0);
    const pct = queue.total ? (queue.done / queue.total) * 100 : 0;
    $('run-bar').style.width = pct + '%';
    const runFailed = queue.failed || 0, runDone = queue.done - runFailed;
    $('run-text').textContent = queue.running
      ? (stopping ? t('run.stopping') : t('run.progress', { i: Math.min(queue.done + 1, queue.total), n: queue.total }))
      : runFailed ? t('run.finishedFailed', { done: runDone, failed: runFailed }) : t('run.finished', { done: runDone });
  }

  api.onItem(it => { items.set(it.id, it); if (it.status === 'done') thumbs.delete('a' + it.id); renderList(); if (pv.id === it.id && it.status === 'done') openPreview(it.id); });
  api.onQueue(q => {
    queue = q; if (!q.running) stopping = false;
    renderList(); renderOptions(); renderModels();
  });

  const pick = fn => async () => addItems(await fn());
  $('pick-files').onclick = $('add-files').onclick = pick(api.pickFiles);
  $('pick-folder').onclick = $('add-folder').onclick = pick(api.pickFolder);
  $('clear-done').onclick = async () => { const r = await api.clearItems('done'); if (r) { items.clear(); r.forEach(i => items.set(i.id, i)); renderList(); } };
  $('clear-all').onclick = async () => { if (await api.clearItems('all')) { items.clear(); renderList(); } };
  $('start').onclick = () => {
    const all = [...items.values()], waiting = all.filter(i => i.status === 'waiting');
    api.start((waiting.length ? waiting : all.filter(i => i.status === 'failed')).map(i => i.id));
  };
  $('stop').onclick = () => { stopping = true; api.stop(); renderList(); };
  $('open-out').onclick = () => { const it = [...items.values()].reverse().find(i => i.status === 'done'); if (it) api.showOutput(it.id); };

  /* drag and drop anywhere on the list side */
  const pane = $('list-pane'); let depth = 0;
  const dragging = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = !$('work').hidden && !queue.running ? 'copy' : 'none'; });
  document.addEventListener('drop', e => e.preventDefault());
  pane.addEventListener('dragenter', e => { if (!dragging(e) || queue.running) return; depth++; $('overlay').hidden = false; });
  pane.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('overlay').hidden = true; });
  pane.addEventListener('drop', async e => {
    e.preventDefault(); depth = 0; $('overlay').hidden = true;
    if (queue.running) return;
    const r = await api.addDropped(e.dataTransfer.files);
    if (r.length) addItems(r); else toast(t('list.none'));
  });

  /* ---------- preview ---------- */

  const pv = { id: 0, mode: 'compare', bg: 'checker', last: null };

  function setPvMode(m) { pv.mode = m; setSeg($('pv-mode'), m); $('pv-stage').dataset.mode = m; }
  segKeys($('pv-mode'), setPvMode);
  segKeys($('pv-bg'), v => { pv.bg = v; setSeg($('pv-bg'), v); $('pv-stage').dataset.bg = v; });

  async function openPreview(id) {
    const r = await api.preview(id);
    if (!r) return;
    pv.id = id; pv.last = r;
    $('pv-name').textContent = r.name;
    $('pv-before').src = r.before;
    if (r.after) $('pv-after').src = r.after; else $('pv-after').removeAttribute('src');
    $('pv-after').hidden = !r.after;
    $('pv-empty').hidden = !!r.after;
    $('pv-output').textContent = r.output || '';
    $('pv-show').disabled = !r.output;
    setPvMode(r.after ? pv.mode : 'compare');
    setSeg($('pv-bg'), pv.bg); $('pv-stage').dataset.bg = pv.bg;
    const ids = [...items.keys()], i = ids.indexOf(id);
    $('pv-prev').disabled = i <= 0; $('pv-next').disabled = i < 0 || i >= ids.length - 1;
    if ($('preview').hidden) { pv.returnFocus = document.activeElement; $('preview').hidden = false; $('pv-close').focus(); }
  }
  function closePreview() { $('preview').hidden = true; pv.id = 0; pv.returnFocus?.focus?.(); }
  const step = d => { const ids = [...items.keys()], i = ids.indexOf(pv.id); if (ids[i + d]) openPreview(ids[i + d]); };
  $('pv-close').onclick = closePreview;
  $('pv-prev').onclick = () => step(-1);
  $('pv-next').onclick = () => step(1);
  $('pv-show').onclick = () => api.showOutput(pv.id);
  $('preview').addEventListener('click', e => { if (e.target === $('preview')) closePreview(); });
  document.addEventListener('keydown', e => {
    if ($('preview').hidden) return;
    if (e.key === 'Escape') closePreview();
    else if (e.key === 'PageUp') step(-1);
    else if (e.key === 'PageDown') step(1);
    else if (e.key === 'Tab') {            // keep focus inside the dialog
      const f = [...$('preview').querySelectorAll('button:not([disabled]), input:not([hidden])')].filter(x => x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });

  refresh();
})();
