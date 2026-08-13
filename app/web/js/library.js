/* The op library.
 *
 * Rendered entirely from /api/ops. Nothing about any individual effect is
 * written down in the frontend, so adding an op to the backend makes it appear
 * here, in its category, with its own controls, without touching this file.
 */

import { $, el, on } from './dom.js';
import { S, addOp, fire } from './state.js';
import { STARTERS, buildChain } from './starters.js';
import { defaults, setChain } from './state.js';

let filter = '';

export function initLibrary() {
  on($('#opsearch'), 'input', (e) => {
    filter = e.target.value.trim().toLowerCase();
    renderLibrary();
  });
  renderStarters();
}

export function renderLibrary() {
  const host = $('#library');
  if (!host) return;
  host.textContent = '';
  $('#opcount').textContent = String(S.ops.length);

  const match = (o) =>
    !filter ||
    o.label.toLowerCase().includes(filter) ||
    o.id.toLowerCase().includes(filter) ||
    o.blurb.toLowerCase().includes(filter);

  let shown = 0;
  for (const cat of S.cats) {
    const ops = S.ops.filter((o) => o.cat === cat.id && match(o));
    if (!ops.length) continue;
    shown += ops.length;
    host.append(el('div', { class: 'libcat', title: cat.blurb }, cat.label));
    host.append(el('div', { class: 'libgrid' },
      ops.map((o) => el('button', {
        'data-cat': o.cat,
        title: o.blurb,
        onclick: () => addOp(o.id),
      }, o.label))));
  }
  if (!shown) host.append(el('p', { class: 'hint' }, 'Nothing matches “' + filter + '”.'));
}

function renderStarters() {
  const host = $('#starters');
  if (!host) return;
  host.textContent = '';
  for (const st of STARTERS) {
    host.append(el('button', {
      title: st.blurb,
      onclick: () => {
        setChain(buildChain(st, defaults));
        S.proj.name = st.name;
        $('#projname').value = st.name;
        fire('starter', st);
      },
    }, el('b', {}, st.name), el('i', {}, st.blurb)));
  }
}
