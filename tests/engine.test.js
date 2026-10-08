'use strict';
/* End to end with the tiny stand-in model (src/assets/self-test-model.onnx):
   photo file -> ONNX Runtime -> mask -> trimmed transparent PNG.
   Set REMOVEBG_MODEL to a real BiRefNet .onnx file to also run it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const sharp = require('sharp');
const { Engine } = require('../src/core/engine');

const TINY = path.join(__dirname, '..', 'src', 'assets', 'self-test-model.onnx');

async function scene(dir) {
  const f = path.join(dir, 'ทดสอบ photo.png');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#fff"/><rect x="220" y="120" width="200" height="240" rx="20" fill="#1d2430"/></svg>';
  await sharp(Buffer.from(svg)).png().toFile(f);
  return f;
}

test('engine cuts out the subject (stand-in model)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'removebg-engine-'));
  const e = await Engine.load(TINY);
  assert.equal(e.provider, 'cpu');
  const r = await e.process(await scene(dir), { margin: 0 });
  const { data, info } = await sharp(r.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(Math.abs(info.width - 200) <= 4 && Math.abs(info.height - 240) <= 4, `trimmed to the block (${info.width}x${info.height})`);
  assert.equal(data[3], 0);
  assert.ok(data[((info.height >> 1) * info.width + (info.width >> 1)) * 4 + 3] > 200);
  await e.close();
});

test('worker process: loads, cuts, writes, reports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'removebg-worker-'));
  const input = await scene(dir), output = path.join(dir, 'out.webp');
  const w = fork(path.join(__dirname, '..', 'src', 'main', 'worker.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const next = type => new Promise(r => { const h = m => { if (type.includes(m.type)) { w.off('message', h); r(m); } }; w.on('message', h); });
  await next(['started']);
  w.send({ type: 'job', id: 1, input, output, options: {} });
  assert.equal((await next(['failed'])).code, 'NO_MODEL');
  w.send({ type: 'load', modelPath: TINY });
  assert.equal((await next(['loaded'])).provider, 'cpu');
  for (let id = 2; id <= 3; id++) {               // two photos in a row on one session
    w.send({ type: 'job', id, input, output: output.replace('.webp', id + '.webp'), options: { format: 'webp' } });
    const m = await next(['done', 'failed']);
    assert.equal(m.type, 'done', m.message);
    assert.equal((await sharp(m.output).metadata()).format, 'webp');
  }
  w.send({ type: 'job', id: 4, input: path.join(dir, 'missing.jpg'), output, options: {} });
  assert.equal((await next(['done', 'failed'])).type, 'failed');
  w.send({ type: 'quit' });
  await new Promise(r => w.on('exit', r));
});

test('real model (REMOVEBG_MODEL)', { skip: !process.env.REMOVEBG_MODEL }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'removebg-real-'));
  const e = await Engine.load(process.env.REMOVEBG_MODEL);
  const r = await e.process(await scene(dir), { margin: 0 });
  const { info } = await sharp(r.buffer).metadata().then(m => ({ info: m }));
  assert.ok(info.width > 150 && info.width < 260 && info.height > 190 && info.height < 300, `${info.width}x${info.height}`);
  await e.close();
});
