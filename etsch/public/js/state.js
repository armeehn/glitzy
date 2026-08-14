// Document model, image registry, selection and undo history.
import { MM_PER_IN, clamp, round } from './units.js';
import { findPreset, findProfile } from './presets.js';

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(reason = 'change') {
  for (const fn of listeners) fn(reason);
}

let idSeq = 1;
export const uid = (prefix = 'i') => `${prefix}${(idSeq++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** id -> { id, name, bitmap, width, height, dataUrl, hasAlpha } */
export const images = new Map();

export function addImage(rec) {
  images.set(rec.id, rec);
  return rec;
}

export function getImage(id) {
  return images.get(id);
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function defaultDoc() {
  const preset = findPreset('letter');
  const profile = findProfile('generic');
  return {
    name: 'Untitled sheet',
    unit: 'in',
    page: { preset: preset.id, w: preset.w, h: preset.h, orientation: 'portrait' },
    bleed: profile.bleed,
    margins: { t: profile.margin, r: profile.margin, b: profile.margin, l: profile.margin, linked: true },
    machine: profile.id,
    marks: { style: profile.marks, size: 6.35, offset: 2, weight: 0.25 },
    grid: { show: false, size: MM_PER_IN / 4, snapGrid: false, snapGuides: true, snapEdges: true },
    layout: { gutter: 3 },
    view: { showBleed: true, showMargins: true, showCut: true, showImages: true },
    exportOpts: { dpi: 300, background: '#ffffff', includeArtInSvg: true, jpegQuality: 0.94 },
    items: [],
  };
}

export const doc = defaultDoc();

export let selection = new Set();

export function setSelection(ids, { additive = false, toggle = false } = {}) {
  if (!additive && !toggle) selection = new Set(ids);
  else {
    for (const id of ids) {
      if (toggle && selection.has(id)) selection.delete(id);
      else selection.add(id);
    }
  }
  notify('selection');
}

export function clearSelection() {
  if (selection.size === 0) return;
  selection.clear();
  notify('selection');
}

export function selectedItems() {
  return doc.items.filter((it) => selection.has(it.id));
}

export function getItem(id) {
  return doc.items.find((it) => it.id === id);
}

// ---------------------------------------------------------------------------
// Page geometry helpers. Origin (0,0) is the top-left trim corner; the bleed
// area extends into negative coordinates.
// ---------------------------------------------------------------------------

export function pageSize() {
  const { w, h, orientation } = doc.page;
  return orientation === 'landscape' ? { w: h, h: w } : { w, h };
}

export function mediaRect() {
  const { w, h } = pageSize();
  const b = doc.bleed;
  return { x: -b, y: -b, w: w + b * 2, h: h + b * 2 };
}

export function trimRect() {
  const { w, h } = pageSize();
  return { x: 0, y: 0, w, h };
}

export function marginRect() {
  const { w, h } = pageSize();
  const m = doc.margins;
  return { x: m.l, y: m.t, w: Math.max(0, w - m.l - m.r), h: Math.max(0, h - m.t - m.b) };
}

export function setPagePreset(id) {
  const preset = findPreset(id);
  doc.page.preset = id;
  if (id !== 'custom') {
    doc.page.w = preset.w;
    doc.page.h = preset.h;
  }
  notify('page');
}

export function applyProfile(id) {
  const p = findProfile(id);
  doc.machine = id;
  doc.bleed = p.bleed;
  doc.margins = { t: p.margin, r: p.margin, b: p.margin, l: p.margin, linked: true };
  doc.marks.style = p.marks;
  notify('page');
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function defaultCut() {
  return {
    mode: 'box', // none | box | contour
    offset: MM_PER_IN / 8, // outward offset from the artwork edge
    radius: 0, // corner radius, box mode only
    key: 'alpha', // alpha | white | luma — how contour mode finds the edge
    tolerance: 0.12, // 0..1, how aggressive the key is
    minArea: 0.4, // percent of image area below which a blob is ignored
    smooth: 0.5, // 0..1 corner smoothing on traced paths
  };
}

export function createItem(imageId, opts = {}) {
  const img = getImage(imageId);
  const item = {
    id: uid('it'),
    imageId,
    name: img ? img.name : 'Image',
    cx: 0,
    cy: 0,
    w: 25.4,
    h: 25.4,
    rot: 0,
    flipH: false,
    flipV: false,
    opacity: 1,
    locked: false,
    visible: true,
    cut: defaultCut(),
    contour: null, // cached traced path, in unit-square local space
    contourKey: null,
    ...opts,
  };
  return item;
}

export function addItems(items, { select = true } = {}) {
  doc.items.push(...items);
  if (select) selection = new Set(items.map((i) => i.id));
  notify('items');
}

export function removeItems(ids) {
  const set = new Set(ids);
  doc.items = doc.items.filter((it) => !set.has(it.id));
  for (const id of set) selection.delete(id);
  notify('items');
}

export function reorder(id, delta) {
  const i = doc.items.findIndex((it) => it.id === id);
  if (i < 0) return;
  const j = clamp(i + delta, 0, doc.items.length - 1);
  if (i === j) return;
  const [it] = doc.items.splice(i, 1);
  doc.items.splice(j, 0, it);
  notify('items');
}

export function moveToIndex(id, index) {
  const i = doc.items.findIndex((it) => it.id === id);
  if (i < 0) return;
  const [it] = doc.items.splice(i, 1);
  doc.items.splice(clamp(index, 0, doc.items.length), 0, it);
  notify('items');
}

/** Item corners in page space, honouring rotation. */
export function itemCorners(it) {
  const { cx, cy, w, h, rot } = it;
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  const hw = w / 2;
  const hh = h / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
}

export function itemBounds(it) {
  const pts = itemCorners(it);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

export function selectionBounds() {
  const items = selectedItems();
  if (!items.length) return null;
  const bs = items.map(itemBounds);
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  const r = Math.max(...bs.map((b) => b.x + b.w));
  const b2 = Math.max(...bs.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: b2 - y };
}

/** Outer extent including the item's cut offset — what actually gets cut. */
export function itemCutBounds(it) {
  const b = itemBounds(it);
  const o = it.cut.mode === 'none' ? 0 : it.cut.offset;
  return { x: b.x - o, y: b.y - o, w: b.w + o * 2, h: b.h + o * 2 };
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

const past = [];
const future = [];
let pending = null;
const HISTORY_LIMIT = 80;

function snapshot() {
  return JSON.stringify({
    doc: { ...doc, items: doc.items.map((it) => ({ ...it, contour: null, contourKey: null })) },
    selection: [...selection],
  });
}

/** Call before a mutation you want to be undoable. */
export function commit(label = 'edit') {
  past.push({ label, data: snapshot() });
  if (past.length > HISTORY_LIMIT) past.shift();
  future.length = 0;
  pending = null;
}

/**
 * For continuous gestures: records one history entry for the whole drag rather
 * than one per pointer-move.
 */
export function beginGesture(label) {
  if (pending === label) return;
  pending = label;
  commit(label);
  pending = label;
}

export function endGesture() {
  pending = null;
}

function restore(json) {
  const parsed = JSON.parse(json);
  const keep = new Map(doc.items.map((it) => [it.id, it]));
  Object.assign(doc, parsed.doc);
  doc.items = parsed.doc.items.map((it) => {
    const prev = keep.get(it.id);
    // Re-attach the cached contour when the cut settings are unchanged.
    if (prev && prev.contourKey && prev.contourKey === contourKeyFor(it)) {
      it.contour = prev.contour;
      it.contourKey = prev.contourKey;
    }
    return it;
  });
  selection = new Set(parsed.selection.filter((id) => doc.items.some((it) => it.id === id)));
  notify('history');
}

export function undo() {
  if (!past.length) return false;
  const entry = past.pop();
  future.push({ label: entry.label, data: snapshot() });
  restore(entry.data);
  return true;
}

export function redo() {
  if (!future.length) return false;
  const entry = future.pop();
  past.push({ label: entry.label, data: snapshot() });
  restore(entry.data);
  return true;
}

export function historyState() {
  return { canUndo: past.length > 0, canRedo: future.length > 0 };
}

export function contourKeyFor(it) {
  const c = it.cut;
  return [it.imageId, c.key, round(c.tolerance, 3), round(c.offset, 3), round(c.minArea, 3), round(c.smooth, 3), round(it.w, 2), round(it.h, 2)].join('|');
}

// ---------------------------------------------------------------------------
// Wholesale document replacement (project load / new document)
// ---------------------------------------------------------------------------

export function setDocData(next) {
  for (const key of Object.keys(doc)) delete doc[key];
  Object.assign(doc, next);
  selection = new Set();
}

export function resetHistory() {
  past.length = 0;
  future.length = 0;
  pending = null;
}
