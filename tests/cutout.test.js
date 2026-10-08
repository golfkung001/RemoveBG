'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const c = require('../src/core/cutout');

/* a 100 x 80 photo: white, with a dark 40 x 30 block at (30, 25) */
async function photo(bg = '#ffffff') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="${bg}"/><rect x="30" y="25" width="40" height="30" fill="#202833"/></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}
function blockMask(w = 100, h = 80, edge = 0) {
  const a = Buffer.alloc(w * h);
  for (let y = 25; y < 55; y++) for (let x = 30; x < 70; x++) a[y * w + x] = 255;
  if (edge) for (let y = 25; y < 55; y++) a[y * w + 29] = edge;   // a half-transparent rim on the left
  return a;
}
const decode = async buf => sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

test('options: bad values fall back, JPG never transparent', () => {
  assert.deepEqual(c.normaliseOptions({}), { ...c.DEFAULTS });
  const o = c.normaliseOptions({ format: 'gif', background: 'pink', margin: 99, maxSize: -5, cleanEdges: 'x' });
  assert.equal(o.format, 'png'); assert.equal(o.background, 'transparent');
  assert.equal(o.margin, 50); assert.equal(o.maxSize, 0); assert.equal(o.cleanEdges, 'auto');
  assert.equal(c.normaliseOptions({ format: 'jpg' }).background, 'white');
});

test('snapAlpha makes the body solid and the background empty', () => {
  const a = Buffer.from([0, 3, 6, 7, 128, 247, 248, 252, 255]);
  assert.deepEqual([...c.snapAlpha(a)], [0, 0, 0, 7, 128, 247, 255, 255, 255]);
});

test('contentBox finds the subject, or null when there is none', () => {
  assert.deepEqual(c.contentBox(blockMask(), 100, 80), { left: 30, top: 25, width: 40, height: 30 });
  assert.equal(c.contentBox(Buffer.alloc(100 * 80, 8), 100, 80), null);
});

test('a white studio photo is recognised; a coloured one is not', async () => {
  assert.equal(await c.isLightBackground(await photo('#ffffff')), true);
  assert.equal(await c.isLightBackground(await photo('#7a5230')), false);
});

test('edge clean-up removes the white a rim pixel was mixed with', () => {
  /* a rim pixel half product (#202833) and half white */
  const img = { rgb: Buffer.from([0x90, 0x94, 0x99]), width: 1, height: 1 };
  const a = Buffer.from([128]);
  const clean = c.compose(img, a, { decontaminate: true }), raw = c.compose(img, a, { decontaminate: false });
  assert.ok(clean[0] < 0x40 && clean[1] < 0x40 && clean[2] < 0x50, 'the rim turns back towards the product colour');
  assert.deepEqual([...raw.subarray(0, 3)], [0x90, 0x94, 0x99]);
  assert.equal(clean[3], 128);
});

test('render: trimmed transparent PNG with a margin', async () => {
  const r = await c.render(await photo(), blockMask(), { margin: 10 }, true);
  assert.equal(r.ext, 'png');
  const { data, info } = await decode(r.buffer);
  const pad = 4;                                   // 10% of 40
  assert.equal(info.width, 40 + 2 * pad); assert.equal(info.height, 30 + 2 * pad);
  assert.equal(data[3], 0, 'corner is transparent');
  assert.equal(data[((info.height >> 1) * info.width + (info.width >> 1)) * 4 + 3], 255, 'middle is solid');
});

test('render: not trimmed keeps the photo size', async () => {
  const r = await c.render(await photo(), blockMask(), { trim: false }, true);
  const { info } = await decode(r.buffer);
  assert.deepEqual([info.width, info.height], [100, 80]);
});

test('render: square, resized, JPG on a chosen colour', async () => {
  const r = await c.render(await photo(), blockMask(), { format: 'jpg', background: 'colour', colour: '#ff0000', margin: 0, square: true, maxSize: 20 }, true);
  assert.equal(r.ext, 'jpg');
  const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [20, 20, 3]);
  assert.ok(data[0] > 230 && data[1] < 40 && data[2] < 40, 'the empty corner is the chosen red');
});

test('render: WebP keeps transparency', async () => {
  const r = await c.render(await photo(), blockMask(), { format: 'webp' }, true);
  const { info } = await decode(r.buffer);
  assert.equal((await sharp(r.buffer).metadata()).format, 'webp');
  assert.equal(info.channels, 4);
});

test('render: an empty mask is reported, not saved', async () => {
  await assert.rejects(c.render(await photo(), Buffer.alloc(100 * 80), {}, true), e => e.code === 'EMPTY');
});

test('toTensor matches the rembg pre-processing', async () => {
  const img = await photo();
  const x = await c.toTensor(img);
  assert.equal(x.length, 3 * 1024 * 1024);
  /* the top-left corner is white: (1 - mean) / std per channel */
  const plane = 1024 * 1024;
  assert.ok(Math.abs(x[0] - (1 - 0.485) / 0.229) < 1e-4);
  assert.ok(Math.abs(x[plane] - (1 - 0.456) / 0.224) < 1e-4);
  assert.ok(Math.abs(x[2 * plane] - (1 - 0.406) / 0.225) < 1e-4);
});

test('toMask: sigmoid, full range, back to the photo size, no wrap-around', async () => {
  const logits = new Float32Array(1024 * 1024).fill(-3);
  for (let y = 300; y < 700; y++) for (let x = 300; x < 700; x++) logits[y * 1024 + x] = 3;
  const m = await c.toMask(logits, 200, 100);
  assert.equal(m.length, 200 * 100);
  assert.equal(m[0], 0, 'background is 0 (a float rounding below 0 must not become 255)');
  assert.equal(m[50 * 200 + 100], 255);
});
