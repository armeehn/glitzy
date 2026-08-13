/* The viewer: one frame of the selected node, plus transport.
 *
 * There is no canvas compositing here any more. In v1 the browser built the
 * sticker itself -- matte, colourway, border -- so every scrub cost a full
 * re-render in JS. Now the engine has already produced the finished frames and
 * each one is content-addressed and immutable, so scrubbing is just swapping
 * an <img> src and the browser cache does the rest.
 */

import { $, el, fmt, on } from './dom.js';
import { frameUrl } from './api.js';
import { S, fire } from './state.js';
import { resetZoom, syncZoom } from './zoom.js';

let timer = 0;

export function initViewer() {
  on($('#frame'), 'input', (e) => {
    S.frame = +e.target.value;
    showFrame();
  });
  on($('#play'), 'click', togglePlay);
  on(document, 'keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key.toLowerCase() === 'k') fire('keep');
  });
}

export function togglePlay() {
  S.playing = !S.playing;
  $('#play').textContent = S.playing ? '❚❚' : '▶';
  clearInterval(timer);
  if (S.playing && S.meta && S.meta.n > 1) {
    timer = setInterval(() => step(1), 1000 / (S.meta.fps || 25));
  }
}

function step(d) {
  if (!S.meta || S.meta.n < 1) return;
  S.frame = (S.frame + d + S.meta.n) % S.meta.n;
  $('#frame').value = S.frame;
  showFrame();
}

/** Point the viewer at a node's result. */
export function showResult(hash, meta, notes = []) {
  S.meta = meta;
  S.notes = notes;
  const slider = $('#frame');
  const n = meta ? meta.n : 0;
  if (S.frame >= n) S.frame = 0;
  slider.max = Math.max(0, n - 1);
  slider.value = S.frame;
  slider.disabled = n < 2;
  $('#play').disabled = n < 2;
  if (!S.playing && n < 2) clearInterval(timer);
  $('#s-frames').textContent = String(n);
  $('#s-size').textContent = meta ? `${meta.w}×${meta.h}` : '—';
  $('#empty').hidden = !!hash;
  $('#view').hidden = !hash;
  showFrame(hash);
  // The zoom is deliberately kept across edits -- that is the point of it in a
  // studio -- but a new result can change the aspect, so the pan limits and
  // the magnification readout have to be recomputed against the new size.
  syncZoom();
  renderOsd(meta, notes);
}

let currentHash = null;

function showFrame(hash) {
  if (hash !== undefined) currentHash = hash;
  const img = $('#view');
  if (!currentHash) { img.hidden = true; return; }
  img.hidden = false;
  // Reserve the box before the new frame loads. Without an intrinsic size the
  // img collapses to nothing for the duration of the fetch, and because the
  // stage is transform-centred, a collapsing box makes the artwork jump every
  // time a parameter changes.
  if (S.meta && S.meta.w) {
    img.width = S.meta.w;
    img.height = S.meta.h;
  }
  const url = frameUrl(currentHash, S.frame);
  if (img.getAttribute('src') !== url) img.src = url;
  $('#s-frame').textContent = String(S.frame);
}

export function clearViewer() {
  currentHash = null;
  S.meta = null;
  clearInterval(timer);
  S.playing = false;
  $('#play').textContent = '▶';
  $('#view').hidden = true;
  $('#empty').hidden = false;
  resetZoom();
  $('#osd').textContent = '';
  $('#s-frames').textContent = '0';
  $('#s-size').textContent = '—';
}

function renderOsd(meta, notes) {
  const osd = $('#osd');
  osd.textContent = '';
  if (!meta) return;
  const spec = S.byId[(S.proj.chain[S.sel] || {}).op];
  if (spec) osd.append(el('span', { class: 'chip' }, spec.label));
  osd.append(el('span', { class: 'chip dim' }, `${meta.w}×${meta.h}`));
  if (meta.n > 1) {
    osd.append(el('span', { class: 'chip dim' }, `${meta.n} fr · ${fmt(meta.fps, 0)}fps`));
  }
  if (S.fastPreviewShown) {
    osd.append(el('span', { class: 'chip warn' }, 'preview'));
  }
  for (const note of notes.slice(0, 2)) {
    osd.append(el('span', { class: 'chip warn', title: note },
      note.length > 46 ? note.slice(0, 44) + '…' : note));
  }
}

export function setBusy(busy, note, progress) {
  S.busy = busy;
  const chip = $('#s-job');
  chip.textContent = busy ? (note || 'working') : 'idle';
  chip.className = busy ? 'chip' : 'chip dim';
  $('#bar').style.width = busy ? Math.round((progress || 0) * 100) + '%' : '0%';
}
