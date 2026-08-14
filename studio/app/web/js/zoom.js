/* Viewer zoom and pan.
 *
 * The stage is deliberately a fixed box with the artwork `object-fit: contain`
 * inside it (see studio.css) -- that is what stops the artwork jumping when a
 * 352px preview is replaced by a 480px full render. Zoom must not undo that,
 * so it is expressed as a multiplier on the *fit* size and applied as a CSS
 * transform:
 *
 *   zoom 1 == "fits the stage", whatever resolution the engine just returned
 *
 * Because a transform does not affect layout, the box never resizes and the
 * two renders still land in exactly the same place. Sizing the <img> in pixels
 * instead would reintroduce the jump the moment fast preview is on.
 *
 * The percentage readout is a different quantity on purpose: it reports
 * magnification against the *natural* pixels of what is on screen, which is
 * the number that tells you whether you are looking at real detail or at
 * interpolation. It therefore does move when a preview is swapped for a full
 * render -- the on-screen size is identical but the pixels behind it are not.
 */

import { $, on } from './dom.js';
import { S } from './state.js';

const MIN = 0.05;
const MAX = 24;
const STEP = 1.25;

let zoom = 1;       // multiplier on the fit size
let px = 0, py = 0; // pan, in screen px, applied after the scale
let dragging = false;
let lastX = 0, lastY = 0;

/* The on-screen rect the artwork occupies at zoom 1, i.e. what object-fit:
   contain resolves to, plus the visible stage it has to stay inside.

   The image box is read with offsetWidth/offsetHeight rather than
   getBoundingClientRect(), because the rect includes our own zoom transform
   and would feed the scale back into its own input. */
function fitSize() {
  const stage = $('#stage');
  const img = $('#view');
  const m = S.meta;
  if (!stage || !img || !m || !m.w || !m.h) return null;
  const bw = img.offsetWidth, bh = img.offsetHeight;
  const view = stage.getBoundingClientRect();
  if (!bw || !bh) return null;
  const s = Math.min(bw / m.w, bh / m.h);
  return { w: m.w * s, h: m.h * s, bw: view.width, bh: view.height };
}

/* Never let the artwork be dragged off the stage: pan is limited to the part
   of the content that actually overflows, so it is always at least touching. */
function clampPan(f) {
  if (!f) { px = py = 0; return; }
  const lx = Math.max(0, (f.w * zoom - f.bw) / 2);
  const ly = Math.max(0, (f.h * zoom - f.bh) / 2);
  px = Math.min(lx, Math.max(-lx, px));
  py = Math.min(ly, Math.max(-ly, py));
}

function apply() {
  const img = $('#view');
  const stage = $('#stage');
  if (!img || !stage) return;
  const f = fitSize();
  clampPan(f);
  img.style.transform = `translate(${px}px, ${py}px) scale(${zoom})`;

  const over = !!f && (f.w * zoom > f.bw + 0.5 || f.h * zoom > f.bh + 0.5);
  stage.dataset.pan = String(over);
  // The checkerboard lives on the stage, not the image: on the image it would
  // be scaled by the zoom transform along with the artwork.
  stage.dataset.art = String(!!S.meta);
  // Nearest-neighbour is right when magnifying (it is what makes block edges
  // readable) and wrong when minifying, where it aliases into noise.
  stage.dataset.smooth = String(natural() < 0.999);

  const lvl = $('#s-zoom');
  if (lvl) lvl.textContent = S.meta ? Math.round(natural() * 100) + '%' : '—';
  const fit = $('#zfit');
  if (fit) fit.dataset.on = String(Math.abs(zoom - 1) < 0.001);
  S.zoom = zoom;
}

/** Magnification against the natural pixels of the frame on screen. */
function natural() {
  const f = fitSize();
  if (!f || !S.meta) return zoom;
  return (f.w * zoom) / S.meta.w;
}

/** Set the zoom, optionally holding a point (relative to the stage centre) still. */
function setZoom(z, ax, ay) {
  const nz = Math.min(MAX, Math.max(MIN, z));
  if (ax !== undefined && zoom > 0) {
    px = ax - (ax - px) * (nz / zoom);
    py = ay - (ay - py) * (nz / zoom);
  }
  zoom = nz;
  apply();
}

export function zoomBy(k, ax, ay) { setZoom(zoom * k, ax, ay); }

export function zoomFit() { zoom = 1; px = py = 0; apply(); }

/** Natural pixel size: one image pixel per screen pixel, for this render. */
export function zoomNatural() {
  const f = fitSize();
  if (!f || !S.meta) return zoomFit();
  setZoom(S.meta.w / f.w);
}

/** Re-clamp and re-label after the artwork changes size. Keeps the zoom. */
export function syncZoom() { apply(); }

/** Back to fit -- for a cleared viewer or a new project. */
export function resetZoom() { zoomFit(); }

function anchor(e) {
  const r = $('#stage').getBoundingClientRect();
  return [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)];
}

export function initZoom() {
  const stage = $('#stage');

  on($('#zin'), 'click', () => zoomBy(STEP));
  on($('#zout'), 'click', () => zoomBy(1 / STEP));
  on($('#zfit'), 'click', zoomFit);
  on($('#z11'), 'click', zoomNatural);

  // The stage has nothing to scroll, so the wheel is free to mean zoom. Ctrl
  // and pinch arrive here as wheel events too, which is what a trackpad sends.
  on(stage, 'wheel', (e) => {
    if (!S.meta) return;
    e.preventDefault();
    const [ax, ay] = anchor(e);
    zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.03 : 0.0016)), ax, ay);
  }, { passive: false });

  on(stage, 'dblclick', () => {
    if (Math.abs(zoom - 1) < 0.001) zoomNatural(); else zoomFit();
  });

  // Dragging an <img> starts a native image drag, and the browser cancels the
  // pointer the moment it does -- a pan would move exactly one mousemove's
  // worth and then die on pointercancel. Both halves are needed: preventing
  // the default on pointerdown, and refusing dragstart outright.
  on(stage, 'dragstart', (e) => e.preventDefault());

  on(stage, 'pointerdown', (e) => {
    if (e.button !== 0 || !S.meta) return;
    e.preventDefault();
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    stage.setPointerCapture(e.pointerId);
    stage.dataset.drag = 'true';
  });
  on(stage, 'pointermove', (e) => {
    if (!dragging) return;
    px += e.clientX - lastX;
    py += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    apply();
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    stage.dataset.drag = 'false';
    try { stage.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  on(stage, 'pointerup', stop);
  on(stage, 'pointercancel', stop);

  on(document, 'keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey) return; // leave browser zoom alone
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(STEP); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / STEP); }
    else if (e.key === '0') { e.preventDefault(); zoomFit(); }
    else if (e.key === '1') { e.preventDefault(); zoomNatural(); }
  });

  // A resized window changes the fit size, so the pan limits move with it.
  on(window, 'resize', apply);
  apply();
}
