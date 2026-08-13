/* The layer stack: the project as a pile of chains.
 *
 * Drawn top-first, the way a stack is read everywhere else, while the array
 * itself is bottom-first the way the engine composites it. Every index that
 * crosses this boundary goes through the row's own data-i, never through the
 * position in the list -- inverting an index twice is the classic way a drag
 * lands one layer off.
 *
 * The row is deliberately thin. The compositing controls live in the
 * inspector, because the right rail is already taller than the window at
 * 768px and a second block of sliders down here would push the chain strip
 * into the artwork.
 */

import { $, el, on } from './dom.js';
import { thumbUrl } from './api.js';
import {
  S, addLayer, activeLayer, duplicateLayer, fire, moveLayer, removeLayer,
  setActive, setLayerProp,
} from './state.js';

let dragFrom = -1;

export function initLayers() {
  on($('#addlayer'), 'click', () => { addLayer(); $('#opsearch').focus(); });
  on($('#solo'), 'change', (e) => {
    S.view = e.target.checked ? 'layer' : 'composite';
    fire('layers');
  });
}

export function renderLayers() {
  const host = $('#stack');
  if (!host) return;
  const scroll = host.scrollTop;
  host.textContent = '';

  const ls = S.proj.layers;
  const anySolo = ls.some((l) => l.solo && !l.off);

  // Top of the stack is drawn first; i stays the real (bottom-first) index.
  for (let i = ls.length - 1; i >= 0; i--) {
    const l = ls[i];
    const hidden = l.off || (anySolo && !l.solo);
    const out = S.layerOut[l.id];
    const row = el('div', {
      class: 'lyr',
      draggable: 'true',
      'data-i': String(i),
      'data-sel': String(i === S.active),
      'data-off': String(!!hidden),
      title: `${l.name}\n${l.chain.length} node${l.chain.length === 1 ? '' : 's'}` +
        '\n\nClick to edit this layer. Drag to restack.',
      onclick: () => setActive(i),
      ondragstart: (e) => {
        dragFrom = i;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));  // Firefox needs payload
      },
      ondragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
      ondrop: (e) => {
        e.preventDefault();
        if (dragFrom >= 0 && dragFrom !== i) moveLayer(dragFrom, i);
        dragFrom = -1;
      },
    });

    row.append(el('button', {
      class: 'leye',
      title: l.off ? 'Show this layer' : 'Hide this layer',
      onclick: (e) => { e.stopPropagation(); setLayerProp(i, 'off', !l.off); },
    }, l.off ? '○' : '●'));

    row.append(out
      ? el('img', { class: 'lt', src: thumbUrl(out, 0), alt: '', loading: 'lazy' })
      : el('div', { class: 'lph' }, l.chain.length ? '…' : '+'));

    row.append(el('div', { class: 'lmeta' },
      el('b', {}, l.name),
      el('i', {}, blendLabel(l.blend) +
        (l.opacity !== 100 ? ` · ${l.opacity}%` : '') +
        (l.clip ? ' · clip' : ''))));

    row.append(el('button', {
      class: 'lsolo',
      'data-on': String(!!l.solo),
      title: 'Solo — show only this layer in the composite',
      onclick: (e) => { e.stopPropagation(); setLayerProp(i, 'solo', !l.solo); },
    }, 'S'));

    if (ls.length > 1) {
      row.append(el('button', {
        class: 'lx',
        title: 'Delete this layer',
        onclick: (e) => { e.stopPropagation(); removeLayer(i); },
      }, '×'));
    }

    host.append(row);
  }

  host.scrollTop = scroll;
  $('#addlayer').disabled = ls.length >= (S.layerSpec.max || 8);
  $('#s-stack').textContent = ls.length + (anySolo ? ' · solo' : '');
  const solo = $('#solo');
  if (solo) solo.checked = S.view === 'layer';
}

export function blendLabel(v) {
  const b = (S.layerSpec.blends || []).find((o) => o.v === v);
  return b ? b.label : (v || 'normal');
}

/* ------------------------------------------------------------------------ */
/* The layer's compositing controls, generated from the engine's schema and   */
/* rendered at the top of the inspector.                                      */
/* ------------------------------------------------------------------------ */

export function layerBox(control) {
  const l = activeLayer();
  if (!l) return null;
  // <details> so it costs one row when closed: the right rail already runs
  // past the bottom of a 768px window with the inspector and variants open.
  const box = el('details', { class: 'lbox' });
  if (S.layerOpen) box.open = true;
  on(box, 'toggle', () => { S.layerOpen = box.open; });

  box.append(el('summary', {},
    el('b', {}, l.name),
    el('i', {}, blendLabel(l.blend))));

  const name = el('input', { type: 'text', value: l.name, maxlength: '40' });
  on(name, 'change', () => setLayerProp(S.active, 'name', name.value || 'Layer'));
  box.append(el('label', { class: 'f' }, el('span', {}, 'Layer name'), name));

  const set = (k, v) => setLayerProp(S.active, k, v);
  for (const p of S.layerSpec.params || []) {
    box.append(control(p, l[p.k], set));
  }

  box.append(el('div', { class: 'row' },
    el('button', {
      class: 'btn sm', title: 'Copy this layer and its whole chain',
      onclick: () => duplicateLayer(S.active),
    }, 'Duplicate'),
    el('button', {
      class: 'btn sm', title: 'Add an empty layer above this one',
      onclick: () => addLayer(),
    }, 'Add layer')));

  return box;
}
