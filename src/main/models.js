'use strict';
/* The AI models the app can use, and their download.

   Both are BiRefNet "general" exports published with rembg
   (https://github.com/danielgatis/rembg, MIT) from BiRefNet
   (https://github.com/ZhengPeng7/BiRefNet, MIT). The checksums are the
   ones rembg verifies, plus SHA-256 of the same files. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MODELS = Object.freeze({
  general: Object.freeze({
    id: 'general',
    file: 'birefnet-general.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx',
    bytes: 972666916,
    md5: '7a35a0141cbbc80de11d9c9a28f52697',
    sha256: '58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c'
  }),
  lite: Object.freeze({
    id: 'lite',
    file: 'birefnet-general-lite.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx',
    bytes: 224005088,
    md5: '4fab47adc4ff364be1713e97b7e66334',
    sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333'
  })
});

const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function modelPath(dir, id) { return path.join(dir, MODELS[id].file); }

function installed(dir) {
  const out = {};
  for (const m of Object.values(MODELS)) {
    let ok = false;
    try { ok = fs.statSync(modelPath(dir, m.id)).size === m.bytes; } catch { /* missing */ }
    out[m.id] = ok;
  }
  return out;
}

function hashFile(file, algorithm, onProgress) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algorithm), s = fs.createReadStream(file, { highWaterMark: 4 << 20 });
    let done = 0;
    s.on('data', b => { h.update(b); done += b.length; onProgress?.(done); });
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/* Which known model a file is, by size and SHA-256, or null. */
async function identify(file, onProgress) {
  const size = fs.statSync(file).size;
  const m = Object.values(MODELS).find(x => x.bytes === size);
  if (!m) return null;
  return (await hashFile(file, 'sha256', onProgress)) === m.sha256 ? m : null;
}

const fail = (message, code) => Object.assign(new Error(message), { code });

/* Fetch url into target. A partial download (target.part) is resumed; the
   file is only put in place once its size and SHA-256 match. fetchImpl is
   Electron's net.fetch in the app (system proxy settings apply).
   isAllowed(url) checks every address the download ends up at. */
async function fetchToFile({ url, bytes, sha256, target, fetchImpl, signal, onProgress, isAllowed }) {
  const part = target + '.part';
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* fresh */ }
  if (have > bytes) { fs.rmSync(part, { force: true }); have = 0; }
  if (have < bytes) {
    if (!isAllowed(url)) throw fail('Unexpected download address', 'ADDRESS');
    let res;
    try {
      res = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow', signal });
    } catch (e) {
      throw signal?.aborted ? fail('Cancelled', 'CANCELLED') : fail('Could not connect: ' + (e.message || e), 'NETWORK');
    }
    if (res.url && !isAllowed(res.url)) throw fail('Unexpected download address', 'ADDRESS');
    if (res.status === 200 && have) have = 0;            // the server ignored the range: start over
    else if (res.status !== 200 && res.status !== 206) throw fail('Download failed (HTTP ' + res.status + ')', 'HTTP');
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    const closed = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
    let got = have, last = 0;
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        got += chunk.length;
        const now = Date.now();
        if (now - last > 200) { last = now; onProgress?.({ stage: 'download', done: got, total: bytes }); }
      }
    } catch (e) {
      out.end(); await closed.catch(() => {});
      throw signal?.aborted ? fail('Cancelled', 'CANCELLED') : fail('The download was interrupted. Try again to continue it.', 'INTERRUPTED');
    }
    out.end(); await closed;
    if (signal?.aborted) throw fail('Cancelled', 'CANCELLED');
    if (got !== bytes) throw fail('The download was interrupted. Try again to continue it.', 'INTERRUPTED');
  }
  onProgress?.({ stage: 'verify', done: 0, total: bytes });
  const sha = await hashFile(part, 'sha256', d => onProgress?.({ stage: 'verify', done: d, total: bytes }));
  if (sha !== sha256) {
    fs.rmSync(part, { force: true });
    throw fail('The downloaded file is damaged. Please download it again.', 'CHECKSUM');
  }
  fs.renameSync(part, target);
  onProgress?.({ stage: 'done', done: bytes, total: bytes });
  return target;
}

const githubOnly = u => { try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED_HOSTS.has(x.hostname); } catch { return false; } };

/* Download a known model into dir. Returns { promise, cancel }. */
function download(dir, id, { fetchImpl, onProgress }) {
  const m = MODELS[id];
  if (!m) throw fail('Unknown model', 'UNKNOWN_MODEL');
  fs.mkdirSync(dir, { recursive: true });
  const ac = new AbortController();
  const promise = fetchToFile({ url: m.url, bytes: m.bytes, sha256: m.sha256, target: modelPath(dir, id), fetchImpl, signal: ac.signal, onProgress, isAllowed: githubOnly });
  return { promise, cancel: () => ac.abort() };
}

/* Copy a model file the user already has into dir, if it is a known one. */
async function importFile(dir, file, onProgress) {
  const m = await identify(file, onProgress);
  if (!m) throw Object.assign(new Error('This file is not one of the supported BiRefNet models.'), { code: 'UNKNOWN_MODEL' });
  fs.mkdirSync(dir, { recursive: true });
  const target = modelPath(dir, m.id);
  if (path.resolve(file) !== path.resolve(target)) {
    fs.copyFileSync(file, target + '.part');
    fs.renameSync(target + '.part', target);
  }
  return m.id;
}

module.exports = { MODELS, modelPath, installed, identify, hashFile, fetchToFile, download, importFile };
