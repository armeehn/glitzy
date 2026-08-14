// Project persistence: IndexedDB autosave plus explicit .cutsheet file I/O.
import { doc, images, addImage, createItem, defaultDoc, notify, resetHistory, setDocData } from './state.js';

const DB_NAME = 'cutsheet';
const STORE = 'state';
const KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function docPayload() {
  return {
    ...doc,
    items: doc.items.map((it) => ({ ...it, contour: null, contourKey: null, tracing: false })),
  };
}

/** Autosave keeps image blobs as-is; IndexedDB stores them natively. */
export async function autosave() {
  try {
    await idbPut({
      format: 'cutsheet/1',
      savedAt: Date.now(),
      doc: docPayload(),
      images: [...images.values()].map((im) => ({
        id: im.id, name: im.name, width: im.width, height: im.height,
        hasAlpha: im.hasAlpha, blob: im.blob, type: im.type,
      })),
    });
    return true;
  } catch (err) {
    console.warn('autosave failed', err);
    return false;
  }
}

let timer = null;
export function scheduleAutosave(delay = 900) {
  clearTimeout(timer);
  timer = setTimeout(autosave, delay);
}

async function hydrateImage(rec) {
  const bitmap = await createImageBitmap(rec.blob);
  return { ...rec, bitmap, dataUrl: null };
}

/**
 * Decode a `data:` URL into a Blob without going through `fetch`.
 *
 * `fetch()` counts as a connection, so `connect-src 'self'` in `public/_headers`
 * refuses a `data:` URL — which would break "Open project" on the deployed site
 * while it kept working on an unheadered dev server. Nothing about a data URL
 * needs the network, so decode it here and keep the CSP strict.
 */
export function dataUrlToBlob(url) {
  const m = /^data:([^,;]*)((?:;[^,;]*)*),([\s\S]*)$/.exec(String(url ?? ''));
  if (!m) throw new Error('That project references an image that is not a data URL.');
  const type = m[1] || 'text/plain';
  const body = m[3];
  if (!/;base64/i.test(m[2])) return new Blob([decodeURIComponent(body)], { type });
  const binary = atob(body.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function applyPayload(payload) {
  images.clear();
  for (const im of payload.images || []) {
    let blob = im.blob;
    if (!blob && im.dataUrl) blob = dataUrlToBlob(im.dataUrl);
    if (!blob) continue;
    addImage(await hydrateImage({ ...im, blob, type: blob.type }));
  }
  const base = defaultDoc();
  const merged = {
    ...base,
    ...payload.doc,
    page: { ...base.page, ...(payload.doc.page || {}) },
    margins: { ...base.margins, ...(payload.doc.margins || {}) },
    marks: { ...base.marks, ...(payload.doc.marks || {}) },
    grid: { ...base.grid, ...(payload.doc.grid || {}) },
    view: { ...base.view, ...(payload.doc.view || {}) },
    exportOpts: { ...base.exportOpts, ...(payload.doc.exportOpts || {}) },
  };
  merged.items = (payload.doc.items || [])
    .filter((it) => images.has(it.imageId))
    .map((it) => ({ ...createItem(it.imageId), ...it, contour: null, contourKey: null, tracing: false }));
  setDocData(merged);
  resetHistory();
  notify('load');
}

export async function restoreAutosave() {
  const payload = await idbGet();
  if (!payload || payload.format !== 'cutsheet/1' || !payload.doc) return false;
  if (!(payload.doc.items || []).length && !(payload.images || []).length) return false;
  await applyPayload(payload);
  return true;
}

export async function clearAutosave() {
  await idbClear();
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

/** Portable project file: images inlined as data URLs. */
export async function serializeProject() {
  const imgs = [];
  for (const im of images.values()) {
    imgs.push({
      id: im.id, name: im.name, width: im.width, height: im.height,
      hasAlpha: im.hasAlpha, type: im.type, dataUrl: await blobToDataUrl(im.blob),
    });
  }
  return new Blob(
    [JSON.stringify({ format: 'cutsheet/1', savedAt: new Date().toISOString(), doc: docPayload(), images: imgs }, null, 1)],
    { type: 'application/json' }
  );
}

export async function loadProjectFile(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('That file is not a Cutsheet project.');
  }
  if (payload.format !== 'cutsheet/1') throw new Error('Unrecognised project format.');
  await applyPayload(payload);
  await autosave();
}

export function newProject() {
  images.clear();
  setDocData(defaultDoc());
  resetHistory();
  notify('load');
  scheduleAutosave(0);
}
