// Resolves each item's cut geometry (box or traced contour) into page-space
// bezier paths, and owns the lazy tracing queue.
import { traceContour, rectPath } from './trace.js';
import { contourKeyFor, getImage, notify } from './state.js';

const queue = new Map(); // itemId -> item
let scheduled = false;
let running = false;

const idle = window.requestIdleCallback
  ? (fn) => window.requestIdleCallback(fn, { timeout: 250 })
  : (fn) => setTimeout(fn, 16);

function pump() {
  scheduled = false;
  if (running) return;
  const next = queue.entries().next();
  if (next.done) return;
  const [id, item] = next.value;
  queue.delete(id);
  running = true;

  try {
    const img = getImage(item.imageId);
    const key = contourKeyFor(item);
    if (img && img.bitmap) {
      item.contour = traceContour(img.bitmap, item);
      item.contourKey = key;
    }
  } catch (err) {
    console.error('contour trace failed', err);
    item.contour = null;
    item.contourKey = contourKeyFor(item); // don't retry in a loop
  } finally {
    running = false;
    item.tracing = false;
  }

  notify('contour');
  if (queue.size) schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  idle(pump);
}

/** Queue a retrace if the item's cut settings changed. Cheap to call often. */
export function ensureContour(item) {
  if (item.cut.mode !== 'contour') return;
  const key = contourKeyFor(item);
  if (item.contourKey === key) return;
  item.tracing = true;
  queue.set(item.id, item);
  schedule();
}

export function isTracing(item) {
  return !!item.tracing;
}

export function pendingTraces() {
  return queue.size + (running ? 1 : 0);
}

/** Force every contour up to date; awaits completion (used before export). */
export async function flushContours(items) {
  for (const it of items) ensureContour(it);
  while (queue.size || running) {
    // Drain synchronously rather than waiting on idle callbacks.
    scheduled = true;
    pump();
    await Promise.resolve();
  }
}

function transformPath(path, item, sx, sy) {
  const rad = (item.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const map = (p) => {
    const x = p.x * sx;
    const y = p.y * sy;
    return { x: item.cx + x * cos - y * sin, y: item.cy + x * sin + y * cos };
  };
  return {
    start: map(path.start),
    segs: path.segs.map((s) => ({ c1: map(s.c1), c2: map(s.c2), p: map(s.p) })),
  };
}

/** All cut paths for one item, in page millimetres. */
export function itemCutPaths(item) {
  if (item.cut.mode === 'none' || !item.visible) return [];

  if (item.cut.mode === 'box') {
    return [transformPath(rectPath(item.w, item.h, item.cut.offset, item.cut.radius), item, 1, 1)];
  }

  ensureContour(item);
  const c = item.contour;
  if (!c || !c.paths.length) {
    // Show the bounding box while the trace is still being computed.
    return [transformPath(rectPath(item.w, item.h, item.cut.offset, item.cut.radius), item, 1, 1)];
  }
  // If the item was resized since the trace, scale the cached path as a preview.
  const sx = c.boxW ? item.w / c.boxW : 1;
  const sy = c.boxH ? item.h / c.boxH : 1;
  return c.paths.map((p) => transformPath(p, item, sx, sy));
}

export function allCutPaths(items) {
  const out = [];
  for (const it of items) {
    for (const p of itemCutPaths(it)) out.push({ item: it, path: p });
  }
  return out;
}

/** Trace a path into a CanvasRenderingContext2D (already in page space). */
export function strokePath(ctx, path, project) {
  const s = project(path.start);
  ctx.moveTo(s.x, s.y);
  for (const seg of path.segs) {
    const c1 = project(seg.c1);
    const c2 = project(seg.c2);
    const p = project(seg.p);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
  }
  ctx.closePath();
}

/** Serialise a path to SVG path data with `places` decimals. */
export function pathToSvg(path, map, places = 3) {
  const f = (n) => {
    const v = Number(n.toFixed(places));
    return Object.is(v, -0) ? 0 : v;
  };
  const s = map(path.start);
  let d = `M ${f(s.x)} ${f(s.y)}`;
  for (const seg of path.segs) {
    const c1 = map(seg.c1);
    const c2 = map(seg.c2);
    const p = map(seg.p);
    d += ` C ${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(p.x)} ${f(p.y)}`;
  }
  return `${d} Z`;
}
