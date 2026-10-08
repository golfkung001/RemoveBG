'use strict';
/* Background removal for product photos.

   The steps are the ones used to cut out the Hi End Audio catalogue:
   1. BiRefNet (general) predicts a soft mask at 1024 x 1024. Pre- and
      post-processing match rembg's BiRefNet session, so the mask is the
      same one rembg would give.
   2. The model's alpha is rarely exactly 0 or 255: the near-solid body
      is snapped to 255 and the near-empty background to 0, so nothing
      shows through the product and no haze is left around it.
   3. On a white studio background, the white that a half-transparent
      edge pixel was mixed with is subtracted, so the product sits on a
      dark or coloured background without a light halo.
   4. The result can be trimmed to the product, placed on a colour,
      squared and resized, and is written as PNG, WebP or JPEG.        */
const sharp = require('sharp');

const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

sharp.cache(false);

/* Decode a photo upright, as 8-bit RGB. A photo that already has
   transparency is laid on white first. */
async function readImage(file) {
  const { data, info } = await sharp(file, { failOn: 'error', limitInputPixels: 100e6 })
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

/* The model input: the photo stretched to 1024 x 1024 (Lanczos), scaled
   by its brightest value and normalised with the ImageNet mean and
   deviation, as planar float32 (1 x 3 x 1024 x 1024). */
async function toTensor(img) {
  const small = await sharp(img.rgb, { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  let max = 0;
  for (let i = 0; i < small.length; i++) if (small[i] > max) max = small[i];
  const scale = 1 / Math.max(max, 1e-6), plane = SIZE * SIZE, out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (small[i * 3 + c] * scale - MEAN[c]) / STD[c];
  }
  return out;
}

/* The model output (logits for 1024 x 1024) to an 8-bit mask at the
   photo's size: sigmoid, stretched to the full 0..1 range, resized back. */
async function toMask(logits, width, height) {
  const plane = SIZE * SIZE, p = new Float64Array(plane);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < plane; i++) {
    const v = 1 / (1 + Math.exp(-logits[i]));
    p[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  /* clamped: a Buffer stores -1 as 255 */
  const span = hi - lo || 1, m = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) m[i] = Math.min(255, Math.max(0, Math.floor(((p[i] - lo) / span) * 255)));
  return sharp(m, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .extractChannel(0)
    .raw()
    .toBuffer();
}

function snapAlpha(alpha, hi = 248, lo = 6) {
  for (let i = 0; i < alpha.length; i++) alpha[i] = alpha[i] >= hi ? 255 : alpha[i] <= lo ? 0 : alpha[i];
  return alpha;
}

/* A white studio photo: at least a quarter of a thin border of the photo
   is near-white and neutral. */
async function isLightBackground(img) {
  const W = 32, H = 24;
  const data = await sharp(img.rgb, { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize(W, H, { fit: 'fill' }).raw().toBuffer();
  let n = 0, w = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x > 1 && x < W - 2 && y > 1 && y < H - 2) continue;
    const i = (y * W + x) * 3, lo = Math.min(data[i], data[i + 1], data[i + 2]), hi = Math.max(data[i], data[i + 1], data[i + 2]);
    n++; if (lo >= 222 && hi - lo <= 20) w++;
  }
  return w / n >= 0.25;
}

/* RGBA with the white removed from half-transparent edge pixels. */
function compose(img, alpha, { decontaminate }) {
  const N = img.width * img.height, rgba = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const a = alpha[i] / 255;
    for (let c = 0; c < 3; c++) {
      const v = img.rgb[i * 3 + c];
      rgba[i * 4 + c] = decontaminate && a > 0 && a < 1 ? Math.max(0, Math.min(255, Math.round((v - (1 - a) * 255) / a))) : v;
    }
    rgba[i * 4 + 3] = alpha[i];
  }
  return rgba;
}

/* The box around everything more than faintly visible, or null. */
function contentBox(alpha, width, height, threshold = 8) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] > threshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function parseColour(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return { r: 255, g: 255, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
}

const DEFAULTS = Object.freeze({
  format: 'png',          // png | webp | jpg
  background: 'transparent', // transparent | white | colour
  colour: '#ffffff',
  trim: true,             // crop to the product
  margin: 2,              // % of the product's longer side, added around it when trimmed
  square: false,          // centre on a square canvas
  maxSize: 0,             // longest side in px; 0 keeps the size
  cleanEdges: 'auto'      // auto | on | off: subtract white from the edge
});

function normaliseOptions(o = {}) {
  const r = { ...DEFAULTS, ...o };
  if (!['png', 'webp', 'jpg'].includes(r.format)) r.format = DEFAULTS.format;
  if (!['transparent', 'white', 'colour'].includes(r.background)) r.background = DEFAULTS.background;
  if (r.format === 'jpg' && r.background === 'transparent') r.background = 'white';
  r.margin = Math.max(0, Math.min(50, Number(r.margin) || 0));
  r.maxSize = Math.max(0, Math.min(20000, Math.round(Number(r.maxSize) || 0)));
  r.trim = !!r.trim; r.square = !!r.square;
  if (!['auto', 'on', 'off'].includes(r.cleanEdges)) r.cleanEdges = 'auto';
  return r;
}

/* Lay out and encode the cut-out. Returns { buffer, width, height, ext }. */
async function render(img, alpha, options, lightBackground) {
  const o = normaliseOptions(options);
  const decontaminate = o.cleanEdges === 'on' || (o.cleanEdges === 'auto' && lightBackground);
  const rgba = compose(img, alpha, { decontaminate });
  const box = contentBox(alpha, img.width, img.height);
  if (!box) throw Object.assign(new Error('No subject was found in this photo.'), { code: 'EMPTY' });

  let pipe = sharp(rgba, { raw: { width: img.width, height: img.height, channels: 4 } });
  let w = img.width, h = img.height;
  if (o.trim) {
    pipe = sharp(await pipe.extract(box).png().toBuffer());
    w = box.width; h = box.height;
    const pad = Math.round(Math.max(w, h) * o.margin / 100);
    if (pad) {
      pipe = sharp(await pipe.extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
      w += 2 * pad; h += 2 * pad;
    }
  }
  if (o.square && w !== h) {
    const side = Math.max(w, h), dx = side - w, dy = side - h;
    pipe = sharp(await pipe.extend({ left: dx >> 1, right: dx - (dx >> 1), top: dy >> 1, bottom: dy - (dy >> 1), background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
    w = h = side;
  }
  if (o.maxSize && Math.max(w, h) > o.maxSize) {
    const k = o.maxSize / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
    pipe = sharp(await pipe.resize(nw, nh, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer());
    w = nw; h = nh;
  }
  if (o.background !== 'transparent') {
    pipe = pipe.flatten({ background: o.background === 'white' ? '#ffffff' : parseColour(o.colour) });
  }
  let buffer;
  if (o.format === 'jpg') buffer = await pipe.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  else if (o.format === 'webp') buffer = await pipe.webp({ quality: 90, alphaQuality: 95, effort: 5 }).toBuffer();
  else buffer = await pipe.png({ compressionLevel: 8 }).toBuffer();
  return { buffer, width: w, height: h, ext: o.format };
}

module.exports = {
  SIZE, DEFAULTS, readImage, toTensor, toMask, snapAlpha, isLightBackground,
  compose, contentBox, parseColour, normaliseOptions, render
};
