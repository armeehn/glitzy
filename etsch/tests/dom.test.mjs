// DOM wiring: boot public/index.html the way a browser would, then drive the
// panels and read the results back out of the markup.
//
// WHAT THIS FILE CANNOT DO. jsdom has no layout engine: offsetWidth,
// offsetTop and getBoundingClientRect all return zero, and <canvas> has no
// 2D context. So nothing here verifies where a registration mark, a bleed
// edge or a cut line is actually DRAWN — that is what tests/browser-render.html
// and tests/preview.mjs are for. The geometry itself is covered as pure maths
// in logic.test.mjs and against real pixels in canvas.test.mjs. This file
// covers the seam between them: that the markup, the panel wiring and the
// document model agree.
//
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('dom tests', { skip: 'jsdom is not installed' }, () => {});
}

if (JSDOM) {
  const html = readFileSync(join(import.meta.dirname, '../public/index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'https://cutsheet.test/',
    // The page's only script is type="module", which jsdom does not execute
    // even in this mode, so the modules are imported by hand below against the
    // parsed document. runScripts is still set so anything inline would run.
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.matchMedia = () => ({
        matches: false, media: '', onchange: null,
        addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
        dispatchEvent: () => false,
      });
      win.Element.prototype.scrollIntoView = function () {};
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    },
  });

  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Option = window.Option;              // ui.js builds <select>s with new Option()
  globalThis.ResizeObserver = window.ResizeObserver;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  // Autosave and restore run for real against an in-memory store, so the boot
  // path is exercised instead of falling into its error handler.
  const idb = new Map();
  globalThis.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          transaction() {
            const tx = {};
            tx.objectStore = () => ({
              put: (v, k) => { idb.set(k, v); queueMicrotask(() => tx.oncomplete?.()); },
              get: (k) => { const r = {}; queueMicrotask(() => { r.result = idb.get(k); r.onsuccess?.(); }); return r; },
              delete: (k) => { idb.delete(k); queueMicrotask(() => tx.oncomplete?.()); },
            });
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };

  // Booting the app is the first assertion: main.js wires the canvas, the
  // panels, the keyboard and the autosave at import time.
  await import('../public/js/main.js');
  await new Promise((r) => setTimeout(r, 0));

  const state = await import('../public/js/state.js');
  const { doc } = state;

  const $ = (id) => window.document.getElementById(id);
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  const optionValues = (id) => [...$(id).querySelectorAll('option')].map((o) => o.value);

  // -------------------------------------------------------------------------

  test('dom: the page boots and the selects are built from the modules', () => {
    assert.deepEqual(optionValues('machine-profile'), ['generic', 'cricut', 'silhouette', 'roland']);
    assert.deepEqual(optionValues('mark-style'), ['none', 'crop', 'squares', 'silhouette', 'cricut']);
    const presets = optionValues('page-preset');
    assert.ok(presets.includes('letter') && presets.includes('a4') && presets.includes('mat-12x24'));
    assert.equal(presets.at(-1), 'custom');
    // Presets are grouped, not a flat list.
    assert.ok($('page-preset').querySelectorAll('optgroup').length >= 3);
  });

  test('dom: the sheet readout reports the default US Letter sheet', () => {
    assert.match($('sheet-readout').textContent, /8\.5 × 11 in/);
    assert.equal($('units').value, 'in');
    assert.equal($('empty-state').hidden, false, 'no images yet, so the drop prompt shows');
  });

  test('dom: choosing a machine profile applies it and re-syncs the panels', () => {
    $('machine-profile').value = 'cricut';
    fire($('machine-profile'), 'change');

    assert.equal(doc.machine, 'cricut');
    assert.equal(doc.marks.style, 'cricut');
    assert.ok(Math.abs(doc.bleed - 25.4 * 0.0625) < 1e-9, `bleed ${doc.bleed}`);
    assert.ok(Math.abs(doc.margins.t - 25.4 * 0.5) < 1e-9);
    assert.equal($('mark-style').value, 'cricut', 'the marks panel followed the profile');
    assert.match($('machine-note').textContent, /Keep artwork inside the margin/);
    assert.equal($('btn-undo').disabled, false, 'the change is undoable');
  });

  test('dom: a length field accepts an imperial fraction and reformats it', () => {
    const bleed = $('bleed');
    bleed.value = '1/8';
    fire(bleed, 'change');
    assert.ok(Math.abs(doc.bleed - 3.175) < 1e-9, `bleed ${doc.bleed}`);
    assert.equal(bleed.value, '0.125', 'the field is rewritten in the active unit');

    bleed.value = 'banana';
    fire(bleed, 'change');
    assert.ok(Math.abs(doc.bleed - 3.175) < 1e-9, 'junk is rejected, not turned into NaN');
    assert.equal(bleed.value, '0.125');
  });

  test('dom: the export summary reports the real output pixel size', () => {
    const bleed = $('bleed');
    bleed.value = '0';
    fire(bleed, 'change');
    assert.equal(doc.bleed, 0);

    $('ex-dpi').value = '300';
    fire($('ex-dpi'), 'change');
    // 8.5 x 11 in at 300 DPI, no bleed.
    assert.match($('ex-summary').textContent, /2550 × 3300 px/);

    $('ex-dpi').value = '600';
    fire($('ex-dpi'), 'change');
    assert.match($('ex-summary').textContent, /5100 × 6600 px/);
    assert.equal(doc.exportOpts.dpi, 600);
  });

  test('dom: layout checks reach the panel from the document model', () => {
    assert.equal($('warnings-group').hidden, true, 'an empty sheet has nothing to warn about');

    // No image record, so the layers list skips thumbnailing (jsdom has no
    // canvas context) while the geometry still runs for real.
    const runaway = state.createItem('no-such-image', { cx: -50, cy: -50, w: 40, h: 40 });
    runaway.name = 'runaway';
    state.addItems([runaway]);

    assert.equal($('warnings-group').hidden, false);
    assert.match($('warnings').textContent, /runaway.*runs off the sheet/);
    assert.equal($('layer-count').textContent, '1');
    assert.equal($('layers').children.length, 1);
    assert.equal($('empty-state').hidden, true);

    // Selecting it opens the properties panel with the item's real geometry.
    assert.equal($('selection-props').hidden, false, 'addItems selects what it adds');
    assert.equal($('sel-title').textContent, 'runaway');
    assert.equal($('it-w').value, '1.575', '40 mm shown in inches');

    state.removeItems([runaway.id]);
    assert.equal($('warnings-group').hidden, true);
    assert.equal($('selection-props').hidden, true);
    assert.equal($('selection-empty').hidden, false);
  });

  test('dom: the status bar tracks the sheet', () => {
    assert.match($('stage-status').textContent, /8\.5 × 11 in/);
    assert.match($('stage-status').textContent, /0 images/);
  });
}
