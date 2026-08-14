// Renders a demo sheet to PNG through the real export path, for eyeballing.
//   node tests/preview.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

globalThis.window = { requestIdleCallback: (f) => setTimeout(() => f({ timeRemaining: () => 5 }), 0) };
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this._c = createCanvas(w, h); this.width = w; this.height = h; }
  getContext(t, a) { return this._c.getContext(t, a); }
  async convertToBlob({ type = 'image/png', quality } = {}) {
    const buf = type === 'image/jpeg'
      ? await this._c.encode('jpeg', Math.round((quality ?? 0.92) * 100))
      : await this._c.encode('png');
    return new Blob([buf], { type });
  }
};

globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type || 'image/png'};base64,${Buffer.from(b).toString('base64')}`;
      this.onload?.();
    }, (e) => this.onerror?.(e));
  }
};

const state = await import('../public/js/state.js');
const cutpaths = await import('../public/js/cutpaths.js');
const exporters = await import('../public/js/exporters.js');
const { doc } = state;

const outDir = process.argv[2] || '.';
const fixtures = path.join(import.meta.dirname, 'fixtures');

async function place(file, props, cut) {
  const bytes = fs.readFileSync(path.join(fixtures, file));
  const bitmap = await loadImage(bytes);
  const img = state.addImage({
    id: state.uid('im'), name: file, bitmap, blob: new Blob([bytes], { type: 'image/png' }),
    type: 'image/png', width: bitmap.width, height: bitmap.height, hasAlpha: true,
  });
  const item = state.createItem(img.id, props);
  Object.assign(item.cut, cut);
  state.addItems([item]);
  return item;
}

doc.marks.style = 'crop';
doc.bleed = 3.175;

// A sticker sheet: contour-cut stars, a background-keyed blob, rounded boxes.
await place('star.png', { cx: 45, cy: 45, w: 55, h: 55 }, { mode: 'contour', key: 'alpha', offset: 3, minArea: 0.1, smooth: 0.5 });
await place('star.png', { cx: 115, cy: 45, w: 40, h: 40, rot: 25 }, { mode: 'contour', key: 'alpha', offset: 2, minArea: 0.1, smooth: 0.5 });
await place('blob-on-white.png', { cx: 170, cy: 48, w: 55, h: 44 }, { mode: 'contour', key: 'bg', offset: 3, minArea: 0.2 });
await place('star.png', { cx: 60, cy: 140, w: 70, h: 70 }, { mode: 'box', offset: 4, radius: 8 });
await place('blob-on-white.png', { cx: 155, cy: 140, w: 60, h: 48 }, { mode: 'box', offset: 2, radius: 0 });
await place('star.png', { cx: 105, cy: 230, w: 45, h: 45, flipH: true }, { mode: 'contour', key: 'alpha', offset: 6, minArea: 0.1, smooth: 1 });

await cutpaths.flushContours(doc.items);
for (const it of doc.items) {
  console.log(`${it.name.padEnd(20)} ${it.cut.mode.padEnd(8)} offset=${it.cut.offset}mm paths=${it.contour ? it.contour.paths.length : '-'}${it.contour?.degenerate ? ' (fallback)' : ''}`);
}

const withCut = exporters.renderSheet({ dpi: 110, includeBleed: true, includeMarks: true, includeCut: true });
fs.writeFileSync(path.join(outDir, 'preview-cutlines.png'), await withCut._c.encode('png'));

const printOnly = exporters.renderSheet({ dpi: 110, includeBleed: true, includeMarks: true, includeCut: false });
fs.writeFileSync(path.join(outDir, 'preview-print.png'), await printOnly._c.encode('png'));

const svg = await (await exporters.exportSvg({ includeArt: true })).text();
console.log('svg bytes', svg.length, 'paths', (svg.match(/<path /g) || []).length);
console.log('wrote previews to', outDir);
