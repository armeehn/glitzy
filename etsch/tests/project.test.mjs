// Project persistence: the .cutsheet.json round trip.
//
// Regression cover for a bug that only showed up once the site was deployed.
// applyPayload() rebuilt each image by fetching its inlined data: URL, and
// `connect-src 'self'` in public/_headers refuses a data: URL, so "Open
// project" failed with a bare "Failed to fetch" in production and worked fine
// everywhere else. The fix is to decode the data URL directly.
//
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- browser shims ---------------------------------------------------------
globalThis.window = { requestIdleCallback: (fn) => setTimeout(() => fn({ timeRemaining: () => 5 }), 0) };

// serializeProject() inlines each image with a FileReader; Node has no such global.
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buf) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      },
      (err) => this.onerror?.(err)
    );
  }
};

// Nothing here rasterises; the registry only needs a truthy bitmap back.
globalThis.createImageBitmap = async (blob) => ({ width: 64, height: 64, bytes: (await blob.arrayBuffer()).byteLength });

// Enough IndexedDB that autosave() runs its real path instead of its catch.
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

const project = await import('../public/js/project.js');
const state = await import('../public/js/state.js');
const { doc } = state;

const PNG = readFileSync(join(import.meta.dirname, 'fixtures/star.png'));
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

function resetDoc() {
  state.setDocData(state.defaultDoc());
  state.images.clear();
  state.resetHistory();
}

// ---------------------------------------------------------------------------

test('project: dataUrlToBlob decodes base64 byte for byte', async () => {
  const blob = project.dataUrlToBlob(PNG_DATA_URL);
  assert.equal(blob.type, 'image/png');
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.length, PNG.length);
  assert.ok(bytes.equals(PNG), 'decoded bytes match the fixture exactly');
});

test('project: dataUrlToBlob decodes a percent-encoded data URL too', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
  const blob = project.dataUrlToBlob(`data:image/svg+xml,${encodeURIComponent(svg)}`);
  assert.equal(blob.type, 'image/svg+xml');
  assert.equal(await blob.text(), svg);
});

test('project: dataUrlToBlob refuses anything that is not a data URL', () => {
  assert.throws(() => project.dataUrlToBlob('https://example.com/a.png'), /not a data URL/);
  assert.throws(() => project.dataUrlToBlob(null), /not a data URL/);
});

test('project: a saved project reopens without making a request', async () => {
  resetDoc();
  const rec = state.addImage({
    id: state.uid('im'), name: 'star', width: 64, height: 64, hasAlpha: true,
    bitmap: {}, blob: new Blob([PNG], { type: 'image/png' }), type: 'image/png',
  });
  const item = state.createItem(rec.id, { name: 'star', cx: 40, cy: 55, w: 30, h: 20, rot: 12 });
  item.cut.mode = 'contour';
  item.cut.offset = 2.5;
  state.addItems([item]);
  doc.name = 'Round trip';
  doc.bleed = 4;

  const text = await (await project.serializeProject()).text();
  const saved = JSON.parse(text);
  assert.ok(saved.images[0].dataUrl.startsWith('data:image/png;base64,'), 'images are inlined as data URLs');

  // Under `connect-src 'self'` the browser rejects fetch('data:...') exactly
  // like this. Anything that reaches for the network here is the bug.
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { fetches++; return Promise.reject(new TypeError('Failed to fetch')); };
  try {
    resetDoc();
    await project.loadProjectFile(new Blob([text], { type: 'application/json' }));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetches, 0, 'opening a project must not make a request');

  assert.equal(state.images.size, 1);
  const img = [...state.images.values()][0];
  assert.equal(img.name, 'star');
  assert.ok(Buffer.from(await img.blob.arrayBuffer()).equals(PNG), 'image bytes survive the round trip');

  assert.equal(doc.items.length, 1);
  const it = doc.items[0];
  assert.deepEqual([it.cx, it.cy, it.w, it.h, it.rot], [40, 55, 30, 20, 12]);
  assert.equal(it.cut.mode, 'contour');
  assert.equal(it.cut.offset, 2.5);
  assert.equal(it.imageId, img.id, 'the item still points at its image');
  assert.equal(doc.name, 'Round trip');
  assert.equal(doc.bleed, 4);
});

test('project: the deployed CSP still refuses data: on connect-src', () => {
  const headers = readFileSync(join(import.meta.dirname, '../public/_headers'), 'utf8');
  const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)[1];
  const connect = /connect-src ([^;]+)/.exec(csp)[1].trim();
  assert.equal(connect, "'self'", 'the fix is to stop needing the network, not to widen the policy');
});

test('project: an unusable file is rejected with a readable message', async () => {
  await assert.rejects(() => project.loadProjectFile(new Blob(['not json'])), /not a Cutsheet project/);
  await assert.rejects(() => project.loadProjectFile(new Blob(['{"format":"nope"}'])), /Unrecognised project format/);
});
