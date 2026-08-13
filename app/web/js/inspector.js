/* The inspector: controls for the selected node, generated from its schema.
 *
 * There is one control per parameter TYPE, not per op. The backend decides
 * what a parameter is and what range it has, and this file only knows how to
 * draw a number, a toggle, a choice, a colour and a file reference.
 */

import { $, el, fmt, on, toast } from './dom.js';
import { jget, jpost, upload } from './api.js';
import { S, fire, selNode, setParam } from './state.js';

export function renderInspector() {
  const host = $('#inspector');
  const badge = $('#s-node');
  if (!host) return;
  host.textContent = '';

  const n = selNode();
  if (!n) {
    badge.textContent = 'nothing selected';
    host.append(el('p', { class: 'hint' },
      'Pick a node in the chain below, or add one from the library.'));
    return;
  }
  const spec = S.byId[n.op];
  if (!spec) {
    badge.textContent = n.op;
    host.append(el('p', { class: 'err' }, 'This engine has no op called ' + n.op + '.'));
    return;
  }

  badge.textContent = spec.cat;
  host.append(el('p', { class: 'blurb' }, spec.blurb));

  for (const p of spec.params) {
    host.append(control(S.sel, p, n.params[p.k]));
  }

  for (const note of S.notes.filter(Boolean)) {
    host.append(el('p', { class: 'note' }, note));
  }
}

function control(i, p, value) {
  switch (p.type) {
    case 'bool': return boolCtl(i, p, value);
    case 'enum': return enumCtl(i, p, value);
    case 'colour': return colourCtl(i, p, value);
    case 'source': return sourceCtl(i, p, value);
    case 'text': return textCtl(i, p, value);
    case 'seed': return seedCtl(i, p, value);
    default: return numCtl(i, p, value);
  }
}

function label(p, valueNode) {
  return el('span', {}, p.label, valueNode || '');
}

function numCtl(i, p, value) {
  const out = el('b', {}, fmt(value) + (p.suffix || ''));
  const range = el('input', {
    type: 'range', min: p.min, max: p.max, step: p.step || 1, value,
  });
  // `input` fires per pixel of drag and drives the live preview; `change`
  // fires once on release and asks for the full-quality render.
  on(range, 'input', () => {
    out.textContent = fmt(range.value) + (p.suffix || '');
    setParam(i, p.k, +range.value);
  });
  on(range, 'change', () => fire('commit'));
  return el('label', { class: 'f', title: p.hint || '' }, label(p, out), range);
}

function seedCtl(i, p, value) {
  const out = el('b', {}, String(value));
  const range = el('input', {
    type: 'range', min: p.min, max: p.max, step: 1, value,
  });
  on(range, 'input', () => {
    out.textContent = range.value;
    setParam(i, p.k, +range.value);
  });
  on(range, 'change', () => fire('commit'));
  const dice = el('button', {
    class: 'act', title: 'Roll a new seed',
    onclick: () => {
      const v = 1 + Math.floor(Math.random() * (p.max - 1));
      range.value = v;
      out.textContent = String(v);
      setParam(i, p.k, v);
      fire('commit');
    },
  }, 'roll');
  return el('label', { class: 'f' },
    el('span', {}, p.label, el('span', { class: 'row' }, out, dice)), range);
}

function boolCtl(i, p, value) {
  const box = el('input', { type: 'checkbox' });
  box.checked = !!value;
  on(box, 'change', () => { setParam(i, p.k, box.checked); fire('commit'); });
  return el('label', { class: 'inline', title: p.hint || '' }, box,
    el('span', {}, p.label));
}

function enumCtl(i, p, value) {
  const sel = el('select', {});
  for (const o of p.options) {
    const opt = el('option', { value: o.v }, o.label);
    if (o.v === value) opt.selected = true;
    sel.append(opt);
  }
  on(sel, 'change', () => { setParam(i, p.k, sel.value); fire('commit'); });
  return el('label', { class: 'f', title: p.hint || '' }, label(p), sel);
}

function colourCtl(i, p, value) {
  const inp = el('input', { type: 'color', value: /^#/.test(value) ? value : '#000000' });
  on(inp, 'change', () => { setParam(i, p.k, inp.value); fire('commit'); });
  return el('label', { class: 'f', title: p.hint || '' }, label(p), inp);
}

function textCtl(i, p, value) {
  const inp = el('input', { type: 'text', value: value || '', placeholder: p.placeholder || '' });
  on(inp, 'change', () => { setParam(i, p.k, inp.value); fire('commit'); });
  return el('label', { class: 'f', title: p.hint || '' }, label(p), inp);
}

/* ------------------------------------------------------------------------ */
/* Source picker                                                             */
/* ------------------------------------------------------------------------ */

function sourceCtl(i, p, value) {
  const wrap = el('div', { class: 'pbody', style: 'margin-top:0' });
  const sel = el('select', {});
  const refresh = () => {
    sel.textContent = '';
    sel.append(el('option', { value: '' }, S.sources.length
      ? '— pick a file —' : '— nothing uploaded yet —'));
    for (const s of S.sources) {
      const opt = el('option', { value: s.id },
        `${s.name} · ${s.width}×${s.height}${s.kind === 'video' ? ' clip' : ''}`);
      if (s.id === value) opt.selected = true;
      sel.append(opt);
    }
  };
  refresh();
  on(sel, 'change', () => { setParam(i, p.k, sel.value); fire('commit'); });

  const file = el('input', { type: 'file', accept: 'image/*,video/*' });
  on(file, 'change', async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      toast('Uploading ' + f.name + '…');
      const meta = await upload(f);
      await reloadSources();
      refresh();
      sel.value = meta.id;
      setParam(i, p.k, meta.id);
      fire('commit');
      toast(`${meta.name} — ${meta.width}×${meta.height}` +
        (meta.kind === 'video' ? `, ${fmt(meta.duration, 1)}s` : ''));
    } catch (e) {
      toast(e.message, true);
    }
  });

  const url = el('input', { type: 'text', placeholder: 'https://…/clip.mp4' });
  const fetchBtn = el('button', {
    class: 'btn wide',
    onclick: async () => {
      if (!url.value.trim()) return toast('Paste a link first.', true);
      try {
        toast('Fetching…');
        const meta = await jpost('/api/source/url', { url: url.value.trim() });
        await reloadSources();
        refresh();
        sel.value = meta.id;
        setParam(i, p.k, meta.id);
        fire('commit');
        toast(`${meta.name} — ${meta.width}×${meta.height}`);
      } catch (e) {
        toast(e.message, true);
      }
    },
  }, 'Fetch from URL');

  wrap.append(
    el('label', { class: 'f' }, el('span', {}, p.label), sel),
    el('button', {
      class: 'btn wide', onclick: () => file.click(),
    }, 'Upload a file…'),
    file, url, fetchBtn,
    el('p', { class: 'hint' },
      'Stills work, but they have no motion for the codec ops to abuse — put ' +
      'Time ▸ Drift after this to give them a camera move.'),
  );
  return wrap;
}

export async function reloadSources() {
  try {
    const r = await jget('/api/sources');
    S.sources = r.sources || [];
  } catch { /* the picker just stays empty */ }
}
