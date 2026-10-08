'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, net, utilityProcess, powerSaveBlocker, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const models = require('./models');
const files = require('./files');
const settingsStore = require('./settings');

const REPO = 'https://github.com/golfkung001/RemoveBG';
const EXTERNAL = { repo: REPO, help: REPO + '#readme', issues: REPO + '/issues' };

if (process.env.REMOVEBG_USER_DATA) app.setPath('userData', path.resolve(process.env.REMOVEBG_USER_DATA));
const selfTestArg = process.argv.find(a => a.startsWith('--self-test='));
if (!selfTestArg && !app.requestSingleInstanceLock()) app.exit(0);

/* files that native code reads must come from outside the app archive */
const unpacked = p => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const dataDir = () => app.getPath('userData');
const modelDir = () => path.join(dataDir(), 'models');
const settingsFile = () => path.join(dataDir(), 'settings.json');

let win = null, settings = null;

/* ---------- the AI process ---------- */

class WorkerHost {
  constructor() { this.proc = null; this.loaded = null; this.pending = new Map(); this.waiters = []; this.provider = ''; }

  start() {
    if (this.proc) return;
    const proc = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { serviceName: 'RemoveBG AI', stdio: process.env.REMOVEBG_DEBUG ? 'pipe' : 'ignore' });
    if (process.env.REMOVEBG_DEBUG) { const log = d => fs.appendFileSync(process.env.REMOVEBG_DEBUG, String(d)); proc.stdout?.on('data', log); proc.stderr?.on('data', log); }
    this.proc = proc; this.loaded = null;
    proc.on('message', m => this.onMessage(m));
    proc.on('exit', code => {
      if (process.env.REMOVEBG_DEBUG) fs.appendFileSync(process.env.REMOVEBG_DEBUG, '[ai] exit ' + code + '\n');
      if (this.proc !== proc) return;             // an older process, already replaced
      this.proc = null; this.loaded = null;
      const err = { code: 'CRASH', message: 'The AI process stopped (exit ' + code + '). This usually means the computer ran out of memory.' };
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      for (const w of this.waiters.splice(0)) w.reject(err);
    });
  }

  onMessage(m) {
    if (m.type === 'loaded') { this.provider = m.provider; for (const w of this.waiters.splice(0)) w.resolve(m.provider); }
    else if (m.type === 'error') { this.loaded = null; for (const w of this.waiters.splice(0)) w.reject({ code: 'LOAD', message: m.message }); }
    else if (m.type === 'stage') this.pending.get(m.id)?.stage(m.stage);
    else if (m.type === 'done') { this.pending.get(m.id)?.resolve(m); this.pending.delete(m.id); }
    else if (m.type === 'failed') { this.pending.get(m.id)?.reject(m); this.pending.delete(m.id); }
  }

  /* Load (or switch to) a model; resolves with 'cpu' or 'gpu'. */
  load(modelPath, useGpu) {
    const key = modelPath + '|' + useGpu;
    if (this.proc && this.loaded?.key === key) return this.loaded.promise;
    this.start();
    const promise = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    promise.catch(() => { if (this.loaded?.key === key) this.loaded = null; });
    this.loaded = { key, promise };
    this.proc.postMessage({ type: 'load', modelPath, useGpu });
    return promise;
  }

  run(job, onStage) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject({ code: 'CRASH', message: 'The AI process is not running.' });
      this.pending.set(job.id, { resolve, reject, stage: onStage });
      this.proc.postMessage({ type: 'job', ...job });
    });
  }

  stop() {
    if (!this.proc) return;
    const err = { code: 'CRASH', message: 'The AI process was stopped.' };
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    for (const w of this.waiters.splice(0)) w.reject(err);
    this.proc.kill(); this.proc = null; this.loaded = null;
  }
}

const worker = new WorkerHost();

/* ---------- photos in the list ---------- */

const items = new Map();       // id -> { id, path, name, status, output, error, ms }
let nextId = 1, running = false, stopRequested = false, blocker = null, idleTimer = null;
const IDLE_MS = 2 * 60 * 1000;      // the loaded model holds 0.5-2 GB: let it go when not in use

const publicItem = it => ({ id: it.id, name: it.name, dir: path.dirname(it.path), status: it.status, stage: it.stage || '', output: it.output ? path.basename(it.output) : '', error: it.error || '', ms: it.ms || 0, width: it.width || 0, height: it.height || 0 });
const emit = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

function addPaths(paths) {
  const known = new Set([...items.values()].map(i => i.path.toLowerCase()));
  const added = [];
  for (const f of files.collect(paths.filter(p => typeof p === 'string' && path.isAbsolute(p)))) {
    if (items.size >= files.MAX_FILES) break;
    if (known.has(f.toLowerCase())) continue;
    const it = { id: nextId++, path: f, name: path.basename(f), status: 'waiting' };
    items.set(it.id, it); known.add(f.toLowerCase()); added.push(publicItem(it));
  }
  return added;
}

const modelReady = () => !!settings.model && models.installed(modelDir())[settings.model];

async function runQueue(ids) {
  if (running) return;
  if (!modelReady()) throw new Error('NO_MODEL');
  running = true; stopRequested = false;
  clearTimeout(idleTimer);
  blocker = powerSaveBlocker.start('prevent-app-suspension');
  const todo = (ids?.length ? ids.map(Number).map(id => items.get(id)) : [...items.values()]).filter(it => it && (it.status === 'waiting' || it.status === 'failed'));
  let done = 0, failed = 0;
  emit('queue', { running: true, total: todo.length, done, failed });
  try {
    for (const it of todo) {
      if (stopRequested) break;
      if (!items.has(it.id)) continue;
      it.status = 'working'; it.stage = 'load'; it.error = '';
      emit('item', publicItem(it));
      try {
        const before = worker.provider;
        await worker.load(models.modelPath(modelDir(), settings.model), settings.useGpu);
        if (worker.provider !== before) emit('status', status());
        const output = files.outputPath(it.path, settings.output.format, { mode: settings.outputMode, dir: settings.outputDir });
        const r = await worker.run({ id: it.id, input: it.path, output, options: settings.output }, stage => { it.stage = stage; emit('item', publicItem(it)); });
        Object.assign(it, { status: 'done', stage: '', output: r.output, ms: r.ms, width: r.width, height: r.height });
      } catch (e) {
        Object.assign(it, { status: 'failed', stage: '', error: e.code || 'ERROR', detail: e.message || String(e) });
        failed++;
      }
      emit('item', publicItem(it));
      done++;
      emit('queue', { running: true, total: todo.length, done, failed });
      win?.setProgressBar(done / Math.max(1, todo.length));
    }
  } finally {
    running = false;
    idleTimer = setTimeout(() => { if (!running) worker.stop(); }, IDLE_MS);
    if (blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
    win?.setProgressBar(-1);
    if (win && !win.isFocused()) win.flashFrame(true);
    emit('queue', { running: false, total: todo.length, done, failed, stopped: stopRequested });
  }
}

/* ---------- model download ---------- */

let downloading = null;

function status() {
  return {
    version: app.getVersion(),
    settings,
    models: Object.fromEntries(Object.values(models.MODELS).map(m => [m.id, { bytes: m.bytes, installed: models.installed(modelDir())[m.id] }])),
    downloading: downloading ? downloading.id : '',
    provider: worker.provider,
    totalMemGB: Math.round(os.totalmem() / 2 ** 30),
    dark: nativeTheme.shouldUseDarkColors
  };
}

/* ---------- IPC: every call checks what it is given ---------- */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error('Not allowed');
    return fn(...args);
  });
}

function registerIpc() {
  handle('status', () => status());

  handle('settings:set', patch => {
    if (!patch || typeof patch !== 'object') return settings;
    const merged = { ...settings, ...patch, output: { ...settings.output, ...(patch.output || {}) } };
    if ('outputDir' in patch) merged.outputDir = settings.outputDir;     // only set through the folder dialog
    settings = settingsStore.sanitise(merged);
    settingsStore.save(settingsFile(), settings);
    return settings;
  });

  handle('model:download', id => {
    if (downloading || !models.MODELS[id]) return false;
    const job = models.download(modelDir(), id, { fetchImpl: (u, o) => net.fetch(u, o), onProgress: p => emit('model:progress', { id, ...p }) });
    downloading = { id, cancel: job.cancel };
    job.promise.then(() => {
      settings = settingsStore.sanitise({ ...settings, model: id });
      settingsStore.save(settingsFile(), settings);
      emit('model:progress', { id, stage: 'done' });
    }, e => emit('model:progress', { id, stage: 'error', code: e.code || 'ERROR', message: e.message }))
      .finally(() => { downloading = null; emit('status', status()); });
    return true;
  });

  handle('model:cancel', () => { downloading?.cancel(); return true; });

  handle('model:import', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'ONNX model', extensions: ['onnx'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    try {
      const id = await models.importFile(modelDir(), r.filePaths[0], d => emit('model:progress', { id: 'import', stage: 'verify', done: d, total: fs.statSync(r.filePaths[0]).size }));
      settings = settingsStore.sanitise({ ...settings, model: id });
      settingsStore.save(settingsFile(), settings);
      return { ok: true, id };
    } catch (e) { return { ok: false, code: e.code || 'ERROR' }; }
  });

  handle('model:use', id => {
    if (!models.MODELS[id] || !models.installed(modelDir())[id]) return settings;
    settings = settingsStore.sanitise({ ...settings, model: id });
    settingsStore.save(settingsFile(), settings);
    return settings;
  });

  handle('files:pick', async kind => {
    const r = await dialog.showOpenDialog(win, kind === 'folder'
      ? { properties: ['openDirectory', 'multiSelections'] }
      : { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: [...files.IMAGE_EXT].map(e => e.slice(1)) }] });
    return r.canceled ? [] : addPaths(r.filePaths);
  });

  handle('files:add', paths => Array.isArray(paths) ? addPaths(paths.slice(0, files.MAX_FILES)) : []);

  handle('files:remove', ids => {
    if (running) return false;
    for (const id of Array.isArray(ids) ? ids : [ids]) items.delete(Number(id));
    return true;
  });

  handle('files:clear', which => {
    if (running) return false;
    for (const [id, it] of items) if (which === 'all' || it.status === 'done') items.delete(id);
    return [...items.values()].map(publicItem);
  });

  handle('thumb', async (id, which) => {
    const it = items.get(Number(id));
    if (!it) return '';
    try {
      if (which === 'after' && it.output && fs.existsSync(it.output)) {
        const b = await sharp(it.output).resize(240, 240, { fit: 'inside' }).png().toBuffer();
        return 'data:image/png;base64,' + b.toString('base64');
      }
      const b = await sharp(it.path, { limitInputPixels: 100e6 }).rotate().resize(240, 240, { fit: 'inside' }).flatten({ background: '#ffffff' }).jpeg({ quality: 75 }).toBuffer();
      return 'data:image/jpeg;base64,' + b.toString('base64');
    } catch { return ''; }
  });

  handle('preview', async id => {
    const it = items.get(Number(id));
    if (!it) return null;
    const show = async (f, png) => {
      const p = sharp(f, { limitInputPixels: 100e6 }).rotate().resize(1400, 1400, { fit: 'inside', withoutEnlargement: true });
      const b = png ? await p.png().toBuffer() : await p.flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
      return `data:image/${png ? 'png' : 'jpeg'};base64,` + b.toString('base64');
    };
    try {
      return { before: await show(it.path, false), after: it.output && fs.existsSync(it.output) ? await show(it.output, true) : '', name: it.name, output: it.output ? path.basename(it.output) : '' };
    } catch { return null; }
  });

  handle('queue:start', async ids => {
    try { runQueue(Array.isArray(ids) ? ids : null).catch(() => {}); return true; } catch { return false; }
  });
  handle('queue:stop', () => { stopRequested = true; return true; });

  handle('output:show', id => {
    const it = items.get(Number(id));
    if (it?.output && fs.existsSync(it.output)) shell.showItemInFolder(it.output);
    else if (it) shell.openPath(settings.outputMode === 'folder' && settings.outputDir ? settings.outputDir : path.dirname(it.path));
    return true;
  });

  handle('output:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return settings;
    settings = settingsStore.sanitise({ ...settings, outputMode: 'folder', outputDir: r.filePaths[0] });
    settingsStore.save(settingsFile(), settings);
    return settings;
  });

  handle('open:external', key => { if (EXTERNAL[key]) shell.openExternal(EXTERNAL[key]); return true; });
  handle('open:data', () => { shell.openPath(dataDir()); return true; });
}

/* ---------- window ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 920, minHeight: 640,
    title: 'RemoveBG', show: false, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f5f6f8',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => { win = null; });
  nativeTheme.on('updated', () => emit('status', status()));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/* ---------- packaged self-test: proves the AI runtime and image library
   load and work in the installed app, with a tiny stand-in model ---------- */

async function selfTest(outFile) {
  const result = { ok: false, steps: [] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'removebg-selftest-'));
  try {
    const input = path.join(tmp, 'ทดสอบ photo.png');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#fff"/><rect x="220" y="120" width="200" height="240" rx="20" fill="#1d2430"/></svg>';
    await sharp(Buffer.from(svg)).png().toFile(input);
    result.steps.push('image library');
    const provider = await worker.load(unpacked(path.join(__dirname, '..', 'assets', 'self-test-model.onnx')), false);
    result.steps.push('ai runtime ' + provider);
    const output = files.outputPath(input, 'png');
    await worker.run({ id: 1, input, output, options: { format: 'png', trim: true, margin: 0 } }, () => {});
    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const a = (x, y) => data[(y * info.width + x) * 4 + 3];
    result.size = [info.width, info.height];
    result.ok = info.channels === 4 && a(Math.floor(info.width / 2), Math.floor(info.height / 2)) > 200 && a(0, 0) === 0 && Math.abs(info.width - 200) <= 6 && Math.abs(info.height - 240) <= 6;
    result.steps.push('cut-out written');
  } catch (e) {
    result.error = String(e.message || e);
  } finally {
    worker.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  return result.ok;
}

/* ---------- start ---------- */

app.setAppUserModelId('io.github.golfkung001.removebg');

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  if (selfTestArg) {
    const ok = await selfTest(path.resolve(selfTestArg.slice('--self-test='.length)));
    app.exit(ok ? 0 : 1);
    return;
  }
  settings = settingsStore.load(settingsFile());
  /* a model chosen earlier but deleted since; or the first one found */
  const have = models.installed(modelDir());
  if (!have[settings.model]) settings.model = have.general ? 'general' : have.lite ? 'lite' : '';
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => { worker.stop(); downloading?.cancel(); app.quit(); });
app.on('before-quit', () => worker.stop());
