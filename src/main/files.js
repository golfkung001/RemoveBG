'use strict';
/* Finding photos and naming results. Results never replace a photo. */
const fs = require('node:fs');
const path = require('node:path');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.gif']);
const OUTPUT_DIR = 'RemoveBG';
const MAX_FILES = 2000;

const isImage = f => IMAGE_EXT.has(path.extname(f).toLowerCase());

/* Photos in the given files and folders (folders are searched inside,
   skipping RemoveBG result folders and hidden folders). */
function collect(paths, limit = MAX_FILES) {
  const out = [], seen = new Set();
  const add = f => { const k = path.resolve(f); if (!seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k); } };
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 8 && e.name !== OUTPUT_DIR && !e.name.startsWith('.')) walk(full, depth + 1);
      } else if (e.isFile() && isImage(e.name)) add(full);
    }
  };
  for (const p of paths) {
    if (out.length >= limit) break;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, 0);
    else if (st.isFile() && isImage(p)) add(p);
  }
  return out;
}

/* Where a result goes: a RemoveBG folder beside the photo, or the chosen
   folder. An existing file is never replaced: "name (2).png" and so on. */
function outputPath(input, ext, { mode = 'beside', dir = '' } = {}) {
  const base = path.basename(input, path.extname(input));
  const folder = mode === 'folder' && dir ? dir : path.join(path.dirname(input), OUTPUT_DIR);
  fs.mkdirSync(folder, { recursive: true });
  let n = 1, file;
  do {
    file = path.join(folder, `${base}${n > 1 ? ` (${n})` : ''}.${ext}`);
    n++;
  } while (fs.existsSync(file) || path.resolve(file).toLowerCase() === path.resolve(input).toLowerCase());
  return file;
}

module.exports = { IMAGE_EXT, OUTPUT_DIR, MAX_FILES, isImage, collect, outputPath };
