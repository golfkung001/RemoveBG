'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Updates, describe, friendly, newer } = require('../src/main/updater');
const { FakeUpdater } = require('./helpers/fake-updater');

const track = u => { const seen = []; u.on('state', s => seen.push(s.status)); return seen; };

test('a new version: announced, downloaded with progress, installed on request', async () => {
  const fake = new FakeUpdater('available', { step: 1 });
  const u = new Updates({ updater: fake, version: '1.0.0', packaged: true, installDelayMs: 1 });
  const seen = track(u);
  assert.equal(fake.autoDownload, false, 'nothing is downloaded without asking');
  assert.equal(fake.autoInstallOnAppQuit, true);
  await u.check(true);
  assert.equal(u.state.status, 'available');
  assert.equal(u.state.version, '9.9.9'); assert.equal(u.state.size, 140e6);
  assert.match(u.state.notes, /Faster cut-outs/); assert.doesNotMatch(u.state.notes, /</);
  await u.download();
  assert.equal(u.state.status, 'downloaded');
  assert.ok(seen.filter(s => s === 'downloading').length >= 3, 'progress is reported');
  await u.check();                                   // a check while waiting for a restart changes nothing
  assert.equal(u.state.status, 'downloaded'); assert.equal(fake.checks, 1);
  assert.equal(u.install(), true);
  assert.equal(u.state.status, 'installing');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(fake.installed, { silent: false, runAfter: true }, 'the installer shows its progress and opens the app again');
});

test('install waits while photos are being processed', async () => {
  let busy = true;
  const fake = new FakeUpdater('available', { step: 1 });
  const u = new Updates({ updater: fake, version: '1.0.0', packaged: true, isBusy: () => busy, installDelayMs: 1 });
  await u.check(); await u.download();
  assert.equal(u.install(), false); assert.equal(u.state.status, 'downloaded');
  busy = false;
  assert.equal(u.install(), true);
});

test('up to date, errors, and copies that are not installed', async () => {
  const latest = new Updates({ updater: new FakeUpdater('latest', { step: 1 }), version: '1.0.0', packaged: true });
  await latest.check(true);
  assert.equal(latest.state.status, 'latest'); assert.equal(latest.state.manual, true);

  const offline = new Updates({ updater: new FakeUpdater('error', { step: 1 }), version: '1.0.0', packaged: true });
  await offline.check(true);
  assert.equal(offline.state.status, 'error'); assert.equal(offline.state.error, 'NETWORK');

  const dev = new Updates({ updater: null, version: '1.0.0', packaged: false });
  await dev.check(true);
  assert.equal(dev.state.status, 'dev');
  assert.equal(await dev.download(), false);
});

test('a failed download can be tried again', async () => {
  const fake = new FakeUpdater('available', { step: 1 });
  const u = new Updates({ updater: fake, version: '1.0.0', packaged: true });
  await u.check();
  fake.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
  assert.equal(await u.download(), false);
  assert.equal(u.state.status, 'error'); assert.equal(u.state.error, 'CHECKSUM'); assert.equal(u.state.stage, 'downloading');
  delete fake.downloadUpdate;
  assert.equal(await u.download(), true);
  assert.equal(u.state.status, 'downloaded');
});

test('helpers: versions, messages, release info', () => {
  assert.equal(newer('1.0.10', '1.0.9'), true);
  assert.equal(newer('1.0.0', '1.0.0'), false);
  assert.equal(newer('v2.0.0', '1.9.9'), true);
  assert.equal(newer('1.0.0', '1.1.0'), false);
  assert.equal(friendly(new Error('net::ERR_NAME_NOT_RESOLVED')), 'NETWORK');
  assert.equal(friendly(new Error('Cannot find latest.yml in the latest release artifacts')), 'NO_RELEASE');
  assert.deepEqual(describe({ version: '1.2.3', files: [{ size: 5 }], releaseNotes: [{ note: '<b>Hi</b>' }] }), { version: '1.2.3', notes: 'Hi', size: 5, total: 5 });
});
