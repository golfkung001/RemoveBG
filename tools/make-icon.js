'use strict';
/* build/icon.svg -> build/icon.png (512), build/icon.ico (16-256) and the
   window icon src/renderer/icon.png (256). Run after changing the SVG:
   node tools/make-icon.js */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'));
const png = size => sharp(svg, { density: 72 * size / 512 * 4 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

(async () => {
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), await png(512));
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'icon.png'), await png(256));
  /* ICO with PNG images (Windows Vista and later) */
  const sizes = [16, 24, 32, 48, 64, 128, 256], images = await Promise.all(sizes.map(png));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s === 256 ? 0 : s, e); head.writeUInt8(s === 256 ? 0 : s, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([head, ...images]));
  console.log('icons written');
})();
