'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const files = require('../src/main/files');
const settings = require('../src/main/settings');
const models = require('../src/main/models');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'removebg-test-'));

test('collect finds photos in files and folders, skips results and other files', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'สินค้า ใหม่', 'RemoveBG'), { recursive: true });
  fs.mkdirSync(path.join(d, '.hidden'));
  for (const f of ['a.JPG', 'b.png', 'notes.txt', 'สินค้า ใหม่/c.webp', 'สินค้า ใหม่/RemoveBG/c.png', '.hidden/d.jpg']) fs.writeFileSync(path.join(d, f), 'x');
  const got = files.collect([d, path.join(d, 'b.png')]).map(f => path.relative(d, f).split(path.sep).join('/'));
  assert.deepEqual(got.sort(), ['a.JPG', 'b.png', 'สินค้า ใหม่/c.webp'].sort());
  assert.deepEqual(files.collect([path.join(d, 'missing.jpg')]), []);
});

test('outputPath never replaces a file, including the photo itself', () => {
  const d = tmp(), photo = path.join(d, 'ลำโพง 1.jpg');
  fs.writeFileSync(photo, 'x');
  const first = files.outputPath(photo, 'png');
  assert.equal(first, path.join(d, 'RemoveBG', 'ลำโพง 1.png'));
  fs.writeFileSync(first, 'x');
  assert.equal(files.outputPath(photo, 'png'), path.join(d, 'RemoveBG', 'ลำโพง 1 (2).png'));
  /* saving into the photo's own folder with the same type */
  assert.equal(files.outputPath(photo, 'jpg', { mode: 'folder', dir: d }), path.join(d, 'ลำโพง 1 (2).jpg'));
});

test('settings: defaults, bad values reset, output dir only absolute', () => {
  assert.deepEqual(settings.sanitise(null), settings.defaults());
  const s = settings.sanitise({ lang: 'fr', model: 'huge', useGpu: 'yes', outputMode: 'folder', outputDir: 'relative/dir', output: { format: 'jpg', background: 'transparent', colour: 'red', extra: 1 } });
  assert.equal(s.lang, 'th'); assert.equal(s.model, ''); assert.equal(s.useGpu, false);
  assert.equal(s.outputMode, 'beside'); assert.equal(s.outputDir, '');
  assert.equal(s.output.format, 'jpg'); assert.equal(s.output.background, 'white'); assert.equal(s.output.colour, '#ffffff');
  assert.equal('extra' in s.output, false);
});

test('settings: saved and loaded again; a damaged file gives defaults', () => {
  const d = tmp(), f = path.join(d, 'settings.json');
  settings.save(f, { ...settings.defaults(), lang: 'en', output: { ...settings.defaults().output, format: 'webp', margin: 5 } });
  const s = settings.load(f);
  assert.equal(s.lang, 'en'); assert.equal(s.output.format, 'webp'); assert.equal(s.output.margin, 5);
  fs.writeFileSync(f, '{oops');
  assert.deepEqual(settings.load(f), settings.defaults());
});

test('the model list is complete', () => {
  for (const m of Object.values(models.MODELS)) {
    assert.match(m.url, /^https:\/\/github\.com\/danielgatis\/rembg\/releases\/download\//);
    assert.match(m.sha256, /^[0-9a-f]{64}$/); assert.match(m.md5, /^[0-9a-f]{32}$/);
    assert.ok(m.bytes > 100e6);
  }
  const d = tmp();
  assert.deepEqual(models.installed(d), { general: false, lite: false });
});

/* a small local server standing in for GitHub: serves `body`, honours Range,
   and can stop half-way once */
function server(body, { cutOnce = false } = {}) {
  let cut = cutOnce;
  const s = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { 'Content-Length': body.length - from });
    if (cut) { cut = false; res.write(body.subarray(from, from + (body.length >> 1))); setTimeout(() => res.destroy(), 20); return; }
    res.end(body.subarray(from));
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, url: `http://127.0.0.1:${s.address().port}/model.onnx` })));
}

test('download: resumes after an interruption and checks SHA-256', async () => {
  const body = crypto.randomBytes(300000), sha = crypto.createHash('sha256').update(body).digest('hex');
  const { s, url } = await server(body, { cutOnce: true });
  const d = tmp(), target = path.join(d, 'm.onnx'), seen = [];
  const opts = { url, bytes: body.length, sha256: sha, target, fetchImpl: fetch, isAllowed: () => true, onProgress: p => seen.push(p.stage) };
  await assert.rejects(models.fetchToFile(opts), e => e.code === 'INTERRUPTED');
  assert.ok(fs.statSync(target + '.part').size > 0, 'the partial file is kept');
  await models.fetchToFile(opts);
  assert.ok(fs.readFileSync(target).equals(body));
  assert.equal(fs.existsSync(target + '.part'), false);
  assert.ok(seen.includes('verify') && seen.includes('done'));
  s.close();
});

test('download: a damaged file is thrown away; other addresses are refused', async () => {
  const body = crypto.randomBytes(1000);
  const { s, url } = await server(body);
  const d = tmp(), target = path.join(d, 'm.onnx');
  await assert.rejects(models.fetchToFile({ url, bytes: 1000, sha256: '0'.repeat(64), target, fetchImpl: fetch, isAllowed: () => true }), e => e.code === 'CHECKSUM');
  assert.equal(fs.existsSync(target + '.part'), false);
  await assert.rejects(models.fetchToFile({ url, bytes: 1000, sha256: '0'.repeat(64), target, fetchImpl: fetch, isAllowed: () => false }), e => e.code === 'ADDRESS');
  s.close();
});

test('download: cancelling stops it', async () => {
  const body = crypto.randomBytes(1000);
  const { s, url } = await server(body);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(models.fetchToFile({ url, bytes: 1000, sha256: '0'.repeat(64), target: path.join(tmp(), 'm.onnx'), fetchImpl: fetch, signal: ac.signal, isAllowed: () => true }), e => e.code === 'CANCELLED');
  s.close();
});

test('importFile accepts only known models', async () => {
  const d = tmp(), f = path.join(d, 'other.onnx');
  fs.writeFileSync(f, 'not a model');
  await assert.rejects(models.importFile(path.join(d, 'models'), f), e => e.code === 'UNKNOWN_MODEL');
});
