/* The chain strip: the project itself, as a row of cards.
 *
 * A card shows the node's own output, not the final result, so the strip reads
 * as the story of how the picture got here -- and a node whose thumbnail is
 * missing is a node that has not been evaluated yet, which is exactly the
 * information you want when a chain is half warm.
 */

import { $, el, on } from './dom.js';
import { thumbUrl } from './api.js';
import { S, fire, moveNode, removeNode } from './state.js';

let dragFrom = -1;

export function initChain() {
  on($('#clearchain'), 'click', () => {
    if (!S.proj.chain.length) return;
    S.proj.chain = [];
    S.hashes = {};
    S.sel = -1;
    fire('chain');
  });
}

export function renderChain() {
  const host = $('#chain');
  if (!host) return;
  const scroll = host.scrollLeft;
  host.textContent = '';

  S.proj.chain.forEach((n, i) => {
    const spec = S.byId[n.op];
    const hash = S.hashes[i];
    const card = el('div', {
      class: 'node',
      draggable: 'true',
      'data-sel': String(i === S.sel),
      'data-off': String(!!n.off),
      'data-state': hash ? 'ok' : 'stale',
      title: (spec ? spec.blurb : n.op) + '\n\nDrag to reorder. Click to select.',
      onclick: () => { S.sel = i; fire('select'); },
      ondragstart: (e) => {
        dragFrom = i;
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without payload.
        e.dataTransfer.setData('text/plain', String(i));
      },
      ondragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
      ondrop: (e) => {
        e.preventDefault();
        if (dragFrom >= 0 && dragFrom !== i) moveNode(dragFrom, i);
        dragFrom = -1;
      },
    });

    card.append(hash
      ? el('img', { class: 'nt', src: thumbUrl(hash, 0), alt: '', loading: 'lazy' })
      : el('div', { class: 'nph' }, n.off ? 'off' : '…'));
    card.append(el('div', { class: 'nn' }, spec ? spec.label : n.op));
    card.append(el('div', { class: 'nc' }, spec ? spec.cat : '?'));
    card.append(el('button', {
      class: 'nx',
      title: n.off ? 'Switch this node back on' : 'Switch this node off',
      onclick: (e) => {
        e.stopPropagation();
        n.off = !n.off;
        for (const k of Object.keys(S.hashes)) if (+k >= i) delete S.hashes[k];
        fire('chain');
      },
    }, n.off ? '○' : '●'));
    card.append(el('button', {
      class: 'nx',
      style: 'right:18px',
      title: 'Remove this node',
      onclick: (e) => { e.stopPropagation(); removeNode(i); },
    }, '×'));

    host.append(card);
  });

  host.append(el('button', {
    class: 'add',
    title: 'Pick an op from the library on the left',
    onclick: () => { $('#opsearch').focus(); },
  }, S.proj.chain.length ? '+ add' : '+ start here'));

  host.scrollLeft = scroll;

  const off = S.proj.chain.filter((n) => n.off).length;
  $('#s-chainnote').textContent = S.proj.chain.length
    ? `${S.proj.chain.length} node${S.proj.chain.length > 1 ? 's' : ''}` +
      (off ? `, ${off} off` : '')
    : '';
}
