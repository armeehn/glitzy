// Node test suite for the DOM-independent half of the app: unit parsing,
// page geometry, the contour-tracing pipeline, marks and the cut-file writers.
//
//   npm test
//
// Canvas rasterisation (traceContour, renderSheet, PNG/PDF) is covered by the
// browser check in tests/browser-render.html instead.

import test from 'node:test';
import assert from 'node:assert/strict';

/** Inch-derived millimetre values carry float noise; compare with tolerance. */
const near = (actual, expected, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'value'}: expected ~${expected}, got ${actual}`);

// cutpaths.js schedules work through requestIdleCallback at module scope.
globalThis.window = { requestIdleCallback: (fn) => setTimeout(() => fn({ timeRemaining: () => 5 }), 0) };

const { parseLength, fmt, toMm, fromMm, mmToPx, mmToPt, MM_PER_IN } = await import('../public/js/units.js');
const { PAGE_PRESETS, findPreset, findProfile } = await import('../public/js/presets.js');
const state = await import('../public/js/state.js');
const trace = await import('../public/js/trace.js');
const marks = await import('../public/js/marks.js');
const cutpaths = await import('../public/js/cutpaths.js');
const actions = await import('../public/js/actions.js');
const exporters = await import('../public/js/exporters.js');

const { doc } = state;

function resetDoc() {
  state.setDocData(state.defaultDoc());
  state.images.clear();
  state.resetHistory();
}

/** Register a fake image so items have something to reference. */
function fakeImage(w = 600, h = 400) {
  const rec = { id: state.uid('im'), name: 'test', width: w, height: h, hasAlpha: true, bitmap: null, blob: null };
  state.addImage(rec);
  return rec;
}

function addItem(props = {}) {
  const img = fakeImage();
  const item = state.createItem(img.id, { cx: 50, cy: 50, w: 40, h: 30, ...props });
  state.addItems([item]);
  return item;
}

// ---------------------------------------------------------------------------

test('units: parses plain numbers in the active unit', () => {
  near(parseLength('8.5', 'in'), 215.9);
  assert.equal(parseLength('10', 'mm'), 10);
  assert.equal(parseLength('1', 'cm'), 10);
  near(parseLength('72', 'pt'), MM_PER_IN);
});

test('units: parses explicit suffixes regardless of active unit', () => {
  assert.equal(parseLength('3mm', 'in'), 3);
  assert.ok(Math.abs(parseLength('0.125in', 'mm') - 3.175) < 1e-9);
  assert.ok(Math.abs(parseLength('2"', 'mm') - 50.8) < 1e-9);
  assert.equal(parseLength('1cm', 'in'), 10);
});

test('units: parses imperial fractions', () => {
  assert.ok(Math.abs(parseLength('1/8', 'in') - 3.175) < 1e-9);
  assert.ok(Math.abs(parseLength('8 1/2', 'in') - 215.9) < 1e-9);
  assert.ok(Math.abs(parseLength('-1/4', 'in') + 6.35) < 1e-9);
});

test('units: rejects junk instead of producing NaN', () => {
  for (const bad of ['', '   ', 'abc', 'in', null, undefined]) {
    assert.equal(parseLength(bad, 'in'), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('units: display formatting round-trips', () => {
  const mm = parseLength('8.5', 'in');
  assert.equal(fmt(mm, 'in'), '8.5');
  assert.equal(fmt(215.9, 'mm'), '215.9');
  assert.equal(fmt(0, 'in'), '0');
  assert.equal(toMm(fromMm(123.4, 'in'), 'in').toFixed(6), '123.400000');
});

test('units: pixel and point conversion', () => {
  assert.equal(Math.round(mmToPx(MM_PER_IN, 300)), 300);
  assert.equal(Math.round(mmToPt(MM_PER_IN)), 72);
});

// ---------------------------------------------------------------------------

test('presets: US Letter is the default and measures 8.5 x 11 in', () => {
  const letter = findPreset('letter');
  near(letter.w, 215.9);
  near(letter.h, 279.4);
  resetDoc();
  assert.equal(doc.page.preset, 'letter');
  assert.equal(doc.unit, 'in');
});

test('presets: A4 and the cutting mats are present and sane', () => {
  const a4 = findPreset('a4');
  assert.deepEqual([a4.w, a4.h], [210, 297]);
  const mat = findPreset('mat-12x12');
  near(mat.w, 304.8);
  assert.equal(PAGE_PRESETS.at(-1).id, 'custom');
});

test('presets: machine profiles seed bleed, margin and mark style', () => {
  resetDoc();
  state.applyProfile('cricut');
  const p = findProfile('cricut');
  assert.equal(doc.bleed, p.bleed);
  assert.equal(doc.margins.t, p.margin);
  assert.equal(doc.marks.style, 'cricut');
  assert.equal(doc.margins.linked, true);
});

// ---------------------------------------------------------------------------

test('geometry: trim, media and margin boxes', () => {
  resetDoc();
  doc.bleed = 3;
  doc.margins = { t: 5, r: 6, b: 7, l: 8, linked: false };

  const trim = state.trimRect();
  assert.deepEqual([trim.x, trim.y], [0, 0]);
  near(trim.w, 215.9, 1e-6, 'trim width');
  near(trim.h, 279.4, 1e-6, 'trim height');

  const media = state.mediaRect();
  assert.deepEqual([media.x, media.y], [-3, -3]);
  near(media.w, 221.9, 1e-6, 'media width');
  near(media.h, 285.4, 1e-6, 'media height');

  const m = state.marginRect();
  assert.deepEqual([m.x, m.y], [8, 5]);
  near(m.w, 215.9 - 8 - 6, 1e-6, 'live width');
  near(m.h, 279.4 - 5 - 7, 1e-6, 'live height');
});

test('geometry: landscape swaps the page dimensions', () => {
  resetDoc();
  doc.page.orientation = 'landscape';
  const p = state.pageSize();
  assert.ok(Math.abs(p.w - 279.4) < 1e-9);
  assert.ok(Math.abs(p.h - 215.9) < 1e-9);
});

test('geometry: margins larger than the page clamp to zero, not negative', () => {
  resetDoc();
  doc.margins = { t: 200, r: 200, b: 200, l: 200, linked: true };
  const m = state.marginRect();
  assert.equal(m.w, 0);
  assert.equal(m.h, 0);
});

test('geometry: rotated item bounds grow correctly', () => {
  resetDoc();
  const it = addItem({ cx: 100, cy: 100, w: 40, h: 20, rot: 0 });
  let b = state.itemBounds(it);
  assert.deepEqual([b.w, b.h], [40, 20]);

  it.rot = 90;
  b = state.itemBounds(it);
  assert.ok(Math.abs(b.w - 20) < 1e-9);
  assert.ok(Math.abs(b.h - 40) < 1e-9);
  assert.ok(Math.abs(b.x - 90) < 1e-9);

  it.rot = 45;
  b = state.itemBounds(it);
  const expected = (40 + 20) / Math.SQRT2;
  assert.ok(Math.abs(b.w - expected) < 1e-6);
});

test('geometry: cut bounds include the cut offset', () => {
  resetDoc();
  const it = addItem({ cx: 50, cy: 50, w: 40, h: 30 });
  it.cut.mode = 'box';
  it.cut.offset = 5;
  const cb = state.itemCutBounds(it);
  assert.deepEqual([cb.w, cb.h], [50, 40]);

  it.cut.mode = 'none';
  assert.equal(state.itemCutBounds(it).w, 40);
});

// ---------------------------------------------------------------------------

test('history: undo and redo restore item transforms', () => {
  resetDoc();
  const it = addItem({ cx: 10, cy: 10 });
  state.commit('move');
  it.cx = 99;
  assert.equal(state.historyState().canUndo, true);

  state.undo();
  assert.equal(state.getItem(it.id).cx, 10);
  assert.equal(state.historyState().canRedo, true);

  state.redo();
  assert.equal(state.getItem(it.id).cx, 99);
});

test('history: a gesture records a single undo step', () => {
  resetDoc();
  const it = addItem({ cx: 0 });
  state.beginGesture('move');
  for (let i = 1; i <= 20; i++) {
    state.beginGesture('move'); // as a pointermove would
    it.cx = i;
  }
  state.endGesture();
  state.undo();
  assert.equal(state.getItem(it.id).cx, 0);
  assert.equal(state.historyState().canUndo, false);
});

test('history: undo restores deleted items', () => {
  resetDoc();
  const it = addItem();
  state.commit('delete');
  state.removeItems([it.id]);
  assert.equal(doc.items.length, 0);
  state.undo();
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].id, it.id);
});

// ---------------------------------------------------------------------------

test('trace: distance transform matches Euclidean distance', () => {
  const w = 9;
  const h = 9;
  const seed = new Uint8Array(w * h);
  seed[4 * w + 4] = 1; // single seed at (4,4)
  const dist = trace.distanceTransform(seed, w, h);

  assert.equal(dist[4 * w + 4], 0);
  assert.ok(Math.abs(dist[4 * w + 7] - 3) < 1e-6);
  assert.ok(Math.abs(dist[0] - Math.hypot(4, 4)) < 1e-6);
  assert.ok(Math.abs(dist[2 * w + 3] - Math.hypot(1, 2)) < 1e-6);
});

test('trace: buildMask keys on transparency', () => {
  const w = 4;
  const h = 1;
  const data = new Uint8ClampedArray(w * h * 4);
  const alphas = [0, 10, 128, 255];
  alphas.forEach((a, i) => {
    data[i * 4 + 3] = a;
  });
  const mask = trace.buildMask({ data, width: w, height: h }, 'alpha', 0.12); // threshold ~30
  assert.deepEqual([...mask], [0, 0, 1, 1]);
});

test('trace: buildMask keys on a sampled background colour', () => {
  const w = 8;
  const h = 8;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // White background, dark square in the middle.
    const x = i % w;
    const y = (i / w) | 0;
    const inside = x >= 3 && x <= 5 && y >= 3 && y <= 5;
    data[i * 4] = inside ? 20 : 255;
    data[i * 4 + 1] = inside ? 20 : 255;
    data[i * 4 + 2] = inside ? 20 : 255;
    data[i * 4 + 3] = 255;
  }
  const mask = trace.buildMask({ data, width: w, height: h }, 'bg', 0.12);
  assert.equal(mask[4 * w + 4], 1, 'centre is foreground');
  assert.equal(mask[0], 0, 'corner is background');
  assert.equal(mask.reduce((a, b) => a + b, 0), 9);
});

test('trace: offsetMask grows and shrinks by the given radius', () => {
  const w = 21;
  const h = 21;
  const mask = new Uint8Array(w * h);
  mask[10 * w + 10] = 1;

  const grown = trace.offsetMask(mask, w, h, 3);
  assert.equal(grown[10 * w + 13], 1, 'exactly 3 px away is included');
  assert.equal(grown[10 * w + 14], 0, '4 px away is not');

  // A 5x5 block eroded by 1 leaves a 3x3 core.
  const block = new Uint8Array(w * h);
  for (let y = 8; y <= 12; y++) for (let x = 8; x <= 12; x++) block[y * w + x] = 1;
  const shrunk = trace.offsetMask(block, w, h, -1);
  assert.equal(shrunk.reduce((a, b) => a + b, 0), 9);
});

test('trace: labelBlobs separates parts and measures their area', () => {
  const w = 12;
  const h = 6;
  const mask = new Uint8Array(w * h);
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) mask[y * w + x] = 1; // 9 px
  mask[4 * w + 9] = 1; // lone speck

  const { blobs } = trace.labelBlobs(mask, w, h);
  assert.equal(blobs.length, 2);
  const areas = blobs.map((b) => b.area).sort((a, b) => b - a);
  assert.deepEqual(areas, [9, 1]);
});

test('trace: traceBlob walks a closed boundary', () => {
  const w = 10;
  const h = 10;
  const mask = new Uint8Array(w * h);
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) mask[y * w + x] = 1;
  const { labels, blobs } = trace.labelBlobs(mask, w, h);
  const pts = trace.traceBlob(labels, w, h, blobs[0]);

  // A 5x5 block has exactly 16 boundary pixels; the walk must close, not spin.
  assert.ok(pts.length >= 16 && pts.length <= 20, `expected ~16 boundary points, got ${pts.length}`);
  for (const p of pts) {
    assert.ok(p.x >= 2 && p.x <= 6 && p.y >= 2 && p.y <= 6, 'boundary stays inside the blob');
  }
  const onEdge = pts.every((p) => p.x === 2 || p.x === 6 || p.y === 2 || p.y === 6);
  assert.ok(onEdge, 'every boundary point sits on the blob edge');
});

test('trace: simplify keeps corners and drops collinear points', () => {
  const pts = [];
  for (let x = 0; x <= 10; x++) pts.push({ x, y: 0 });
  for (let y = 1; y <= 10; y++) pts.push({ x: 10, y });
  const out = trace.simplify(pts, 0.5);
  assert.ok(out.length <= 4, `expected a handful of points, got ${out.length}`);
  assert.deepEqual(out[0], { x: 0, y: 0 });
  assert.deepEqual(out.at(-1), { x: 10, y: 10 });
});

test('trace: simplifyClosed keeps a ring intact instead of collapsing it', () => {
  // A dense ring around a square: its first and last points are neighbours,
  // which is exactly the case that breaks a naive open-polyline RDP.
  const ring = [];
  const side = 40;
  for (let i = 0; i < side; i++) ring.push({ x: i, y: 0 });
  for (let i = 0; i < side; i++) ring.push({ x: side, y: i });
  for (let i = side; i > 0; i--) ring.push({ x: i, y: side });
  for (let i = side; i > 0; i--) ring.push({ x: 0, y: i });

  const out = trace.simplifyClosed(ring, 0.9);
  assert.ok(out.length >= 4, `ring must survive simplification, got ${out.length}`);
  assert.ok(out.length <= 12, `ring should compress to its corners, got ${out.length}`);

  const area = Math.abs(out.reduce((acc, p, i) => {
    const q = out[(i + 1) % out.length];
    return acc + (p.x * q.y - q.x * p.y);
  }, 0) / 2);
  assert.ok(Math.abs(area - side * side) < side * side * 0.05, `area preserved, got ${area}`);

  const first = out[0];
  const last = out.at(-1);
  assert.ok(first.x !== last.x || first.y !== last.y, 'closure stays implicit');
});

test('trace: simplify survives coincident anchor points', () => {
  const pts = [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 10, y: 0 }, { x: 0, y: 0 }];
  const out = trace.simplify(pts, 0.5);
  assert.ok(out.length >= 3, `expected the peak to be kept, got ${out.length}`);
});

test('trace: toBezier produces one closed segment per point', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const segs = trace.toBezier(square, 0.5);
  assert.equal(segs.length, 4);
  assert.deepEqual(segs.at(-1).p, { x: 0, y: 0 }, 'path closes back to the start');

  const sharp = trace.toBezier(square, 0);
  assert.deepEqual(sharp[0].c1, { x: 0, y: 0 }, 'zero smoothing keeps straight edges');
});

test('trace: rectPath honours offset and corner radius', () => {
  const plain = trace.rectPath(40, 20, 5, 0);
  const xs = [plain.start.x, ...plain.segs.map((s) => s.p.x)];
  const ys = [plain.start.y, ...plain.segs.map((s) => s.p.y)];
  assert.equal(Math.min(...xs), -25); // 40/2 + 5
  assert.equal(Math.max(...xs), 25);
  assert.equal(Math.min(...ys), -15); // 20/2 + 5
  assert.equal(Math.max(...ys), 15);

  const rounded = trace.rectPath(40, 20, 0, 4);
  const rxs = [rounded.start.x, ...rounded.segs.map((s) => s.p.x)];
  assert.equal(Math.max(...rxs), 20);
  assert.ok(rounded.segs.length > 4, 'rounded corners add segments');
});

// ---------------------------------------------------------------------------

test('cut paths: box mode follows the item transform', () => {
  resetDoc();
  const it = addItem({ cx: 100, cy: 60, w: 40, h: 20, rot: 0 });
  it.cut.mode = 'box';
  it.cut.offset = 2;
  it.cut.radius = 0;

  const [path] = cutpaths.itemCutPaths(it);
  const xs = [path.start.x, ...path.segs.map((s) => s.p.x)];
  const ys = [path.start.y, ...path.segs.map((s) => s.p.y)];
  assert.equal(Math.min(...xs), 78); // 100 - (20 + 2)
  assert.equal(Math.max(...xs), 122);
  assert.equal(Math.min(...ys), 48); // 60 - (10 + 2)
  assert.equal(Math.max(...ys), 72);

  it.rot = 90;
  const [rotated] = cutpaths.itemCutPaths(it);
  const rxs = [rotated.start.x, ...rotated.segs.map((s) => s.p.x)];
  assert.ok(Math.abs(Math.min(...rxs) - 88) < 1e-6, 'rotating swaps the extents');
  assert.ok(Math.abs(Math.max(...rxs) - 112) < 1e-6);
});

test('cut paths: mode "none" and hidden items emit nothing', () => {
  resetDoc();
  const it = addItem();
  it.cut.mode = 'none';
  assert.equal(cutpaths.itemCutPaths(it).length, 0);

  it.cut.mode = 'box';
  it.visible = false;
  assert.equal(cutpaths.itemCutPaths(it).length, 0);
});

test('cut paths: SVG path data is closed and finite', () => {
  resetDoc();
  const it = addItem({ cx: 30, cy: 30, w: 20, h: 10 });
  it.cut.mode = 'box';
  const [path] = cutpaths.itemCutPaths(it);
  const d = cutpaths.pathToSvg(path, (p) => p);
  assert.match(d, /^M [\d.-]+ [\d.-]+ C /);
  assert.match(d, / Z$/);
  assert.ok(!/NaN|Infinity/.test(d), 'no NaN leaked into the path data');
});

// ---------------------------------------------------------------------------

test('marks: each style emits the expected primitives', () => {
  resetDoc();
  doc.bleed = 5;

  doc.marks.style = 'none';
  assert.equal(marks.markPrimitives().length, 0);

  doc.marks.style = 'crop';
  const crop = marks.markPrimitives();
  assert.equal(crop.length, 8, 'two lines at each of the four trim corners');
  assert.ok(crop.every((p) => p.type === 'line'));

  doc.marks.style = 'squares';
  const squares = marks.markPrimitives();
  assert.equal(squares.length, 4);
  assert.ok(squares.every((p) => p.type === 'rect'));

  doc.marks.style = 'silhouette';
  const sil = marks.markPrimitives();
  assert.equal(sil.length, 5, 'one square plus two L brackets');

  doc.marks.style = 'cricut';
  const cricut = marks.markPrimitives();
  assert.equal(cricut.length, 1);
  assert.equal(cricut[0].type, 'frame');
});

test('marks: crop marks sit inside the bleed band', () => {
  resetDoc();
  doc.bleed = 6;
  doc.marks = { style: 'crop', size: 3, offset: 2, weight: 0.25 };
  const prims = marks.markPrimitives();
  for (const p of prims) {
    const xs = [p.x1, p.x2];
    const ys = [p.y1, p.y2];
    assert.ok(Math.min(...xs) >= -6.001 && Math.max(...xs) <= 215.9 + 6.001, 'stays within the media box');
    assert.ok(Math.min(...ys) >= -6.001 && Math.max(...ys) <= 279.4 + 6.001);
  }
});

test('marks: crop marks move inside the trim when the bleed is too thin', () => {
  resetDoc();
  // The default 1/8 in bleed cannot hold a 1/4 in mark, so they flip inward
  // at full length rather than being squeezed down to a stub.
  doc.bleed = 3.175;
  doc.marks = { style: 'crop', size: 6.35, offset: 2, weight: 0.25 };
  const prims = marks.markPrimitives();
  assert.equal(prims.length, 8);

  const lengths = prims.map((p) => Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
  assert.ok(Math.min(...lengths) >= 6, `marks stay legible, shortest ${Math.min(...lengths)}`);

  // Inward marks live inside the trim box.
  const xs = prims.flatMap((p) => [p.x1, p.x2]);
  const ys = prims.flatMap((p) => [p.y1, p.y2]);
  assert.ok(Math.min(...xs) >= 0 && Math.min(...ys) >= 0);
  assert.ok(Math.max(...xs) <= 215.9 + 1e-6 && Math.max(...ys) <= 279.4 + 1e-6);
});

test('marks: keep-out is empty for crop marks but real for sensor styles', () => {
  resetDoc();
  doc.marks.style = 'crop';
  assert.equal(marks.markKeepOut().length, 0);

  doc.marks.style = 'silhouette';
  assert.ok(marks.markKeepOut().length > 0);
});

test('marks: SVG output is well formed', () => {
  resetDoc();
  doc.marks.style = 'silhouette';
  const svg = marks.marksToSvg().join('');
  assert.ok(svg.includes('<rect'));
  assert.ok(!/NaN/.test(svg));
});

// ---------------------------------------------------------------------------

test('layout: live area shrinks away from registration marks', () => {
  resetDoc();
  doc.margins = { t: 5, r: 5, b: 5, l: 5, linked: true };
  doc.marks.style = 'none';
  const plain = actions.liveArea();
  assert.ok(Math.abs(plain.w - (215.9 - 10)) < 1e-9);

  doc.marks.style = 'silhouette';
  const guarded = actions.liveArea();
  assert.ok(guarded.h < plain.h, 'sensor marks eat into the usable height');
  assert.ok(guarded.w > 0 && guarded.h > 0);
});

test('layout: auto-arrange keeps everything inside the live area', () => {
  resetDoc();
  doc.marks.style = 'none';
  for (let i = 0; i < 8; i++) {
    const it = addItem({ w: 30 + i, h: 20 + i });
    it.cut.mode = 'box';
    it.cut.offset = 2;
  }
  const res = actions.autoArrange({ gutter: 3 });
  assert.equal(res.placed, 8);
  assert.equal(res.overflow, 0);

  const area = actions.liveArea();
  for (const it of doc.items) {
    const b = state.itemCutBounds(it);
    assert.ok(b.x >= area.x - 0.01, `${it.name} left edge`);
    assert.ok(b.y >= area.y - 0.01, `${it.name} top edge`);
    assert.ok(b.x + b.w <= area.x + area.w + 0.01, `${it.name} right edge`);
    assert.ok(b.y + b.h <= area.y + area.h + 0.01, `${it.name} bottom edge`);
  }
});

test('layout: auto-arrange reports overflow when the sheet is full', () => {
  resetDoc();
  for (let i = 0; i < 40; i++) addItem({ w: 60, h: 60 });
  const res = actions.autoArrange({ gutter: 3 });
  assert.ok(res.overflow > 0, 'expected some images not to fit');
});

test('layout: tiling fills the sheet with a whole number of copies', () => {
  resetDoc();
  doc.marks.style = 'none';
  const it = addItem({ w: 40, h: 40 });
  it.cut.mode = 'box';
  it.cut.offset = 2;
  state.setSelection([it.id]);

  const res = actions.tileSelection({ gutter: 3 });
  assert.equal(doc.items.length, res.added);
  assert.equal(res.added, res.cols * res.rows);

  const area = actions.liveArea();
  for (const item of doc.items) {
    const b = state.itemCutBounds(item);
    assert.ok(b.x >= area.x - 0.01 && b.x + b.w <= area.x + area.w + 0.01);
    assert.ok(b.y >= area.y - 0.01 && b.y + b.h <= area.y + area.h + 0.01);
  }
});

test('layout: align and distribute', () => {
  resetDoc();
  const a = addItem({ cx: 20, cy: 20, w: 10, h: 10 });
  const b = addItem({ cx: 80, cy: 50, w: 10, h: 10 });
  const c = addItem({ cx: 140, cy: 90, w: 10, h: 10 });
  state.setSelection([a.id, b.id, c.id]);

  actions.align('top');
  assert.equal(state.itemBounds(b).y, state.itemBounds(a).y);
  assert.equal(state.itemBounds(c).y, state.itemBounds(a).y);

  actions.distribute('h');
  const gapAB = state.itemBounds(b).x - (state.itemBounds(a).x + 10);
  const gapBC = state.itemBounds(c).x - (state.itemBounds(b).x + 10);
  assert.ok(Math.abs(gapAB - gapBC) < 1e-6, 'gaps are even');
});

test('layout: warnings flag off-sheet art, margin crossings and low DPI', () => {
  resetDoc();
  doc.marks.style = 'none';

  const off = addItem({ cx: -50, cy: -50, w: 40, h: 40 });
  off.name = 'runaway';
  let warnings = actions.layoutWarnings();
  assert.ok(warnings.some((w) => w.level === 'error' && /runaway/.test(w.text)));

  // Inside the bleed but overlapping the 0.25 in margin.
  resetDoc();
  const edge = addItem({ cx: 12, cy: 100, w: 20, h: 20 });
  edge.name = 'edgy';
  edge.cut.mode = 'box';
  warnings = actions.layoutWarnings();
  assert.ok(
    warnings.some((w) => w.level === 'warn' && /edgy/.test(w.text)),
    `expected a margin warning, got ${JSON.stringify(warnings)}`
  );

  resetDoc();
  const huge = addItem({ cx: 100, cy: 140, w: 200, h: 133 });
  huge.name = 'lowres';
  warnings = actions.layoutWarnings();
  assert.ok(warnings.some((w) => /DPI/.test(w.text)), 'expected a resolution warning');
});

test('layout: effective DPI reflects the printed size', () => {
  resetDoc();
  const img = fakeImage(600, 400);
  const it = state.createItem(img.id, { w: MM_PER_IN * 2, h: MM_PER_IN * 2 * (400 / 600) });
  state.addItems([it]);
  assert.equal(Math.round(actions.effectiveDpi(it)), 300);
});

// ---------------------------------------------------------------------------

test('export: SVG carries physical size, mm viewBox and a CutContour layer', async () => {
  resetDoc();
  doc.bleed = 3;
  doc.marks.style = 'crop';
  const it = addItem({ cx: 100, cy: 100, w: 40, h: 30 });
  it.cut.mode = 'box';

  const blob = await exporters.exportSvg({ includeArt: false, includeBleed: true, includeMarks: true });
  const svg = await blob.text();

  assert.match(svg, /width="221\.9mm"/);
  assert.match(svg, /height="285\.4mm"/);
  assert.match(svg, /viewBox="0 0 221\.9 285\.4"/);
  assert.match(svg, /inkscape:label="CutContour"/);
  assert.match(svg, /<path d="M /);
  assert.ok(!/NaN/.test(svg));
  assert.ok(svg.trim().endsWith('</svg>'));
});

test('export: cut-only SVG omits artwork and marks', async () => {
  resetDoc();
  doc.marks.style = 'silhouette';
  const it = addItem();
  it.cut.mode = 'box';
  const svg = await (await exporters.exportSvg({ cutOnly: true })).text();
  assert.ok(!svg.includes('RegMarks'));
  assert.ok(!svg.includes('<image'));
  assert.ok(svg.includes('CutContour'));
});

test('export: trim-only SVG drops the bleed from the page size', async () => {
  resetDoc();
  doc.bleed = 10;
  const it = addItem();
  it.cut.mode = 'box';
  const svg = await (await exporters.exportSvg({ includeBleed: false, includeArt: false })).text();
  assert.match(svg, /width="215\.9mm"/);
});

test('export: SVG escapes names so a quote cannot break the markup', async () => {
  resetDoc();
  doc.name = 'Sheet "one" & <two>';
  const it = addItem();
  it.name = 'evil"><script>';
  it.cut.mode = 'box';
  const svg = await (await exporters.exportSvg({ includeArt: false })).text();
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&quot;') || svg.includes('&amp;'));
});

test('export: DXF is millimetre-scaled with closed polylines', async () => {
  resetDoc();
  const it = addItem({ cx: 100, cy: 100, w: 40, h: 30 });
  it.cut.mode = 'box';
  const dxf = await (await exporters.exportDxf({ includeBleed: false })).text();

  assert.ok(dxf.includes('$INSUNITS'));
  assert.match(dxf, /\$INSUNITS\n70\n4/, 'units code 4 means millimetres');
  assert.ok(dxf.includes('LWPOLYLINE'));
  assert.ok(dxf.includes('CutContour'));
  assert.ok(dxf.trim().endsWith('EOF'));
  assert.ok(!/NaN/.test(dxf));

  // Y is flipped for CAD: an item at y=100 on a 279.4 mm page lands near 179.
  const lines = dxf.split('\n');
  const start = lines.indexOf('ENTITIES');
  const ys = [];
  for (let i = start; i < lines.length - 1; i++) {
    if (lines[i] === '20') ys.push(parseFloat(lines[i + 1]));
  }
  const maxY = Math.max(...ys);
  const minY = Math.min(...ys);
  assert.ok(maxY > 190 && maxY < 200, `expected max Y near 197.6, got ${maxY}`);
  assert.ok(minY > 155 && minY < 165, `expected min Y near 161.2, got ${minY}`);
});

test('export: summary maps millimetres to output pixels', () => {
  resetDoc();
  doc.bleed = 0;
  const s = exporters.exportSummary({ dpi: 300, includeBleed: true });
  assert.equal(s.px.w, 2550); // 8.5 in x 300
  assert.equal(s.px.h, 3300); // 11 in x 300
  near(s.inches.w, 8.5);
});

test('export: filenames are sanitised', () => {
  assert.equal(exporters.safeName('my sheet'), 'my sheet');
  assert.equal(exporters.safeName('a/b:c*d'), 'a_b_c_d');
  assert.equal(exporters.safeName(''), 'sheet');
  assert.equal(exporters.safeName('///'), 'sheet');
});
