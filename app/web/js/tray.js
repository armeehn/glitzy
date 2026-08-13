/* The tray and the exports.
 *
 * The tray holds finished designs by their content hash, which means a kept
 * design is pinned to the exact pixels you were looking at -- carrying on
 * editing the chain afterwards cannot quietly change what is on the sheet.
 */

import { $, el, on, toast } from './dom.js';
import { jpost, pollJob, thumbUrl } from './api.js';
import { S, fire } from './state.js';
import { setBusy } from './viewer.js';

export function initTray(ensureFull) {
  on($('#clearall'), 'click', () => {
    S.proj.tray = [];
    renderTray();
  });
  on($('#keep'), 'click', () => keep(ensureFull));
  on($('#mm'), 'input', (e) => {
    S.sticker.mm = +e.target.value;
    $('#mmv').textContent = e.target.value + ' mm';
    renderDpiNote();
  });
  on($('#dpi'), 'change', (e) => { S.sticker.dpi = +e.target.value; renderDpiNote(); });
  on($('#machine'), 'change', (e) => { S.sticker.machine = e.target.value; });

  on($('#ex-png'), 'click', () => runExport({ kind: 'png' }, ensureFull));
  on($('#ex-seq'), 'click', () => runExport({ kind: 'sequence' }, ensureFull));
  on($('#ex-gif'), 'click', () => runExport({ kind: 'gif' }, ensureFull));
  on($('#ex-apng'), 'click', () => runExport({ kind: 'apng' }, ensureFull));
  on($('#ex-sheet'), 'click', () => exportSheet());
}

export async function keep(ensureFull) {
  const hash = await ensureFull();
  if (!hash) return;
  const spec = S.byId[(S.proj.chain[S.sel] || {}).op];
  const vis = S.proj.layers.filter((l) => !l.off && l.chain.length).length;
  S.proj.tray.push({
    hash, frame: S.frame, mm: S.sticker.mm,
    name: (S.proj.name || 'sticker') + ' ' + (S.proj.tray.length + 1),
    label: S.composite ? `${vis} layers` : (spec ? spec.label : ''),
  });
  renderTray();
  toast(`Kept — ${S.proj.tray.length} on the sheet.`);
}

export function renderTray() {
  const host = $('#tray');
  if (!host) return;
  host.textContent = '';
  for (const [i, t] of S.proj.tray.entries()) {
    host.append(el('div', { class: 't', title: `${t.name}\nframe ${t.frame}` },
      el('img', { src: thumbUrl(t.hash, t.frame), alt: '', loading: 'lazy' }),
      el('button', {
        title: 'Remove from the sheet',
        onclick: () => { S.proj.tray.splice(i, 1); renderTray(); },
      }, '×')));
  }
  $('#traycount').textContent = String(S.proj.tray.length);
  $('#ex-sheet').disabled = !S.proj.tray.length;
  $('#trayhint').textContent = S.proj.tray.length
    ? 'Each of these becomes a sticker on the cut sheet.'
    : 'Kept results land here. Each becomes a sticker on the sheet.';
}

export function renderDpiNote() {
  const meta = S.meta;
  const note = $('#dpinote');
  if (!meta) { note.textContent = '—'; return; }
  const targetPx = (S.sticker.mm / 25.4) * S.sticker.dpi;
  const scale = Math.max(1, Math.ceil(targetPx / meta.w));
  const outPx = meta.w * scale;
  const realDpi = Math.round(outPx / (S.sticker.mm / 25.4));
  const blockMm = (16 * S.sticker.mm) / meta.w;
  note.textContent =
    `${meta.w} px → ${outPx} px at ${scale}× (${realDpi} dpi). ` +
    `One macroblock prints ${blockMm.toFixed(1)} mm wide.`;
}

/* ------------------------------------------------------------------------ */

function download(url, name) {
  const a = el('a', { href: url, download: name || '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function runExport(opts, ensureFull) {
  const hash = await ensureFull();
  if (!hash) return;
  try {
    setBusy(true, 'exporting', 0);
    const { job } = await jpost('/api/export', {
      ...opts, hash, frame: S.frame,
      mm: S.sticker.mm, dpi: S.sticker.dpi,
    });
    const done = await pollJob(job, (j) => setBusy(true, j.note || 'exporting', j.progress));
    download(done.result.url, done.result.name);
    toast(`${done.result.name} — ${(done.result.bytes / 1024).toFixed(0)} kB`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBusy(false);
  }
}

async function exportSheet() {
  if (!S.proj.tray.length) return;
  try {
    setBusy(true, 'packing sheet', 0);
    const { job } = await jpost('/api/export', {
      kind: 'sheet', items: S.proj.tray, machine: S.sticker.machine,
      dpi: S.sticker.dpi, name: S.proj.name,
    });
    const done = await pollJob(job, (j) => setBusy(true, j.note || 'packing', j.progress));
    download(done.result.url, done.result.name);
    const over = done.result.overflow;
    toast(over
      ? `Sheet built, but ${over} did not fit on one page — they were left off.`
      : `Sheet with ${S.proj.tray.length} sticker${S.proj.tray.length > 1 ? 's' : ''}` +
        ' — open it in Cutsheet.', !!over);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBusy(false);
  }
}

export function setExportEnabled(on) {
  for (const id of ['#ex-png', '#ex-seq', '#ex-gif', '#ex-apng', '#keep']) {
    $(id).disabled = !on;
  }
  $('#ex-sheet').disabled = !S.proj.tray.length;
}
