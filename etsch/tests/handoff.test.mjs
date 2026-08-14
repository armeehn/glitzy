// The Glitchsheet handoff: `#handoff=<id>` opens a sheet built by another app.
//
// The interesting cases are all failures, because every one of them looked
// like a working import while it was broken:
//
//   * a fragment that names a URL instead of an id — the whole point of taking
//     an id is that this page can never be talked into fetching elsewhere;
//   * the plain Cloudflare deployment, which has no /handoff/ route at all and
//     answers 404 — that must degrade to a toast, not a blank sheet;
//   * an expired forward-auth session, which answers a login *page* with HTTP
//     200, so the JSON parse fails and "not a Cutsheet project" would send
//     someone hunting a file that is perfectly fine.
//
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- browser shims (same set project.test.mjs needs) -----------------------
globalThis.window = { requestIdleCallback: (fn) => setTimeout(() => fn({ timeRemaining: () => 5 }), 0) };
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
globalThis.createImageBitmap = async (blob) => ({ width: 64, height: 64, bytes: (await blob.arrayBuffer()).byteLength });
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

const handoff = await import('../public/js/handoff.js');
const state = await import('../public/js/state.js');
const { doc } = state;

const PNG = readFileSync(join(import.meta.dirname, 'fixtures/star.png'));
const ID = 'a1b2c3d4e5f60718';

/** A sheet in exactly the shape Glitchsheet's exporters.py writes. */
function sheetJson() {
  return JSON.stringify({
    format: 'cutsheet/1',
    savedAt: '2026-08-13T00:00:00.000Z',
    doc: {
      name: 'Glitchsheet 2026-08-13',
      unit: 'in',
      page: { preset: 'letter', w: 215.9, h: 279.4, orientation: 'portrait' },
      bleed: 3.175,
      margins: { t: 6.35, r: 6.35, b: 6.35, l: 6.35, linked: true },
      machine: 'generic',
      marks: { style: 'crop', size: 6.35, offset: 2, weight: 0.25 },
      exportOpts: { dpi: 300, background: '#ffffff', includeArtInSvg: true, jpegQuality: 0.94 },
      items: [{
        id: 'it1', imageId: 'im1', name: 'sticker 1',
        cx: 31.35, cy: 31.35, w: 50, h: 50, rot: 0,
        flipH: false, flipV: false, opacity: 1, locked: false, visible: true,
        cut: { mode: 'contour', offset: 0, radius: 0, key: 'alpha', tolerance: 0.12, minArea: 1.5, smooth: 0.5 },
        contour: null, contourKey: null,
      }],
    },
    images: [{
      id: 'im1', name: 'glitch-1.png', width: 64, height: 64, hasAlpha: true,
      type: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    }],
  });
}

const reply = (body, init = {}) => ({
  ok: init.status === undefined || (init.status >= 200 && init.status < 300),
  status: init.status ?? 200,
  text: async () => body,
});

function resetDoc() {
  state.setDocData(state.defaultDoc());
  state.images.clear();
  state.resetHistory();
}

// ---------------------------------------------------------------------------

test('handoff: reads a file id out of the fragment', () => {
  assert.equal(handoff.pendingHandoff(`#handoff=${ID}`), ID);
  assert.equal(handoff.pendingHandoff(`#zoom=2&handoff=${ID}`), ID);
  assert.equal(handoff.pendingHandoff('#zoom=2'), null);
  assert.equal(handoff.pendingHandoff(''), null);
});

test('handoff: anything that is not a file id is refused', () => {
  // The attack this shape exists to prevent: a fragment naming somewhere else
  // to fetch from. It must not even be considered pending.
  assert.equal(handoff.pendingHandoff('#handoff=https://evil.example/sheet.json'), null);
  assert.equal(handoff.pendingHandoff('#handoff=..%2F..%2Fetc%2Fpasswd'), null);
  assert.equal(handoff.pendingHandoff('#handoff=' + 'z'.repeat(16)), null, 'hex only');
  assert.equal(handoff.pendingHandoff('#handoff=A1B2C3D4E5F60718'), null, 'lower case only');
  assert.equal(handoff.pendingHandoff('#handoff=a1b2c3'), null, 'wrong length');
});

test('handoff: the id is dropped from the fragment, the rest is kept', () => {
  assert.equal(handoff.stripHandoff(`#handoff=${ID}`), '');
  assert.equal(handoff.stripHandoff(`#handoff=${ID}&zoom=2`), '#zoom=2');
  assert.equal(handoff.stripHandoff('#zoom=2'), '#zoom=2');
});

test('handoff: a handed-over sheet loads, from one same-origin request', async () => {
  resetDoc();
  const seen = [];
  const bytes = await handoff.importHandoff(ID, async (url, opts) => {
    seen.push([url, opts?.credentials]);
    return reply(sheetJson());
  });

  assert.deepEqual(seen, [[`/handoff/${ID}`, 'same-origin']], 'one fetch, fixed path, no host');
  assert.ok(bytes > 0);
  assert.equal(doc.items.length, 1);
  assert.equal(state.images.size, 1);
  assert.equal(doc.machine, 'generic');
  assert.equal(doc.items[0].cut.mode, 'contour');
  assert.equal(doc.items[0].cut.offset, 0, 'no second offset on a baked border');
  assert.ok(state.images.has(doc.items[0].imageId), 'the item still points at its image');
});

test('handoff: a malformed id never reaches the network', async () => {
  let called = false;
  await assert.rejects(
    () => handoff.importHandoff('../etc/passwd', async () => { called = true; return reply('{}'); }),
    /malformed/
  );
  assert.equal(called, false);
});

test('handoff: a deployment without the bridge says so and keeps the sheet', async () => {
  resetDoc();
  const before = doc.items.length;
  await assert.rejects(
    () => handoff.importHandoff(ID, async () => reply('not found', { status: 404 })),
    /no longer available|not the one/
  );
  assert.equal(doc.items.length, before, 'a failed handoff changes nothing');
});

test('handoff: a login page answered with 200 is reported as a session problem', async () => {
  await assert.rejects(
    () => handoff.importHandoff(ID, async () => reply('<!doctype html><title>Sign in</title>')),
    /session may have expired/
  );
});

test('handoff: a network failure is reported as one', async () => {
  await assert.rejects(
    () => handoff.importHandoff(ID, async () => { throw new TypeError('Failed to fetch'); }),
    /Could not reach/
  );
});

test('handoff: a sheet in the wrong format is still refused by the loader', async () => {
  await assert.rejects(
    () => handoff.importHandoff(ID, async () => reply(JSON.stringify({ format: 'cutsheet/2', doc: {} }))),
    /Unrecognised project format/
  );
});
