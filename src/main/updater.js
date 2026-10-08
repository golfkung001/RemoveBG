'use strict';
/* Update checks, through GitHub Releases (electron-updater).

   Nothing happens behind the user's back except the check itself: a new
   version is announced, downloaded when the user agrees (with progress),
   and installed when the user restarts (or when the app is closed).
   Every step is a state the window shows:

     idle → checking → latest | available → downloading → downloaded → installing
     any step can end in error; dev means "not an installed app"            */
const { EventEmitter } = require('node:events');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

class Updates extends EventEmitter {
  /* updater: electron-updater's autoUpdater (or a stand-in in tests)
     packaged: only installed apps can update
     isBusy: () => true while photos are being processed */
  constructor({ updater, version, packaged, isBusy = () => false, installDelayMs = 1500 }) {
    super();
    this.updater = updater; this.packaged = packaged; this.isBusy = isBusy; this.installDelayMs = installDelayMs;
    this.manual = false; this.timer = null;
    this.state = { status: packaged ? 'idle' : 'dev', current: version, version: '', notes: '', size: 0, percent: 0, transferred: 0, total: 0, speed: 0, error: '', manual: false, checkedAt: 0 };
    if (!updater) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = null;
    updater.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    updater.on('update-available', info => this.set({ status: 'available', ...describe(info), checkedAt: Date.now() }));
    updater.on('update-not-available', () => this.set({ status: 'latest', checkedAt: Date.now() }));
    updater.on('download-progress', p => this.set({
      status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))),
      transferred: p.transferred || 0, total: p.total || this.state.size, speed: p.bytesPerSecond || 0
    }));
    updater.on('update-downloaded', info => this.set({ status: 'downloaded', ...describe(info), percent: 100 }));
    updater.on('error', e => this.set({ status: 'error', error: friendly(e), stage: this.state.status }));
  }

  set(patch) {
    this.state = { ...this.state, ...patch, manual: this.manual };
    this.emit('state', this.state);
  }

  /* manual: the user pressed "check for updates" (the window then also says
     when there is nothing new) */
  async check(manual = false) {
    if (!this.packaged || !this.updater) { this.manual = manual; this.set({ status: 'dev' }); return this.state; }
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.state;
    if (this.state.status === 'downloaded') return this.state;       // already waiting for a restart
    this.manual = manual;
    try { await this.updater.checkForUpdates(); }
    catch (e) { this.set({ status: 'error', error: friendly(e), stage: 'checking' }); }
    return this.state;
  }

  async download() {
    if (this.state.status !== 'available' && !(this.state.status === 'error' && this.state.version)) return false;
    this.set({ status: 'downloading', percent: 0, transferred: 0, error: '' });
    try { await this.updater.downloadUpdate(); return true; }
    catch (e) { this.set({ status: 'error', error: friendly(e), stage: 'downloading' }); return false; }
  }

  /* Close and run the installer; it opens the new version when done.
     Not while photos are being processed. */
  install() {
    if (this.state.status !== 'downloaded' || this.isBusy()) return false;
    this.set({ status: 'installing' });
    setTimeout(() => this.updater.quitAndInstall(false, true), this.installDelayMs);
    return true;
  }

  /* first check soon after start, then every few hours */
  start(firstDelayMs = 8000) {
    if (!this.packaged || !this.updater || this.timer) return;
    this.timer = setTimeout(() => {
      this.check(false);
      this.timer = setInterval(() => this.check(false), CHECK_EVERY_MS);
    }, firstDelayMs);
  }

  stop() { clearTimeout(this.timer); clearInterval(this.timer); this.timer = null; }
}

function describe(info = {}) {
  const file = (info.files || [])[0] || {};
  let notes = info.releaseNotes || '';
  if (Array.isArray(notes)) notes = notes.map(n => n.note || '').join('\n');
  notes = String(notes).replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, 600);
  return { version: String(info.version || ''), notes, size: Number(file.size) || 0, total: Number(file.size) || 0 };
}

function friendly(e) {
  const m = String((e && (e.message || e.code)) || e || 'Unknown error');
  if (/ENOTFOUND|EAI_AGAIN|ECONNRE|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|net::/i.test(m)) return 'NETWORK';
  if (/sha512 checksum mismatch|checksum/i.test(m)) return 'CHECKSUM';
  if (/404|latest\.yml|Cannot find/i.test(m)) return 'NO_RELEASE';
  return m.split('\n')[0].slice(0, 200);
}

/* "1.2.10" > "1.2.9" */
function newer(a, b) {
  const p = v => String(v || '').replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

module.exports = { Updates, describe, friendly, newer, CHECK_EVERY_MS };
