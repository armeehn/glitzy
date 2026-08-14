// Document-level operations shared by the toolbar, panels and keyboard.
import {
  doc, addImage, getImage, uid, createItem, addItems, removeItems,
  selection, setSelection, selectedItems, itemBounds, itemCutBounds,
  marginRect, pageSize, commit, notify,
} from './state.js';
import { MM_PER_IN } from './units.js';
import { markKeepOut } from './marks.js';

const DEFAULT_PLACEMENT_DPI = 300;

// ---------------------------------------------------------------------------
// Image import
// ---------------------------------------------------------------------------

const SUPPORTED = /^image\/(png|jpeg|webp|gif|bmp|avif|svg\+xml)$/;

export async function loadImageFile(file) {
  if (!SUPPORTED.test(file.type)) throw new Error(`${file.name}: unsupported file type (${file.type || 'unknown'})`);

  let blob = file;
  // Rasterise SVG at a generous size so it stays crisp when printed.
  if (file.type === 'image/svg+xml') blob = await rasterizeSvg(file);

  const bitmap = await createImageBitmap(blob);
  const rec = {
    id: uid('im'),
    name: file.name.replace(/\.[^.]+$/, ''),
    blob,
    type: blob.type,
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    hasAlpha: await detectAlpha(bitmap),
  };
  return addImage(rec);
}

async function rasterizeSvg(file) {
  const text = await file.text();
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error(`${file.name}: could not be read as SVG`));
      img.src = url;
    });
    const target = 2000;
    const w = img.naturalWidth || 512;
    const h = img.naturalHeight || 512;
    const s = Math.min(target / Math.max(w, h), 8);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * s));
    canvas.height = Math.max(1, Math.round(h * s));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob(res, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function detectAlpha(bitmap) {
  const s = Math.min(160, Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round((bitmap.width / Math.max(bitmap.width, bitmap.height)) * s));
  const h = Math.max(1, Math.round((bitmap.height / Math.max(bitmap.width, bitmap.height)) * s));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let p = 3; p < data.length; p += 4) if (data[p] < 250) return true;
  return false;
}

/** Natural print size in mm, clamped so it fits the live area. */
function naturalSize(img) {
  const area = marginRect();
  let w = (img.width / DEFAULT_PLACEMENT_DPI) * MM_PER_IN;
  let h = (img.height / DEFAULT_PLACEMENT_DPI) * MM_PER_IN;
  const maxW = (area.w > 0 ? area.w : pageSize().w) * 0.9;
  const maxH = (area.h > 0 ? area.h : pageSize().h) * 0.9;
  const s = Math.min(1, maxW / w, maxH / h);
  return { w: w * s, h: h * s };
}

/**
 * Place images on the sheet. `at` is a page-space point; without it the
 * new items are packed into the next free slots.
 */
export function placeImages(imageIds, { at = null } = {}) {
  commit('add images');
  const created = [];
  imageIds.forEach((id, i) => {
    const img = getImage(id);
    if (!img) return;
    const size = naturalSize(img);
    const item = createItem(id, { name: img.name, w: size.w, h: size.h });
    item.cut.key = img.hasAlpha ? 'alpha' : 'bg';
    item.cut.mode = img.hasAlpha ? 'contour' : 'box';

    // Images added in the same batch are not in the document yet, so they have
    // to be considered explicitly or they would all land on the same spot.
    const spot = at ? { x: at.x + i * 4, y: at.y + i * 4 } : nextFreeSpot(item, created);
    item.cx = spot.x;
    item.cy = spot.y;
    created.push(item);
  });
  if (created.length) addItems(created);
  return created;
}

/** First position inside the live area that does not overlap anything placed. */
function nextFreeSpot(item, pending = []) {
  const area = liveArea();
  const others = [...doc.items, ...pending];
  const offset = item.cut.mode === 'none' ? 0 : item.cut.offset;
  const w = item.w + offset * 2;
  const h = item.h + offset * 2;
  const step = 4;
  const pad = 1;

  for (let y = area.y + h / 2; y <= area.y + area.h - h / 2 + 0.01; y += step) {
    for (let x = area.x + w / 2; x <= area.x + area.w - w / 2 + 0.01; x += step) {
      const box = { x: x - w / 2 - pad, y: y - h / 2 - pad, w: w + pad * 2, h: h + pad * 2 };
      if (!others.some((it) => overlaps(box, itemCutBounds(it)))) return { x, y };
    }
  }
  const c = pageSize();
  return { x: c.w / 2, y: c.h / 2 };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Margin box minus any registration-mark keep-out. */
export function liveArea() {
  let area = marginRect();
  const { w, h } = pageSize();
  if (area.w <= 0 || area.h <= 0) area = { x: 0, y: 0, w, h };
  for (const box of markKeepOut()) {
    // Shrink the area on whichever side the keep-out intrudes least.
    if (!overlaps(area, box)) continue;
    const cuts = [
      { side: 'top', loss: box.y + box.h - area.y },
      { side: 'bottom', loss: area.y + area.h - box.y },
      { side: 'left', loss: box.x + box.w - area.x },
      { side: 'right', loss: area.x + area.w - box.x },
    ].filter((c) => c.loss > 0).sort((a, b) => a.loss - b.loss);
    const best = cuts[0];
    if (!best) continue;
    if (best.side === 'top') { area.h -= best.loss; area.y += best.loss; }
    else if (best.side === 'bottom') area.h -= best.loss;
    else if (best.side === 'left') { area.w -= best.loss; area.x += best.loss; }
    else area.w -= best.loss;
  }
  return area;
}

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------

export function nudge(dx, dy) {
  const items = selectedItems().filter((it) => !it.locked);
  if (!items.length) return;
  commit('nudge');
  for (const it of items) {
    it.cx += dx;
    it.cy += dy;
  }
  notify('transform');
}

export function deleteSelected() {
  if (!selection.size) return;
  commit('delete');
  removeItems([...selection]);
}

export function duplicateSelected(offset = 4) {
  const items = selectedItems();
  if (!items.length) return;
  commit('duplicate');
  const copies = items.map((it) => ({
    ...structuredClone({ ...it, contour: null, contourKey: null }),
    id: uid('it'),
    cx: it.cx + offset,
    cy: it.cy + offset,
  }));
  addItems(copies);
}

export function fitToBox(item, box, mode = 'contain') {
  const img = getImage(item.imageId);
  const ratio = img ? img.width / img.height : item.w / item.h;
  let w;
  let h;
  if (mode === 'cover') {
    const s = Math.max(box.w / ratio, box.h);
    h = s;
    w = s * ratio;
  } else if (mode === 'stretch') {
    w = box.w;
    h = box.h;
  } else {
    const s = Math.min(box.w / ratio, box.h);
    h = s;
    w = s * ratio;
  }
  item.w = w;
  item.h = h;
  item.cx = box.x + box.w / 2;
  item.cy = box.y + box.h / 2;
}

export function fitSelection(mode) {
  const items = selectedItems();
  if (!items.length) return;
  commit('fit');
  const area = liveArea();
  for (const it of items) {
    it.rot = 0;
    fitToBox(it, area, mode);
  }
  notify('transform');
}

export function actualSize(item, dpi = DEFAULT_PLACEMENT_DPI) {
  const img = getImage(item.imageId);
  if (!img) return;
  item.w = (img.width / dpi) * MM_PER_IN;
  item.h = (img.height / dpi) * MM_PER_IN;
}

export function effectiveDpi(item) {
  const img = getImage(item.imageId);
  if (!img || !item.w) return 0;
  return img.width / (item.w / MM_PER_IN);
}

// ---------------------------------------------------------------------------
// Align & distribute
// ---------------------------------------------------------------------------

function alignBox(relativeTo) {
  if (relativeTo === 'page') {
    const { w, h } = pageSize();
    return { x: 0, y: 0, w, h };
  }
  if (relativeTo === 'margins') return liveArea();
  const items = selectedItems();
  const bs = items.map(itemBounds);
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return {
    x, y,
    w: Math.max(...bs.map((b) => b.x + b.w)) - x,
    h: Math.max(...bs.map((b) => b.y + b.h)) - y,
  };
}

export function align(edge, relativeTo = 'selection') {
  const items = selectedItems().filter((it) => !it.locked);
  if (!items.length) return;
  commit('align');
  const box = alignBox(items.length === 1 ? (relativeTo === 'selection' ? 'margins' : relativeTo) : relativeTo);
  for (const it of items) {
    const b = itemBounds(it);
    switch (edge) {
      case 'left': it.cx += box.x - b.x; break;
      case 'hcenter': it.cx += box.x + box.w / 2 - (b.x + b.w / 2); break;
      case 'right': it.cx += box.x + box.w - (b.x + b.w); break;
      case 'top': it.cy += box.y - b.y; break;
      case 'vcenter': it.cy += box.y + box.h / 2 - (b.y + b.h / 2); break;
      case 'bottom': it.cy += box.y + box.h - (b.y + b.h); break;
    }
  }
  notify('transform');
}

export function distribute(axis) {
  const items = selectedItems().filter((it) => !it.locked);
  if (items.length < 3) return;
  commit('distribute');
  const key = axis === 'h' ? 'x' : 'y';
  const sizeKey = axis === 'h' ? 'w' : 'h';
  const sorted = items
    .map((it) => ({ it, b: itemBounds(it) }))
    .sort((a, b) => a.b[key] - b.b[key]);
  const first = sorted[0].b;
  const last = sorted[sorted.length - 1].b;
  const span = last[key] + last[sizeKey] - first[key];
  const totalSize = sorted.reduce((s, e) => s + e.b[sizeKey], 0);
  const gap = (span - totalSize) / (sorted.length - 1);
  let cursor = first[key];
  for (const entry of sorted) {
    const delta = cursor - entry.b[key];
    if (axis === 'h') entry.it.cx += delta;
    else entry.it.cy += delta;
    cursor += entry.b[sizeKey] + gap;
  }
  notify('transform');
}

// ---------------------------------------------------------------------------
// Auto-arrange (shelf packing, largest first)
// ---------------------------------------------------------------------------

export function autoArrange({ gutter = 3, scope = 'all' } = {}) {
  const items = (scope === 'selection' && selection.size ? selectedItems() : doc.items).filter((it) => !it.locked && it.visible);
  if (!items.length) return { placed: 0, overflow: 0 };
  commit('auto-arrange');

  const area = liveArea();
  const boxes = items.map((it) => {
    it.rot = 0;
    const o = it.cut.mode === 'none' ? 0 : it.cut.offset;
    return { it, w: it.w + o * 2, h: it.h + o * 2, o };
  });
  boxes.sort((a, b) => b.h - a.h || b.w - a.w);

  let x = area.x;
  let y = area.y;
  let shelfH = 0;
  let overflow = 0;

  for (const box of boxes) {
    if (x + box.w > area.x + area.w + 0.001 && x > area.x) {
      x = area.x;
      y += shelfH + gutter;
      shelfH = 0;
    }
    if (y + box.h > area.y + area.h + 0.001) overflow++;
    box.it.cx = x + box.w / 2;
    box.it.cy = y + box.h / 2;
    x += box.w + gutter;
    shelfH = Math.max(shelfH, box.h);
  }

  notify('transform');
  return { placed: boxes.length, overflow };
}

/** Repeat the selection to fill the live area — the sticker-sheet workhorse. */
export function tileSelection({ gutter = 3, count = null } = {}) {
  const items = selectedItems();
  if (items.length !== 1) return { added: 0 };
  const src = items[0];
  const area = liveArea();
  const o = src.cut.mode === 'none' ? 0 : src.cut.offset;
  const cellW = src.w + o * 2 + gutter;
  const cellH = src.h + o * 2 + gutter;
  const cols = Math.max(1, Math.floor((area.w + gutter) / cellW));
  const rows = Math.max(1, Math.floor((area.h + gutter) / cellH));
  const total = count ? Math.min(count, cols * rows) : cols * rows;

  commit('tile');
  const created = [];
  for (let i = 0; i < total; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const cx = area.x + o + src.w / 2 + c * cellW;
    const cy = area.y + o + src.h / 2 + r * cellH;
    if (i === 0) {
      src.cx = cx;
      src.cy = cy;
      continue;
    }
    created.push({
      ...structuredClone({ ...src, contour: null, contourKey: null }),
      id: uid('it'),
      cx,
      cy,
    });
  }
  if (created.length) addItems(created, { select: false });
  setSelection([src.id, ...created.map((c) => c.id)]);
  notify('transform');
  return { added: created.length + 1, cols, rows };
}

// ---------------------------------------------------------------------------
// Layout validation
// ---------------------------------------------------------------------------

export function layoutWarnings() {
  const warnings = [];
  const { w, h } = pageSize();
  const area = liveArea();
  const bleed = doc.bleed;

  for (const it of doc.items) {
    if (!it.visible) continue;
    const cb = itemCutBounds(it);
    if (cb.x < -bleed - 0.01 || cb.y < -bleed - 0.01 || cb.x + cb.w > w + bleed + 0.01 || cb.y + cb.h > h + bleed + 0.01) {
      warnings.push({ id: it.id, level: 'error', text: `“${it.name}” cut line runs off the sheet` });
    } else if (cb.x < area.x - 0.01 || cb.y < area.y - 0.01 || cb.x + cb.w > area.x + area.w + 0.01 || cb.y + cb.h > area.y + area.h + 0.01) {
      warnings.push({ id: it.id, level: 'warn', text: `“${it.name}” cut line crosses the margin` });
    }
    const dpi = effectiveDpi(it);
    if (dpi && dpi < 150) {
      warnings.push({ id: it.id, level: 'warn', text: `“${it.name}” is only ${Math.round(dpi)} DPI at this size` });
    }
  }

  // Overlapping cut lines make a mess on the cutter.
  const visible = doc.items.filter((it) => it.visible && it.cut.mode !== 'none');
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = itemCutBounds(visible[i]);
      const b = itemCutBounds(visible[j]);
      if (overlaps(a, b)) {
        // One warning per item is enough; move on to the next one.
        warnings.push({ id: visible[i].id, level: 'warn', text: `“${visible[i].name}” and “${visible[j].name}” have overlapping cut areas` });
        break;
      }
    }
  }
  return warnings;
}

