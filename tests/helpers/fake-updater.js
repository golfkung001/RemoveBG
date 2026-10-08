'use strict';
/* A stand-in for electron-updater's autoUpdater, for tests and for trying
   the update screens without a release (REMOVEBG_FAKE_UPDATE=available|latest|error,
   development runs only). */
const { EventEmitter } = require('node:events');

class FakeUpdater extends EventEmitter {
  constructor(mode = 'available', { version = '9.9.9', size = 140e6, step = 250 } = {}) {
    super();
    Object.assign(this, { mode, version, size, step, installed: null, checks: 0, downloads: 0 });
  }
  info() { return { version: this.version, files: [{ url: `RemoveBG-Setup-${this.version}.exe`, size: this.size }], releaseNotes: '<p>Faster cut-outs</p><ul><li>New: batch rename</li></ul>' }; }
  later(fn) { return new Promise(r => setTimeout(() => { fn(); r(); }, this.step)); }
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    await this.later(() => {
      if (this.mode === 'error') this.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
      else if (this.mode === 'latest') this.emit('update-not-available', { version: '1.0.0' });
      else this.emit('update-available', this.info());
    });
    if (this.mode === 'error') throw new Error('net::ERR_INTERNET_DISCONNECTED');
  }
  async downloadUpdate() {
    this.downloads++;
    for (const pct of [8, 23, 41, 58, 77, 93]) {
      await this.later(() => this.emit('download-progress', { percent: pct, transferred: this.size * pct / 100, total: this.size, bytesPerSecond: 6.2e6 }));
    }
    await this.later(() => this.emit('update-downloaded', this.info()));
  }
  quitAndInstall(silent, runAfter) { this.installed = { silent, runAfter }; this.emit('fake-quit-and-install', this.installed); }
}

module.exports = { FakeUpdater };
