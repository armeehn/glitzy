// Canvas-backed tests: contour tracing on real artwork, sheet rasterisation
// and the PNG/PDF writers. Uses @napi-rs/canvas to stand in for the browser's
// OffscreenCanvas; the whole file skips if that optional dependency is absent.
//
//   npm i && npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'fixtures');

let canvasLib = null;
try {
  canvasLib = await import('@napi-rs/canvas');
} catch {
  test('canvas tests', { skip: '@napi-rs/canvas is not installed' }, () => {});
}

if (canvasLib) {
  const { createCanvas, loadImage } = canvasLib;

  // --- browser shims -------------------------------------------------------
  globalThis.window = { requestIdleCallback: (fn) => setTimeout(() => fn({ timeRemaining: () => 5 }), 0) };

  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this._c = createCanvas(w, h);
      this.width = w;
      this.height = h;
    }
    getContext(type, attrs) {
      return this._c.getContext(type, attrs);
    }
    async convertToBlob({ type = 'image/png', quality } = {}) {
      const buf = type === 'image/jpeg'
        ? await this._c.encode('jpeg', Math.round((quality ?? 0.92) * 100))
        : await this._c.encode('png');
      return new Blob([buf], { type });
    }
  };

  globalThis.createImageBitmap = async (source) => {
    const buf = source instanceof Blob ? Buffer.from(await source.arrayBuffer()) : source;
    return loadImage(buf);
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
  const trace = await import('../public/js/trace.js');
  const cutpaths = await import('../public/js/cutpaths.js');
  const exporters = await import('../public/js/exporters.js');
  const actions = await import('../public/js/actions.js');
  const { doc } = state;

  // --- helpers -------------------------------------------------------------

  function resetDoc() {
    state.setDocData(state.defaultDoc());
    state.images.clear();
    state.resetHistory();
  }

  async function fixture(name) {
    const path = join(FIXTURES, name);
    assert.ok(existsSync(path), `missing fixture ${name}`);
    const bitmap = await loadImage(readFileSync(path));
    return bitmap;
  }

  async function addFixtureItem(name, props = {}, cut = {}) {
    const bitmap = await fixture(name);
    const blob = new Blob([readFileSync(join(FIXTURES, name))], { type: 'image/png' });
    const img = state.addImage({
      id: state.uid('im'), name, bitmap, blob, type: 'image/png',
      width: bitmap.width, height: bitmap.height, hasAlpha: true,
    });
    const item = state.createItem(img.id, { cx: 100, cy: 100, w: 50, h: 50, ...props });
    Object.assign(item.cut, cut);
    state.addItems([item]);
    return { item, bitmap };
  }

  /** Bounding box of a traced result, in the item's local millimetres. */
  function pathsBounds(paths) {
    const xs = [];
    const ys = [];
    for (const p of paths) {
      xs.push(p.start.x);
      ys.push(p.start.y);
      for (const s of p.segs) {
        xs.push(s.p.x);
        ys.push(s.p.y);
      }
    }
    return { x: Math.min(...xs), y: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };
  }

  function fileFor(name, type = 'image/png') {
    return new File([readFileSync(join(FIXTURES, name))], name, { type });
  }

  // --- tests ---------------------------------------------------------------

  test('import: reading a file registers its size and alpha channel', async () => {
    resetDoc();
    const withAlpha = await actions.loadImageFile(fileFor('star.png'));
    assert.equal(withAlpha.width, 600);
    assert.equal(withAlpha.height, 600);
    assert.equal(withAlpha.hasAlpha, true);
    assert.ok(withAlpha.bitmap, 'decoded bitmap attached');

    const opaque = await actions.loadImageFile(fileFor('blob-on-white.png'));
    assert.equal(opaque.hasAlpha, false, 'a flattened PNG reports no alpha');
  });

  test('import: unsupported files are rejected with a readable message', async () => {
    resetDoc();
    await assert.rejects(
      () => actions.loadImageFile(new File(['nope'], 'notes.txt', { type: 'text/plain' })),
      /unsupported file type/i
    );
  });

  test('import: placement picks a cut mode that suits the artwork', async () => {
    resetDoc();
    doc.marks.style = 'none';
    const withAlpha = await actions.loadImageFile(fileFor('star.png'));
    const opaque = await actions.loadImageFile(fileFor('blob-on-white.png'));

    const items = actions.placeImages([withAlpha.id, opaque.id]);
    assert.equal(items.length, 2);
    assert.equal(items[0].cut.mode, 'contour', 'transparent art gets a contour cut');
    assert.equal(items[0].cut.key, 'alpha');
    assert.equal(items[1].cut.mode, 'box', 'opaque art gets a rectangle cut');
    assert.equal(items[1].cut.key, 'bg');

    // Placed at their natural 300 DPI size and kept inside the live area.
    assert.ok(Math.abs(items[0].w - (600 / 300) * 25.4) < 0.01, `width ${items[0].w}`);
    const area = actions.liveArea();
    for (const it of items) {
      const b = state.itemBounds(it);
      assert.ok(b.x >= area.x - 0.01 && b.x + b.w <= area.x + area.w + 0.01, `${it.name} horizontal fit`);
      assert.ok(b.y >= area.y - 0.01 && b.y + b.h <= area.y + area.h + 0.01, `${it.name} vertical fit`);
    }
    // The second image must not land on top of the first.
    const a = state.itemCutBounds(items[0]);
    const b2 = state.itemCutBounds(items[1]);
    const overlap = a.x < b2.x + b2.w && a.x + a.w > b2.x && a.y < b2.y + b2.h && a.y + a.h > b2.y;
    assert.ok(!overlap, 'new images are placed in free space');
  });

  test('import: oversized artwork is scaled down to fit the sheet', async () => {
    resetDoc();
    doc.page.w = 100;
    doc.page.h = 100;
    doc.page.preset = 'custom';
    const img = await actions.loadImageFile(fileFor('star.png'));
    const [item] = actions.placeImages([img.id]);
    const area = actions.liveArea();
    assert.ok(item.w <= area.w, `scaled to ${item.w} for a ${area.w} mm live area`);
    assert.ok(Math.abs(item.w / item.h - 1) < 0.01, 'aspect ratio preserved');
  });

  test('contour: traces a transparent PNG into separate blobs', async () => {
    resetDoc();
    const { item, bitmap } = await addFixtureItem('star.png', { w: 50, h: 50 }, {
      mode: 'contour', key: 'alpha', offset: 0, minArea: 0.1, smooth: 0.4,
    });

    const result = trace.traceContour(bitmap, item);
    assert.equal(result.degenerate, false, 'the artwork should key cleanly');
    assert.equal(result.paths.length, 2, 'the star and the detached dot, speck ignored');
    assert.equal(result.boxW, 50);

    const b = pathsBounds(result.paths);
    // The artwork fills the 50 mm box, so the outline hugs +/-25 mm.
    assert.ok(b.x > -25 && b.x < -17, `left edge ${b.x}`);
    assert.ok(b.r < 25 && b.r > 17, `right edge ${b.r}`);
    assert.ok(b.y > -25 && b.y < -17, `top edge ${b.y}`);

    for (const p of result.paths) {
      assert.ok(p.segs.length >= 3, 'each path is a real outline');
      assert.ok(Number.isFinite(p.start.x) && Number.isFinite(p.start.y));
    }
  });

  test('contour: the offset grows the outline by the requested distance', async () => {
    resetDoc();
    const { item, bitmap } = await addFixtureItem('star.png', { w: 50, h: 50 }, {
      mode: 'contour', key: 'alpha', offset: 0, minArea: 0.1, smooth: 0.4,
    });

    const tight = pathsBounds(trace.traceContour(bitmap, item).paths);

    item.cut.offset = 3;
    const loose = pathsBounds(trace.traceContour(bitmap, item).paths);

    assert.ok(Math.abs((tight.x - loose.x) - 3) < 0.8, `left grew by ${tight.x - loose.x}`);
    assert.ok(Math.abs((loose.r - tight.r) - 3) < 0.8, `right grew by ${loose.r - tight.r}`);
    assert.ok(Math.abs((loose.b - tight.b) - 3) < 0.8, `bottom grew by ${loose.b - tight.b}`);
  });

  test('contour: a negative offset pulls the outline inside the artwork', async () => {
    resetDoc();
    const { item, bitmap } = await addFixtureItem('star.png', { w: 50, h: 50 }, {
      mode: 'contour', key: 'alpha', offset: 0, minArea: 0.1,
    });
    const tight = pathsBounds(trace.traceContour(bitmap, item).paths);

    item.cut.offset = -2;
    const inset = pathsBounds(trace.traceContour(bitmap, item).paths);
    assert.ok(inset.x > tight.x + 1, 'inset outline starts further right');
    assert.ok(inset.r < tight.r - 1, 'inset outline ends further left');
  });

  test('contour: background keying works on opaque artwork', async () => {
    resetDoc();
    const { item, bitmap } = await addFixtureItem('blob-on-white.png', { w: 50, h: 40 }, {
      mode: 'contour', key: 'bg', offset: 0, tolerance: 0.12, minArea: 0.2,
    });

    const result = trace.traceContour(bitmap, item);
    assert.equal(result.degenerate, false);
    assert.equal(result.paths.length, 1);

    // The ellipse is inset from the artwork edge, so the cut line must be too.
    const b = pathsBounds(result.paths);
    assert.ok(b.x > -25 + 3, `left edge ${b.x} should sit inside the box`);
    assert.ok(b.r < 25 - 3, `right edge ${b.r} should sit inside the box`);
  });

  test('contour: fully opaque artwork with alpha keying falls back to a rectangle', async () => {
    resetDoc();
    const { item, bitmap } = await addFixtureItem('blob-on-white.png', { w: 50, h: 40 }, {
      mode: 'contour', key: 'alpha', offset: 2, tolerance: 0.12,
    });

    const result = trace.traceContour(bitmap, item);
    const b = pathsBounds(result.paths);
    // A rectangle offset by 2 mm around a 50 x 40 box.
    assert.ok(Math.abs(b.x + 27) < 0.6, `left ${b.x}`);
    assert.ok(Math.abs(b.r - 27) < 0.6, `right ${b.r}`);
    assert.ok(Math.abs(b.y + 22) < 0.6, `top ${b.y}`);
    assert.ok(Math.abs(b.b - 22) < 0.6, `bottom ${b.b}`);
  });

  test('contour: "auto" picks transparency when the image has an alpha channel', async () => {
    resetDoc();
    const { item, bitmap } = await addFixtureItem('star.png', { w: 40, h: 40 }, {
      mode: 'contour', key: 'auto', offset: 0, minArea: 0.1,
    });
    const result = trace.traceContour(bitmap, item);
    assert.equal(result.degenerate, false);
    assert.ok(result.paths.length >= 1);
  });

  test('contour: flipping the item mirrors the traced outline', async () => {
    resetDoc();
    const { item, bitmap } = await addFixtureItem('star.png', { w: 50, h: 50 }, {
      mode: 'contour', key: 'alpha', offset: 0, minArea: 0.1,
    });
    const normal = pathsBounds(trace.traceContour(bitmap, item).paths);

    item.flipH = true;
    const flipped = pathsBounds(trace.traceContour(bitmap, item).paths);
    assert.ok(Math.abs(normal.r + flipped.x) < 1, 'the right edge becomes the left edge');
  });

  test('contour: cached traces are reused and invalidated by cut changes', async () => {
    resetDoc();
    const { item } = await addFixtureItem('star.png', { w: 50, h: 50 }, {
      mode: 'contour', key: 'alpha', offset: 1, minArea: 0.1,
    });

    await cutpaths.flushContours([item]);
    const key = item.contourKey;
    assert.ok(key, 'a trace was cached');
    assert.ok(item.contour.paths.length >= 1);

    await cutpaths.flushContours([item]);
    assert.equal(item.contourKey, key, 'unchanged settings reuse the cache');

    item.cut.offset = 4;
    await cutpaths.flushContours([item]);
    assert.notEqual(item.contourKey, key, 'changing the offset forces a retrace');
  });

  test('contour: paths land in page space once the item transform is applied', async () => {
    resetDoc();
    const { item } = await addFixtureItem('star.png', { cx: 80, cy: 120, w: 50, h: 50 }, {
      mode: 'contour', key: 'alpha', offset: 0, minArea: 0.1,
    });
    await cutpaths.flushContours([item]);

    const paths = cutpaths.itemCutPaths(item);
    const b = pathsBounds(paths);
    assert.ok(b.x > 55 && b.x < 65, `left edge in page space: ${b.x}`);
    assert.ok(b.r > 95 && b.r < 105, `right edge in page space: ${b.r}`);
    assert.ok(b.y > 95 && b.y < 105, `top edge in page space: ${b.y}`);
  });

  // --- rasterisation and file writers --------------------------------------

  test('render: the sheet rasterises at the requested DPI', async () => {
    resetDoc();
    doc.bleed = 0;
    await addFixtureItem('star.png', { cx: 100, cy: 100, w: 50, h: 50 });

    const canvas = exporters.renderSheet({ dpi: 300, includeBleed: true, includeMarks: false });
    assert.equal(canvas.width, 2550); // 8.5 in
    assert.equal(canvas.height, 3300); // 11 in

    const low = exporters.renderSheet({ dpi: 150, includeBleed: true, includeMarks: false });
    assert.equal(low.width, 1275);
  });

  test('render: bleed enlarges the raster, and marks are drawn', async () => {
    resetDoc();
    doc.bleed = 3.175; // 1/8 in
    doc.marks.style = 'squares';
    await addFixtureItem('star.png');

    const withBleed = exporters.renderSheet({ dpi: 300, includeBleed: true, includeMarks: true });
    assert.equal(withBleed.width, 2550 + 75); // an eighth of an inch each side

    const trimOnly = exporters.renderSheet({ dpi: 300, includeBleed: false, includeMarks: true });
    assert.equal(trimOnly.width, 2550);

    // A corner square should have put black pixels near the mark inset.
    const ctx = trimOnly.getContext('2d');
    const { data } = ctx.getImageData(0, 0, 400, 400);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 40 && data[i + 1] < 40 && data[i + 2] < 40) dark++;
    }
    assert.ok(dark > 100, `expected a printed registration mark, found ${dark} dark pixels`);
  });

  test('export: PNG has the right magic bytes and pixel size', async () => {
    resetDoc();
    doc.bleed = 0;
    doc.marks.style = 'none';
    await addFixtureItem('star.png');

    const blob = await exporters.exportPng({ dpi: 150, includeBleed: true, includeMarks: false });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature');

    const width = new DataView(bytes.buffer).getUint32(16);
    assert.equal(width, 1275);
  });

  test('export: JPEG is produced for the print file', async () => {
    resetDoc();
    doc.marks.style = 'none';
    await addFixtureItem('star.png');
    const blob = await exporters.exportJpeg({ dpi: 150, includeBleed: false, quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xff, 0xd8, 0xff], 'JPEG signature');
    assert.ok(blob.size > 1000);
  });

  test('export: PDF embeds the artwork and vector cut paths', async () => {
    resetDoc();
    doc.bleed = 3.175;
    doc.marks.style = 'crop';
    const { item } = await addFixtureItem('star.png', { cx: 100, cy: 100, w: 50, h: 50 });
    item.cut.mode = 'box';
    item.cut.offset = 2;

    const blob = await exporters.exportPdf({ dpi: 150, includeBleed: true, includeCutPaths: true });
    const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');

    assert.ok(text.startsWith('%PDF-1.4'), 'PDF header');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'PDF trailer');
    assert.ok(text.includes('/DCTDecode'), 'artwork embedded as JPEG');
    assert.ok(text.includes('/MediaBox'), 'page box present');
    assert.ok(text.includes('/TrimBox'), 'trim box present for the printer');
    assert.match(text, /0\.902 0 0\.494 RG/, 'cut paths stroked in cut magenta');
    assert.match(text, /\d+ 0 obj/, 'indirect objects present');
    assert.match(text, /startxref\n\d+/, 'cross-reference offset written');

    // MediaBox must equal the media size in points: 8.75 x 11.25 in.
    const box = text.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    assert.ok(box, 'MediaBox parsed');
    assert.ok(Math.abs(parseFloat(box[1]) - 8.75 * 72) < 0.5, `width ${box[1]} pt`);
    assert.ok(Math.abs(parseFloat(box[2]) - 11.25 * 72) < 0.5, `height ${box[2]} pt`);
  });

  test('export: the PDF cross-reference table points at real objects', async () => {
    resetDoc();
    await addFixtureItem('star.png');
    const blob = await exporters.exportPdf({ dpi: 96 });
    const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');

    const startxref = parseInt(text.match(/startxref\n(\d+)/)[1], 10);
    assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref lands on the table');

    const rows = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => parseInt(m[1], 10));
    assert.equal(rows.length, 5, 'five objects');
    rows.forEach((offset, i) => {
      assert.equal(text.slice(offset, offset + 6), `${i + 1} 0 ob`, `object ${i + 1} offset`);
    });
  });

  test('export: SVG with artwork inlines the image as a data URL', async () => {
    resetDoc();
    const { item } = await addFixtureItem('star.png', { cx: 100, cy: 100, w: 50, h: 50, rot: 30 });
    item.cut.mode = 'box';

    const svg = await (await exporters.exportSvg({ includeArt: true, includeBleed: true })).text();
    assert.ok(svg.includes('xlink:href="data:image/png;base64,'), 'artwork inlined');
    assert.match(svg, /rotate\(30\)/, 'rotation preserved');
    assert.ok(svg.includes('inkscape:label="Artwork"'));
    assert.ok(svg.includes('inkscape:label="CutContour"'));
    assert.ok(!/NaN/.test(svg));
  });

  test('export: a full sticker sheet round-trips through every writer', async () => {
    resetDoc();
    doc.marks.style = 'silhouette';
    doc.bleed = 3.175;
    for (let i = 0; i < 4; i++) {
      const { item } = await addFixtureItem('star.png', { cx: 60 + i * 40, cy: 80 + i * 30, w: 30, h: 30 });
      item.cut.mode = i % 2 ? 'box' : 'contour';
      item.cut.minArea = 0.1;
    }

    const [png, pdf, svg, dxf] = await Promise.all([
      exporters.exportPng({ dpi: 150 }),
      exporters.exportPdf({ dpi: 150 }),
      exporters.exportSvg({ includeArt: true }),
      exporters.exportDxf({}),
    ]);

    assert.ok(png.size > 5000, 'PNG has content');
    assert.ok(pdf.size > 5000, 'PDF has content');

    const svgText = await svg.text();
    assert.equal((svgText.match(/<image /g) || []).length, 4, 'four images placed');
    assert.ok((svgText.match(/<path /g) || []).length >= 4, 'at least one cut path per image');

    const dxfText = await dxf.text();
    assert.ok((dxfText.match(/LWPOLYLINE/g) || []).length >= 4);
    assert.ok(!/NaN/.test(dxfText));
  });
}
