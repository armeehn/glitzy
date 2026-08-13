/* Variants: sweep one parameter and look at all the answers at once.
 *
 * The sweep runs on the backend and every variant shares the cached chain
 * prefix up to the node being swept, so twelve variants of the last node cost
 * twelve cheap tails rather than twelve whole chains. That is the difference
 * between "try a few" and "try everything".
 */

import { $, el, fmt, on, toast } from './dom.js';
import { jpost, pollJob, thumbUrl } from './api.js';
import { S, fire, selNode, setParam } from './state.js';
import { setBusy } from './viewer.js';

let running = null;

export function initVariants() {
  on($('#vn'), 'input', (e) => { $('#vnv').textContent = e.target.value; });
  on($('#vspread'), 'input', (e) => { $('#vspv').textContent = e.target.value + '%'; });
  on($('#sweep'), 'click', sweep);
}

/** Refresh the parameter dropdown for whatever node is selected. */
export function renderVariantPanel() {
  const sel = $('#vparam');
  const n = selNode();
  const spec = n ? S.byId[n.op] : null;
  sel.textContent = '';
  if (!spec) {
    sel.append(el('option', { value: '' }, 'select a node first'));
    $('#sweep').disabled = true;
    return;
  }
  const sweepable = spec.params.filter(
    (p) => spec.varies.includes(p.k) || p.type === 'enum' || p.type === 'bool');
  if (!sweepable.length) {
    sel.append(el('option', { value: '' }, 'nothing worth sweeping here'));
    $('#sweep').disabled = true;
    return;
  }
  for (const p of sweepable) sel.append(el('option', { value: p.k }, p.label));
  $('#sweep').disabled = false;
}

function valuesFor(spec, param, current, count, spreadPct) {
  const p = spec.params.find((x) => x.k === param);
  if (!p) return [];
  if (p.type === 'bool') return [false, true];
  if (p.type === 'enum') return p.options.slice(0, count).map((o) => o.v);
  if (p.type === 'seed') {
    // A seed has no meaningful neighbourhood, so sweeping it means sampling it.
    return Array.from({ length: count }, () =>
      1 + Math.floor(Math.random() * (p.max - 1)));
  }
  // Numbers sweep a window centred on where you already are, so a sweep is a
  // question about this value rather than about the whole slider.
  const span = (p.max - p.min) * (spreadPct / 100);
  let lo = Math.max(p.min, current - span / 2);
  let hi = Math.min(p.max, lo + span);
  lo = Math.max(p.min, hi - span);
  const step = count > 1 ? (hi - lo) / (count - 1) : 0;
  const int = Number.isInteger(p.step) && Number.isInteger(p.min);
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = lo + step * i;
    out.push(int ? Math.round(v) : +v.toFixed(3));
  }
  return [...new Set(out)];
}

async function sweep() {
  const n = selNode();
  const spec = n ? S.byId[n.op] : null;
  const param = $('#vparam').value;
  if (!spec || !param) return;

  const count = +$('#vn').value;
  const spread = +$('#vspread').value;
  const values = valuesFor(spec, param, n.params[param], count, spread);
  if (!values.length) return toast('Nothing to sweep there.', true);

  const grid = $('#vgrid');
  grid.textContent = '';
  values.forEach((v) => {
    grid.append(el('div', { class: 'vcard' },
      el('div', { class: 'vph' }, '…'),
      el('div', { class: 'vn' }, String(v))));
  });

  try {
    setBusy(true, 'sweeping', 0);
    const { job } = await jpost('/api/variants', {
      chain: S.proj.chain, index: S.sel, param, values,
    });
    running = job;
    const done = await pollJob(job, (j) =>
      setBusy(true, j.note || 'sweeping', j.progress));
    renderResults(param, done.result.variants);
    const ok = done.result.variants.filter((v) => v.hash).length;
    toast(`${ok} of ${done.result.variants.length} variants rendered.`);
  } catch (e) {
    if (!e.cancelled) toast(e.message, true);
  } finally {
    running = null;
    setBusy(false);
  }
}

function renderResults(param, variants) {
  const grid = $('#vgrid');
  grid.textContent = '';
  const cur = (selNode() || {}).params?.[param];
  for (const v of variants) {
    if (v.error) {
      grid.append(el('div', { class: 'vcard', title: v.error },
        el('div', { class: 'vph' }, '✕'),
        el('div', { class: 'vn' }, String(v.value))));
      continue;
    }
    grid.append(el('button', {
      class: 'vcard',
      'data-cur': String(v.value === cur),
      title: `${param} = ${v.value}\n\nClick to adopt this value.`,
      onclick: () => {
        setParam(S.sel, param, v.value);
        fire('commit');
        toast(`${param} = ${v.value}`);
      },
    },
    el('img', { src: thumbUrl(v.hash, 0), alt: '', loading: 'lazy' }),
    el('div', { class: 'vn' }, typeof v.value === 'number' ? fmt(v.value) : String(v.value))));
  }
}

export function cancelSweep() {
  if (running) fetch('/api/job/' + running + '/cancel', { method: 'POST' });
}
