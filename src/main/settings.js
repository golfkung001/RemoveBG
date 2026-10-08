'use strict';
/* Settings kept in the user's app data folder (never in the install
   folder), so they survive updates and reinstalling. */
const fs = require('node:fs');
const path = require('node:path');
const { normaliseOptions, DEFAULTS } = require('../core/cutout');

const VERSION = 1;

function defaults() {
  return { version: VERSION, lang: 'th', model: '', useGpu: false, outputMode: 'beside', outputDir: '', output: { ...DEFAULTS } };
}

/* Any stored or incoming value made safe: unknown keys dropped, bad values reset. */
function sanitise(s) {
  const d = defaults(), r = { ...d };
  if (!s || typeof s !== 'object') return r;
  if (['th', 'en'].includes(s.lang)) r.lang = s.lang;
  if (['', 'general', 'lite'].includes(s.model)) r.model = s.model;
  r.useGpu = s.useGpu === true;
  if (['beside', 'folder'].includes(s.outputMode)) r.outputMode = s.outputMode;
  if (typeof s.outputDir === 'string' && s.outputDir.length < 1024 && (s.outputDir === '' || path.isAbsolute(s.outputDir))) r.outputDir = s.outputDir;
  if (r.outputMode === 'folder' && !r.outputDir) r.outputMode = 'beside';
  r.output = normaliseOptions({ ...d.output, ...(s.output && typeof s.output === 'object' ? pick(s.output, Object.keys(DEFAULTS)) : {}) });
  if (typeof r.output.colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(r.output.colour)) r.output.colour = DEFAULTS.colour;
  return r;
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

function load(file) {
  try { return sanitise(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return defaults(); }
}

function save(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(sanitise(s), null, 2));
  fs.renameSync(file + '.tmp', file);
}

module.exports = { VERSION, defaults, sanitise, load, save };
