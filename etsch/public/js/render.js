// Canvas renderer. Page millimetres -> screen pixels via a pan/zoom view.
import { doc, mediaRect, trimRect, marginRect, pageSize, selection, getImage, itemCorners } from './state.js';
import { itemCutPaths, strokePath, isTracing } from './cutpaths.js';
import { drawMarks } from './marks.js';

export const COLORS = {
  workspace: '#1b1d21',
  workspaceGrid: '#24272c',
  media: '#d9d5cf',
  page: '#ffffff',
  shadow: 'rgba(0,0,0,0.45)',
  trim: '#2b2f36',
  bleed: '#2f9bff',
  margin: '#26c281',
  cut: '#e6007e',
  cutStale: '#b8bcc4',
  select: '#5b9dff',
  handle: '#ffffff',
  handleStroke: '#3d7de0',
  snap: '#ff5cf0',
  grid: 'rgba(70,80,95,0.35)',
};

export const view = { scale: 2, tx: 0, ty: 0 };

// Until the user pans or zooms, the sheet re-fits itself whenever the window
// changes size. After that, their framing is left alone.
let viewTouched = false;
export const isViewTouched = () => viewTouched;
export const markViewTouched = () => {
  viewTouched = true;
};

export const HANDLE_PX = 8;
export const ROTATE_OFFSET_PX = 26;

let canvas = null;
let ctx = null;
let dpr = 1;

export const overlay = {
  snapLines: [], // {orientation:'v'|'h', at:number, from:number, to:number}
  marquee: null, // {x,y,w,h} in page mm
};

// Called after every frame so readouts (zoom level, status bar) can never
// drift from what is actually on screen.
let afterDraw = null;
export function onAfterDraw(fn) {
  afterDraw = fn;
}

export function attach(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resize();
}

export function resize() {
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
}

export function viewportSize() {
  if (!canvas) return { w: 0, h: 0 };
  return { w: canvas.width / dpr, h: canvas.height / dpr };
}

export function project(p) {
  return { x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty };
}

export function unproject(p) {
  return { x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale };
}

export function fitToView(padding = 48) {
  const vp = viewportSize();
  const media = mediaRect();
  if (!vp.w || !vp.h) return;
  const pad = Math.min(padding, Math.min(vp.w, vp.h) * 0.12);
  const s = Math.min((vp.w - pad * 2) / media.w, (vp.h - pad * 2) / media.h);
  view.scale = Math.max(0.05, s);
  view.tx = vp.w / 2 - (media.x + media.w / 2) * view.scale;
  view.ty = vp.h / 2 - (media.y + media.h / 2) * view.scale;
  viewTouched = false;
}

/** Re-frame after the viewport changes size. */
export function handleViewportResize() {
  const before = viewportSize();
  resize();
  const after = viewportSize();
  if (!viewTouched) {
    fitToView();
    return;
  }
  // Keep whatever the user was looking at in the middle of the new viewport.
  if (before.w && before.h) {
    view.tx += (after.w - before.w) / 2;
    view.ty += (after.h - before.h) / 2;
  }
}

export function zoomAt(screenPt, factor) {
  viewTouched = true;
  const before = unproject(screenPt);
  view.scale = Math.max(0.08, Math.min(60, view.scale * factor));
  const after = unproject(screenPt);
  view.tx += (after.x - before.x) * view.scale;
  view.ty += (after.y - before.y) * view.scale;
}

export function zoomTo(scale, center) {
  const vp = viewportSize();
  const pt = center || { x: vp.w / 2, y: vp.h / 2 };
  zoomAt(pt, scale / view.scale);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function rectPathScreen(r) {
  const a = project({ x: r.x, y: r.y });
  return { x: a.x, y: a.y, w: r.w * view.scale, h: r.h * view.scale };
}

function dashedRect(r, color, dash, width = 1) {
  const s = rectPathScreen(r);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
  ctx.restore();
}

export function draw() {
  if (!ctx) return;
  const vp = viewportSize();

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vp.w, vp.h);
  ctx.fillStyle = COLORS.workspace;
  ctx.fillRect(0, 0, vp.w, vp.h);

  const media = mediaRect();
  const trim = trimRect();
  const ms = rectPathScreen(media);
  const ts = rectPathScreen(trim);

  // Media (bleed) plate with a drop shadow.
  ctx.save();
  ctx.shadowColor = COLORS.shadow;
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = doc.bleed > 0 ? COLORS.media : COLORS.page;
  ctx.fillRect(ms.x, ms.y, ms.w, ms.h);
  ctx.restore();

  // Trim area.
  ctx.fillStyle = COLORS.page;
  ctx.fillRect(ts.x, ts.y, ts.w, ts.h);

  drawGrid(media);

  // Artwork, clipped to the media so nothing spills onto the workspace.
  ctx.save();
  ctx.beginPath();
  ctx.rect(ms.x, ms.y, ms.w, ms.h);
  ctx.clip();
  if (doc.view.showImages) {
    for (const item of doc.items) drawItem(item);
  }
  ctx.restore();

  if (doc.marks.style !== 'none') {
    drawMarks(ctx, project, view.scale, '#111');
  }

  drawGuides(media, trim);

  if (doc.view.showCut) {
    for (const item of doc.items) drawCut(item);
  }

  drawSelection();
  drawOverlay();

  ctx.restore();

  if (afterDraw) afterDraw();
}

function drawGrid(media) {
  if (!doc.grid.show || doc.grid.size <= 0) return;
  const step = doc.grid.size * view.scale;
  if (step < 5) return;
  const s = rectPathScreen(media);
  ctx.save();
  ctx.beginPath();
  ctx.rect(s.x, s.y, s.w, s.h);
  ctx.clip();
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const { w, h } = pageSize();
  for (let x = 0; x <= w + 0.001; x += doc.grid.size) {
    const p = project({ x, y: 0 }).x;
    ctx.moveTo(Math.round(p) + 0.5, s.y);
    ctx.lineTo(Math.round(p) + 0.5, s.y + s.h);
  }
  for (let y = 0; y <= h + 0.001; y += doc.grid.size) {
    const p = project({ x: 0, y }).y;
    ctx.moveTo(s.x, Math.round(p) + 0.5);
    ctx.lineTo(s.x + s.w, Math.round(p) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function drawItem(item) {
  if (!item.visible) return;
  const img = getImage(item.imageId);
  if (!img || !img.bitmap) return;
  const c = project({ x: item.cx, y: item.cy });
  const w = item.w * view.scale;
  const h = item.h * view.scale;

  ctx.save();
  ctx.globalAlpha = item.opacity;
  ctx.translate(c.x, c.y);
  ctx.rotate((item.rot * Math.PI) / 180);
  ctx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawCut(item) {
  if (!item.visible || item.cut.mode === 'none') return;
  const paths = itemCutPaths(item);
  if (!paths.length) return;
  const tracing = isTracing(item);
  ctx.save();
  ctx.strokeStyle = tracing ? COLORS.cutStale : COLORS.cut;
  ctx.lineWidth = Math.max(1, 0.3 * view.scale);
  ctx.setLineDash(tracing ? [4, 4] : []);
  ctx.beginPath();
  for (const p of paths) strokePath(ctx, p, project);
  ctx.stroke();
  ctx.restore();
}

function drawGuides(media, trim) {
  if (doc.view.showBleed && doc.bleed > 0) {
    dashedRect(media, COLORS.bleed, [6, 4]);
  }
  dashedRect(trim, COLORS.trim, []);
  if (doc.view.showMargins) {
    const m = marginRect();
    if (m.w > 0 && m.h > 0) dashedRect(m, COLORS.margin, [4, 4]);
  }
}

function drawSelection() {
  if (!selection.size) return;
  const items = doc.items.filter((it) => selection.has(it.id));

  ctx.save();
  ctx.strokeStyle = COLORS.select;
  ctx.lineWidth = 1.25;
  for (const item of items) {
    const pts = itemCorners(item).map(project);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();

  const handles = activeHandles();
  if (!handles) return;

  ctx.save();
  // Rotation stem.
  if (handles.rotate) {
    ctx.strokeStyle = COLORS.handleStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(handles.top.x, handles.top.y);
    ctx.lineTo(handles.rotate.x, handles.rotate.y);
    ctx.stroke();
  }
  ctx.fillStyle = COLORS.handle;
  ctx.strokeStyle = COLORS.handleStroke;
  ctx.lineWidth = 1.5;
  for (const h of handles.list) {
    ctx.beginPath();
    if (h.id === 'rotate') ctx.arc(h.x, h.y, HANDLE_PX / 2 + 1, 0, Math.PI * 2);
    else ctx.rect(h.x - HANDLE_PX / 2, h.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Screen-space transform handles. A single selection rotates with the item;
 * multi-selection uses an axis-aligned box.
 */
export function activeHandles() {
  const items = doc.items.filter((it) => selection.has(it.id) && !it.locked);
  if (!items.length) return null;

  let frame;
  if (items.length === 1) {
    const it = items[0];
    frame = { cx: it.cx, cy: it.cy, w: it.w, h: it.h, rot: it.rot };
  } else {
    const bs = items.map((it) => {
      const pts = itemCorners(it);
      return {
        x: Math.min(...pts.map((p) => p.x)),
        y: Math.min(...pts.map((p) => p.y)),
        r: Math.max(...pts.map((p) => p.x)),
        b: Math.max(...pts.map((p) => p.y)),
      };
    });
    const x = Math.min(...bs.map((b) => b.x));
    const y = Math.min(...bs.map((b) => b.y));
    const r = Math.max(...bs.map((b) => b.r));
    const b2 = Math.max(...bs.map((b) => b.b));
    frame = { cx: (x + r) / 2, cy: (y + b2) / 2, w: r - x, h: b2 - y, rot: 0 };
  }

  const rad = (frame.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toPage = (lx, ly) => ({ x: frame.cx + lx * cos - ly * sin, y: frame.cy + lx * sin + ly * cos });
  const hw = frame.w / 2;
  const hh = frame.h / 2;

  const defs = [
    ['nw', -hw, -hh], ['n', 0, -hh], ['ne', hw, -hh],
    ['e', hw, 0], ['se', hw, hh], ['s', 0, hh],
    ['sw', -hw, hh], ['w', -hw, 0],
  ];
  const list = defs.map(([id, lx, ly]) => ({ id, ...project(toPage(lx, ly)) }));
  const top = project(toPage(0, -hh));
  const rotate = { id: 'rotate', x: top.x + sin * ROTATE_OFFSET_PX, y: top.y - cos * ROTATE_OFFSET_PX };
  list.push(rotate);

  return { list, top, rotate, frame };
}

function drawOverlay() {
  if (overlay.marquee) {
    const s = rectPathScreen(overlay.marquee);
    ctx.save();
    ctx.fillStyle = 'rgba(91,157,255,0.15)';
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
    ctx.restore();
  }

  if (overlay.snapLines.length) {
    ctx.save();
    ctx.strokeStyle = COLORS.snap;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const g of overlay.snapLines) {
      if (g.orientation === 'v') {
        const x = project({ x: g.at, y: 0 }).x;
        const a = project({ x: 0, y: g.from }).y;
        const b = project({ x: 0, y: g.to }).y;
        ctx.moveTo(Math.round(x) + 0.5, a);
        ctx.lineTo(Math.round(x) + 0.5, b);
      } else {
        const y = project({ x: 0, y: g.at }).y;
        const a = project({ x: g.from, y: 0 }).x;
        const b = project({ x: g.to, y: 0 }).x;
        ctx.moveTo(a, Math.round(y) + 0.5);
        ctx.lineTo(b, Math.round(y) + 0.5);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Frame scheduling
// ---------------------------------------------------------------------------

let dirty = false;
export function invalidate() {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => {
    dirty = false;
    draw();
  });
}
