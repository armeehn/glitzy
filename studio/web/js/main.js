/* Wiring.
 *
 * The one piece of real logic here is evaluate(): every edit funnels into it,
 * and a generation counter makes sure that when you drag a slider through
 * fifteen values, only the newest answer is allowed to reach the screen. The
 * older jobs are cancelled on the backend rather than left to finish into a
 * viewer that has moved on.
 */

import { $, bytes, debounce, el, on, toast } from './dom.js';
import {
  deleteFile, fileLink, importProject, jdel, jget, jpost, listFiles, pollJob,
} from './api.js';
import { S, fire, makeProj, on as bus, setChain } from './state.js';
import { initLibrary, renderLibrary } from './library.js';
import { initChain, renderChain } from './chain.js';
import { initLayers, renderLayers } from './layers.js';
import { renderInspector, reloadSources } from './inspector.js';
import { initVariants, renderVariantPanel } from './variants.js';
import { clearViewer, initViewer, setBusy, showResult } from './viewer.js';
import { initZoom } from './zoom.js';
import { initTray, keep, renderDpiNote, renderTray, setExportEnabled } from './tray.js';

let gen = 0;

/* ------------------------------------------------------------------ eval -- */

async function evaluate({ preview = false } = {}) {
  const chain = S.proj.chain;
  // A layer with no chain is normal -- you add the layer, then reach for the
  // library -- so the project only counts as empty when nothing anywhere has
  // a chain. Otherwise the stack still renders and the empty layer sits out.
  if (!S.proj.layers.some((l) => l.chain.length)) {
    clearViewer();
    renderChain();
    renderLayers();
    renderInspector();
    setExportEnabled(false);
    return null;
  }
  const upto = S.sel >= 0 ? S.sel : chain.length - 1;
  const my = ++gen;
  try {
    setBusy(true, 'evaluating', 0);
    const start = await jpost('/api/eval', {
      layers: S.proj.layers.map(wireLayer), active: S.active,
      upto, preview, view: S.view,
    });
    const job = await pollJob(
      start.job,
      (j) => { if (my === gen) setBusy(true, j.note || 'evaluating', j.progress); },
      () => my !== gen,
    );
    if (my !== gen) return null;
    const res = job.result;
    for (const s of res.steps) S.hashes[s.i] = s.hash;
    for (const l of res.layers || []) {
      const layer = S.proj.layers[l.i];
      if (layer && l.hash) S.layerOut[layer.id] = l.hash;
    }
    S.fastPreviewShown = preview;
    S.previewHashes = preview;
    S.composite = !!res.composite;
    S.dirty = false;
    showResult(res.hash, res.meta, res.notes);
    renderChain();
    renderLayers();
    renderInspector();
    renderDpiNote();
    setExportEnabled(true);
    return res.hash;
  } catch (e) {
    if (e.cancelled || my !== gen) return null;
    toast(e.message, true);
    // Point at the layer and node that actually failed instead of blaming the
    // project. Selecting the layer first matters: the node index is an index
    // into THAT layer's chain and means nothing against another one.
    if (e.layer !== undefined && e.layer !== null && S.proj.layers[e.layer]) {
      S.active = e.layer;
      S.hashes = S.hashCache[S.proj.layers[e.layer].id] || {};
    }
    if (e.node !== undefined && e.node >= 0 && e.node < S.proj.chain.length) {
      S.sel = e.node;
    }
    renderChain();
    renderLayers();
    renderInspector();
    setExportEnabled(false);
    return null;
  } finally {
    if (my === gen) setBusy(false);
  }
}

/** What actually goes over the wire: the engine has no use for our ids, and
 *  a layer's node hashes are ours alone. */
function wireLayer(l) {
  const { id, ...rest } = l;
  return rest;
}

/** Keep and export must never ship a downscaled preview. */
async function ensureFull() {
  if (!S.proj.layers.some((l) => l.chain.length)) return null;
  // Whatever is on screen is what gets kept -- composite or soloed layer --
  // so the tray can never quietly hold something you were not looking at.
  if (S.shownHash && !S.previewHashes) return S.shownHash;
  return evaluate({ preview: false });
}

const evalSoon = debounce(() => evaluate({ preview: S.fast }), 220);

/* --------------------------------------------------------------- events -- */

bus('chain', () => { renderChain(); renderLayers(); renderInspector(); renderVariantPanel(); evalSoon(); });
bus('select', () => { renderChain(); renderInspector(); renderVariantPanel(); evalSoon(); });
bus('params', () => { renderChain(); evalSoon(); });
// Structural stack changes redraw everything; a compositing setting must not
// rebuild the inspector, or the slider being dragged is destroyed under the
// pointer -- the same split setParam/'params' already makes for node params.
bus('layers', () => { renderLayers(); renderChain(); renderInspector(); renderVariantPanel(); evalSoon(); });
bus('layerprop', () => { renderLayers(); evalSoon(); });
bus('commit', () => { evalSoon.cancel(); evaluate({ preview: false }); });
bus('starter', () => { renderVariantPanel(); });
bus('keep', () => keep(ensureFull));

/* ------------------------------------------------------------- projects -- */

async function saveProject() {
  try {
    const doc = await jpost('/api/project', {
      id: S.proj.id, name: $('#projname').value || 'untitled',
      layers: S.proj.layers, tray: S.proj.tray, sticker: S.sticker,
    });
    S.proj.id = doc.id;
    S.proj.name = doc.name;
    toast('Saved “' + doc.name + '”.');
  } catch (e) {
    toast(e.message, true);
  }
}

/** Hand the whole project over as a file the browser saves. */
async function saveProjectFile() {
  // Save first: the file has to be the project as the server understands it,
  // not as this tab happens to hold it, or a stale id or an uncoerced layer
  // rides along into a document meant to outlive the session.
  await saveProject();
  if (!S.proj.id) return;
  const a = el('a', { href: '/api/project/' + S.proj.id + '/file', download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function loadProjectFile(file) {
  if (!file) return;
  try {
    const doc = await importProject(file);
    applyProject(doc);
    $('#opendlg').close();
    toast(`Loaded “${doc.name}”.`);
  } catch (e) {
    toast(e.message, true);
  }
}

/** Everything needed to make a loaded document the live project. */
function applyProject(doc) {
  S.active = 0;
  S.hashes = {};
  S.hashCache = {};
  S.layerOut = {};
  S.proj = makeProj(doc);
  if (doc.sticker) Object.assign(S.sticker, doc.sticker);
  $('#projname').value = doc.name;
  $('#mm').value = S.sticker.mm;
  $('#mmv').textContent = S.sticker.mm + ' mm';
  setChain(S.proj.chain);
  renderTray();
}

/* ---------------------------------------------------------------- folds -- */

/** Collapsible rail panels, remembered across reloads.
 *
 *  Panels default to OPEN so nothing is hidden from someone who has never
 *  touched them -- the fold is there to get an unwanted panel out of the way,
 *  not to hide the app. A button living inside a <summary> (Tray's "clear")
 *  would otherwise toggle the panel as well as firing, so summary clicks that
 *  landed on a control are stopped before the toggle.
 */
function initFolds() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('gs.folds') || '{}'); } catch { saved = {}; }
  for (const d of document.querySelectorAll('details.panel[data-fold]')) {
    const key = d.dataset.fold;
    if (key in saved) d.open = !!saved[key];
    on(d, 'toggle', () => {
      saved[key] = d.open;
      try { localStorage.setItem('gs.folds', JSON.stringify(saved)); } catch { /* private mode */ }
    });
    const sum = d.querySelector(':scope > summary');
    on(sum, 'click', (e) => {
      if (e.target.closest('button, a, input, select')) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }
}

/* ---------------------------------------------------------------- files -- */

/** navigator.clipboard is undefined on a plain-http origin, and the studio is
 *  reachable over one on the LAN. Fall back rather than throw. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function filesDialog() {
  const dlg = $('#filesdlg');
  const list = $('#filelist');
  list.textContent = '';
  try {
    const { files, stats } = await listFiles();
    $('#filesstat').textContent =
      `${stats.files} file${stats.files === 1 ? '' : 's'} · ${bytes(stats.bytes)}`;
    if (!files.length) {
      list.append(el('p', { class: 'hint' }, 'Nothing exported yet.'));
    }
    for (const f of files) {
      const link = fileLink(f.id);
      list.append(el('div', { class: 'frow' },
        el('a', { href: '/api/file/' + f.id, target: '_blank', rel: 'noopener',
                  class: 'fname', title: 'Open ' + f.name }, f.name),
        el('span', { class: 'fmeta' },
          `${(f.kind || '').toUpperCase()} · ${bytes(f.bytes)}`),
        el('span', { class: 'spacer' }, ''),
        el('code', { class: 'flink', title: link }, link),
        el('button', {
          class: 'act',
          onclick: async (e) => {
            const ok = await copyText(link);
            e.target.textContent = ok ? 'copied' : 'select it';
            setTimeout(() => { e.target.textContent = 'copy'; }, 1400);
          },
        }, 'copy'),
        el('button', {
          class: 'act',
          onclick: async () => { await deleteFile(f.id); filesDialog(); },
        }, 'delete')));
    }
    dlg.showModal();
  } catch (e) {
    toast(e.message, true);
  }
}

async function openDialog() {
  const dlg = $('#opendlg');
  const list = $('#projlist');
  list.textContent = '';
  try {
    const { projects } = await jget('/api/projects');
    if (!projects.length) list.append(el('p', { class: 'hint' }, 'Nothing saved yet.'));
    for (const p of projects) {
      list.append(el('button', {
        onclick: async () => {
          applyProject(await jget('/api/project/' + p.id));
          dlg.close();
        },
      },
      el('b', {}, p.name),
      el('span', {}, `${p.nodes} node${p.nodes === 1 ? '' : 's'}` +
        (p.layers > 1 ? ` · ${p.layers} layers` : '')),
      el('span', { class: 'spacer' }, ''),
      el('span', {}, new Date(p.saved * 1000).toLocaleDateString()),
      el('span', {
        class: 'act',
        onclick: async (e) => {
          e.stopPropagation();
          await jdel('/api/project/' + p.id);
          openDialog();
        },
      }, 'delete')));
    }
    dlg.showModal();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ----------------------------------------------------------------- boot -- */

async function boot() {
  // The state object, exposed for the browser test and for poking at a live
  // studio from the console. Read-only by convention; nothing here reads it back.
  window.__gs = S;

  initViewer();
  initZoom();
  initChain();
  initLayers();
  initLibrary();
  initVariants();
  initTray(ensureFull);

  on($('#save'), 'click', saveProject);
  on($('#open'), 'click', openDialog);
  on($('#closeopen'), 'click', () => $('#opendlg').close());
  initFolds();
  on($('#files'), 'click', filesDialog);
  on($('#closefiles'), 'click', () => $('#filesdlg').close());
  on($('#about'), 'click', () => $('#aboutdlg').showModal());
  on($('#closeabout'), 'click', () => $('#aboutdlg').close());
  on($('#savefile'), 'click', saveProjectFile);
  on($('#loadfile'), 'click', () => $('#projfile').click());
  on($('#projfile'), 'change', (e) => {
    loadProjectFile(e.target.files[0]);
    e.target.value = '';   // or picking the same file twice fires no change
  });
  on($('#newproj'), 'click', () => {
    S.active = 0;
    S.hashes = {};
    S.hashCache = {};
    S.layerOut = {};
    S.proj = makeProj();
    $('#projname').value = 'untitled';
    renderTray();
    setChain([]);
  });
  on($('#projname'), 'change', (e) => { S.proj.name = e.target.value; });
  on($('#fastpreview'), 'change', (e) => { S.fast = e.target.checked; });
  on($('#renderall'), 'click', () => {
    S.sel = S.proj.chain.length - 1;
    renderChain();
    renderInspector();
    evaluate({ preview: false });
  });

  // Narrow layouts turn the rails into overlays; this cycles them.
  const panes = ['none', 'left', 'right'];
  document.body.dataset.pane = 'none';
  on($('#panes'), 'click', () => {
    const i = panes.indexOf(document.body.dataset.pane);
    document.body.dataset.pane = panes[(i + 1) % panes.length];
  });

  try {
    const reg = await jget('/api/ops');
    S.ops = reg.ops;
    S.cats = reg.categories;
    S.byId = Object.fromEntries(reg.ops.map((o) => [o.id, o]));
    if (reg.layer) S.layerSpec = reg.layer;
  } catch (e) {
    toast('Could not reach the engine: ' + e.message, true);
    return;
  }
  // Rebuilt now the layer schema is known, so the first layer carries the
  // engine's own compositing defaults rather than a guess.
  S.proj = makeProj(S.proj);
  await reloadSources();
  renderLibrary();
  renderChain();
  renderLayers();
  renderInspector();
  renderVariantPanel();
  renderTray();
  clearViewer();

  refreshHealth();
  setInterval(refreshHealth, 15000);
}

async function refreshHealth() {
  try {
    const h = await jget('/api/health');
    $('#s-engine').textContent = 'v' + h.version;
    $('#s-cache').textContent = `${h.cache.entries} · ${bytes(h.cache.bytes)}`;
    showEtsch(h.etsch);
  } catch {
    $('#s-engine').textContent = 'down';
  }
}

/* Where Etsch lives is deployment config, not a constant in the page.
 * The header link used to be hard-coded at a workers.dev host that was never
 * deployed, so it read as a working link and went nowhere; anything the studio
 * does not know about, it now hides instead of guessing. */
function showEtsch(url) {
  const base = (url || '').replace(/\/+$/, '');
  const link = $('#etsch-link');
  const btn = $('#ex-open');
  if (link) {
    link.hidden = !base;
    if (base) link.href = base + '/';
  }
  if (btn) btn.hidden = !base;
  const hint = $('#sheethint');
  if (hint && base) {
    hint.innerHTML = '<b>Open in Etsch</b> hands the sheet straight over in a '
      + 'new tab. The cut line follows the artwork\'s own alpha, so the '
      + 'silhouette and its die-cut border come with it.';
  }
}

boot();
