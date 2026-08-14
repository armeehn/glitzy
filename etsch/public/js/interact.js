// Pointer interaction: selection, move, scale, rotate, marquee, pan and zoom.
import {
  doc, selection, setSelection, clearSelection, itemBounds,
  pageSize, marginRect, beginGesture, endGesture, notify,
} from './state.js';
import { view, unproject, invalidate, activeHandles, overlay, HANDLE_PX, zoomAt, markViewTouched } from './render.js';

const HIT_SLOP = 4;
const SNAP_TOL_PX = 7;

let drag = null;
let spaceDown = false;
let el = null;

export function attachInteractions(canvasEl) {
  el = canvasEl;
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping(e)) {
      spaceDown = true;
      el.style.cursor = 'grab';
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      el.style.cursor = '';
    }
  });
}

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function localPoint(e) {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Topmost item under a page-space point. */
export function hitTest(pt) {
  for (let i = doc.items.length - 1; i >= 0; i--) {
    const it = doc.items[i];
    if (!it.visible || it.locked) continue;
    const rad = (-it.rot * Math.PI) / 180;
    const dx = pt.x - it.cx;
    const dy = pt.y - it.cy;
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
    const slop = HIT_SLOP / view.scale;
    if (Math.abs(lx) <= it.w / 2 + slop && Math.abs(ly) <= it.h / 2 + slop) return it;
  }
  return null;
}

function hitHandle(screenPt) {
  const handles = activeHandles();
  if (!handles) return null;
  const r = HANDLE_PX / 2 + 4;
  for (const h of handles.list) {
    if (Math.abs(screenPt.x - h.x) <= r && Math.abs(screenPt.y - h.y) <= r) return { handle: h, frame: handles.frame };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

function snapTargets(excludeIds) {
  const { w, h } = pageSize();
  const m = marginRect();
  const b = doc.bleed;
  const xs = [];
  const ys = [];
  const push = (arr, at, from, to, kind) => arr.push({ at, from, to, kind });

  if (doc.grid.snapEdges) {
    push(xs, 0, -b, h + b, 'trim');
    push(xs, w, -b, h + b, 'trim');
    push(xs, w / 2, -b, h + b, 'center');
    push(ys, 0, -b, w + b, 'trim');
    push(ys, h, -b, w + b, 'trim');
    push(ys, h / 2, -b, w + b, 'center');
    if (m.w > 0) {
      push(xs, m.x, m.y, m.y + m.h, 'margin');
      push(xs, m.x + m.w, m.y, m.y + m.h, 'margin');
      push(ys, m.y, m.x, m.x + m.w, 'margin');
      push(ys, m.y + m.h, m.x, m.x + m.w, 'margin');
    }
  }

  if (doc.grid.snapGuides) {
    for (const it of doc.items) {
      if (excludeIds.has(it.id) || !it.visible) continue;
      const bb = itemBounds(it);
      push(xs, bb.x, bb.y, bb.y + bb.h, 'item');
      push(xs, bb.x + bb.w / 2, bb.y, bb.y + bb.h, 'item');
      push(xs, bb.x + bb.w, bb.y, bb.y + bb.h, 'item');
      push(ys, bb.y, bb.x, bb.x + bb.w, 'item');
      push(ys, bb.y + bb.h / 2, bb.x, bb.x + bb.w, 'item');
      push(ys, bb.y + bb.h, bb.x, bb.x + bb.w, 'item');
    }
  }
  return { xs, ys };
}

function bestSnap(values, targets, tol) {
  let best = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t.at - v;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) {
        best = { delta: d, target: t, value: v };
      }
    }
  }
  return best;
}

function unionBounds(items) {
  const bs = items.map(itemBounds);
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  const r = Math.max(...bs.map((b) => b.x + b.w));
  const b2 = Math.max(...bs.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: b2 - y };
}

// ---------------------------------------------------------------------------
// Pointer handlers
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  el.setPointerCapture(e.pointerId);
  const sp = localPoint(e);
  const pp = unproject(sp);
  const panning = spaceDown || e.button === 1 || (e.button === 0 && e.altKey && e.shiftKey);

  if (panning) {
    drag = { mode: 'pan', startScreen: sp, startTx: view.tx, startTy: view.ty };
    el.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;

  const handleHit = hitHandle(sp);
  if (handleHit) {
    const items = doc.items.filter((it) => selection.has(it.id) && !it.locked);
    beginGesture(handleHit.handle.id === 'rotate' ? 'rotate' : 'resize');
    drag = {
      mode: handleHit.handle.id === 'rotate' ? 'rotate' : 'resize',
      handle: handleHit.handle.id,
      frame: handleHit.frame,
      startPage: pp,
      items: items.map((it) => ({ ref: it, cx: it.cx, cy: it.cy, w: it.w, h: it.h, rot: it.rot })),
      startAngle: Math.atan2(pp.y - handleHit.frame.cy, pp.x - handleHit.frame.cx),
    };
    return;
  }

  const hit = hitTest(pp);
  if (hit) {
    if (e.shiftKey) setSelection([hit.id], { toggle: true });
    else if (!selection.has(hit.id)) setSelection([hit.id]);

    const items = doc.items.filter((it) => selection.has(it.id) && !it.locked);
    if (items.length) {
      beginGesture('move');
      drag = {
        mode: 'move',
        startPage: pp,
        moved: false,
        items: items.map((it) => ({ ref: it, cx: it.cx, cy: it.cy })),
      };
    }
    invalidate();
    return;
  }

  if (!e.shiftKey) clearSelection();
  drag = { mode: 'marquee', startPage: pp, additive: e.shiftKey };
  invalidate();
}

function onPointerMove(e) {
  const sp = localPoint(e);
  if (!drag) {
    const handleHit = hitHandle(sp);
    el.style.cursor = handleHit
      ? handleHit.handle.id === 'rotate' ? 'crosshair' : cursorFor(handleHit.handle.id, handleHit.frame.rot)
      : hitTest(unproject(sp)) ? 'move' : spaceDown ? 'grab' : 'default';
    return;
  }

  const pp = unproject(sp);
  switch (drag.mode) {
    case 'pan':
      view.tx = drag.startTx + (sp.x - drag.startScreen.x);
      view.ty = drag.startTy + (sp.y - drag.startScreen.y);
      markViewTouched();
      break;
    case 'move':
      doMove(pp, e);
      break;
    case 'resize':
      doResize(pp, e);
      break;
    case 'rotate':
      doRotate(pp, e);
      break;
    case 'marquee': {
      const x = Math.min(drag.startPage.x, pp.x);
      const y = Math.min(drag.startPage.y, pp.y);
      overlay.marquee = { x, y, w: Math.abs(pp.x - drag.startPage.x), h: Math.abs(pp.y - drag.startPage.y) };
      break;
    }
  }
  invalidate();
}

function onPointerUp(e) {
  if (!drag) return;
  if (drag.mode === 'marquee' && overlay.marquee) {
    const m = overlay.marquee;
    const ids = doc.items
      .filter((it) => it.visible && !it.locked)
      .filter((it) => {
        const b = itemBounds(it);
        return b.x < m.x + m.w && b.x + b.w > m.x && b.y < m.y + m.h && b.y + b.h > m.y;
      })
      .map((it) => it.id);
    if (ids.length) setSelection(ids, { additive: drag.additive });
  }
  overlay.marquee = null;
  overlay.snapLines = [];
  endGesture();
  drag = null;
  el.style.cursor = spaceDown ? 'grab' : '';
  notify('transform');
  invalidate();
}

function onWheel(e) {
  e.preventDefault();
  const sp = localPoint(e);
  if (e.ctrlKey || e.metaKey) {
    zoomAt(sp, Math.exp(-e.deltaY * 0.0035));
  } else if (e.shiftKey) {
    view.tx -= e.deltaY;
    markViewTouched();
  } else {
    view.tx -= e.deltaX;
    view.ty -= e.deltaY;
    markViewTouched();
  }
  invalidate();
}

function cursorFor(id, rot) {
  const base = { e: 0, ne: 45, n: 90, nw: 135, w: 180, sw: 225, s: 270, se: 315 };
  const angle = ((base[id] ?? 0) - (rot || 0) + 360) % 360;
  const idx = Math.round(angle / 45) % 8;
  return ['ew-resize', 'nesw-resize', 'ns-resize', 'nwse-resize', 'ew-resize', 'nesw-resize', 'ns-resize', 'nwse-resize'][idx];
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

function doMove(pp, e) {
  let dx = pp.x - drag.startPage.x;
  let dy = pp.y - drag.startPage.y;
  drag.moved = true;

  if (e.shiftKey) {
    if (Math.abs(dx) > Math.abs(dy)) dy = 0;
    else dx = 0;
  }

  // Apply the raw delta first so snapping sees the proposed position.
  for (const s of drag.items) {
    s.ref.cx = s.cx + dx;
    s.ref.cy = s.cy + dy;
  }

  overlay.snapLines = [];
  const snapping = !e.altKey && (doc.grid.snapEdges || doc.grid.snapGuides || doc.grid.snapGrid);
  if (snapping) {
    const items = drag.items.map((s) => s.ref);
    const ids = new Set(items.map((i) => i.id));
    const b = unionBounds(items);
    const tol = SNAP_TOL_PX / view.scale;
    let sx = 0;
    let sy = 0;

    if (doc.grid.snapGrid && doc.grid.size > 0) {
      const g = doc.grid.size;
      sx = Math.round(b.x / g) * g - b.x;
      sy = Math.round(b.y / g) * g - b.y;
      if (Math.abs(sx) > tol) sx = 0;
      if (Math.abs(sy) > tol) sy = 0;
    }

    const targets = snapTargets(ids);
    const hx = bestSnap([b.x, b.x + b.w / 2, b.x + b.w], targets.xs, tol);
    const hy = bestSnap([b.y, b.y + b.h / 2, b.y + b.h], targets.ys, tol);
    if (hx) {
      sx = hx.delta;
      overlay.snapLines.push({ orientation: 'v', at: hx.target.at, from: Math.min(hx.target.from, b.y), to: Math.max(hx.target.to, b.y + b.h) });
    }
    if (hy) {
      sy = hy.delta;
      overlay.snapLines.push({ orientation: 'h', at: hy.target.at, from: Math.min(hy.target.from, b.x), to: Math.max(hy.target.to, b.x + b.w) });
    }
    if (sx || sy) {
      for (const s of drag.items) {
        s.ref.cx += sx;
        s.ref.cy += sy;
      }
    }
  }
  notify('transform-live');
}

function doResize(pp, e) {
  const { frame, handle } = drag;
  const rad = (frame.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toLocal = (p) => {
    const dx = p.x - frame.cx;
    const dy = p.y - frame.cy;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  };
  const toPage = (p) => ({ x: frame.cx + p.x * cos - p.y * sin, y: frame.cy + p.x * sin + p.y * cos });

  const l = toLocal(pp);
  const hw = frame.w / 2;
  const hh = frame.h / 2;
  const dirX = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const dirY = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;

  const fromCenter = e.altKey;
  const corner = dirX !== 0 && dirY !== 0;
  // Corners keep the aspect ratio unless shift is held; edges stretch freely.
  const keepAspect = corner ? !e.shiftKey : e.shiftKey;

  let newW = frame.w;
  let newH = frame.h;
  const minSize = 1;

  if (dirX !== 0) newW = fromCenter ? Math.abs(l.x) * 2 : Math.max(minSize, (l.x * dirX) + hw);
  if (dirY !== 0) newH = fromCenter ? Math.abs(l.y) * 2 : Math.max(minSize, (l.y * dirY) + hh);
  newW = Math.max(minSize, newW);
  newH = Math.max(minSize, newH);

  if (keepAspect) {
    const ratio = frame.w / frame.h;
    if (dirX !== 0 && dirY !== 0) {
      if (newW / newH > ratio) newH = newW / ratio;
      else newW = newH * ratio;
    } else if (dirX !== 0) newH = newW / ratio;
    else newW = newH * ratio;
  }

  const sx = newW / frame.w;
  const sy = newH / frame.h;

  // Anchor: the opposite corner/edge stays put (or the centre with Alt).
  const anchorLocal = fromCenter ? { x: 0, y: 0 } : { x: -dirX * hw, y: -dirY * hh };
  const anchorPage = toPage(anchorLocal);

  for (const s of drag.items) {
    const it = s.ref;
    // Item centre expressed in the frame's local space at gesture start.
    const dx = s.cx - frame.cx;
    const dy = s.cy - frame.cy;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const nlx = anchorLocal.x + (lx - anchorLocal.x) * sx;
    const nly = anchorLocal.y + (ly - anchorLocal.y) * sy;
    const np = toPage({ x: nlx, y: nly });
    it.cx = np.x;
    it.cy = np.y;
    it.w = Math.max(minSize, s.w * sx);
    it.h = Math.max(minSize, s.h * sy);
  }

  // Keep the anchor pinned exactly (guards against float drift).
  if (drag.items.length === 1 && !fromCenter) {
    const it = drag.items[0].ref;
    const newFrame = { cx: it.cx, cy: it.cy, w: it.w, h: it.h, rot: frame.rot };
    const na = {
      x: newFrame.cx + (-dirX * newFrame.w / 2) * cos - (-dirY * newFrame.h / 2) * sin,
      y: newFrame.cy + (-dirX * newFrame.w / 2) * sin + (-dirY * newFrame.h / 2) * cos,
    };
    it.cx += anchorPage.x - na.x;
    it.cy += anchorPage.y - na.y;
  }

  notify('transform-live');
}

function doRotate(pp, e) {
  const { frame } = drag;
  const angle = Math.atan2(pp.y - frame.cy, pp.x - frame.cx);
  let deg = ((angle - drag.startAngle) * 180) / Math.PI;
  for (const s of drag.items) {
    let r = s.rot + deg;
    if (e.shiftKey) r = Math.round(r / 15) * 15;
    s.ref.rot = ((r % 360) + 360) % 360;
    if (drag.items.length > 1) {
      // Orbit the group centre as well as spinning in place.
      const rad = ((e.shiftKey ? Math.round(deg / 15) * 15 : deg) * Math.PI) / 180;
      const dx = s.cx - frame.cx;
      const dy = s.cy - frame.cy;
      s.ref.cx = frame.cx + dx * Math.cos(rad) - dy * Math.sin(rad);
      s.ref.cy = frame.cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    }
  }
  notify('transform-live');
}

export function isDragging() {
  return !!drag;
}
