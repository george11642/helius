#!/usr/bin/env node
// Rasterizes the Helius glyph (amber sun/compass on a night-ops background)
// into the PNG sizes the PWA manifest + index.html need, plus a static SVG
// favicon. Requires `sharp` (pnpm add -D sharp). Re-run any time the glyph
// or palette changes: `node scripts/make-icons.mjs`.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const BG = '#0a0e14';
const ACCENT = '#ffb454';

// `glyphScale` shrinks the glyph toward the center so maskable icons survive
// OS mask shapes (circle/squircle) that crop in from the edges.
function glyphSvg(size, glyphScale) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.5 * glyphScale;
  const sunR = r * 0.34;
  const rayInner = r * 0.46;
  const rayOuter = r * 0.92;
  const rayWidth = r * 0.1;

  const rays = Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(angle) * rayInner;
    const y1 = cy + Math.sin(angle) * rayInner;
    const x2 = cx + Math.cos(angle) * rayOuter;
    const y2 = cy + Math.sin(angle) * rayOuter;
    return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${ACCENT}" stroke-width="${rayWidth.toFixed(2)}" stroke-linecap="round" />`;
  }).join('\n    ');

  const corner = size * 0.18;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${corner}" fill="${BG}" />
    ${rays}
    <circle cx="${cx}" cy="${cy}" r="${sunR}" fill="${ACCENT}" />
  </svg>`;
}

async function renderPng(name, size, glyphScale) {
  const outDir = join(root, 'public', 'icons');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, name);
  await sharp(Buffer.from(glyphSvg(size, glyphScale))).png().toFile(outPath);
  return outPath;
}

const targets = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.6],
];

for (const [name, size, scale] of targets) {
  console.log('wrote', await renderPng(name, size, scale));
}

const faviconPath = join(root, 'public', 'favicon.svg');
await writeFile(faviconPath, glyphSvg(64, 1));
console.log('wrote', faviconPath);
