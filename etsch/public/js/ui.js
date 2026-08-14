// Panel wiring: binds every control to the document and keeps them in sync.
import {
  doc, images, getImage, selection, setSelection, selectedItems, getItem,
  pageSize, marginRect, setPagePreset, applyProfile, commit, notify,
  historyState, undo, redo, moveToIndex, itemBounds, removeItems, defaultCut,
} from './state.js';
import { PAGE_PRESETS, MACHINE_PROFILES, findProfile } from './presets.js';
import { MARK_STYLES } from './marks.js';
import { parseLength, fmt, fmtWithUnit, UNITS, MM_PER_IN, clamp } from './units.js';
import { view, invalidate, fitToView, zoomTo } from './render.js';
import { pendingTraces } from './cutpaths.js';
import * as actions from './actions.js';
import * as exporters from './exporters.js';
import * as project from './project.js';

const $ = (id) => document.getElementById(id);
const refreshers = [];
const onRefresh = (fn) => refreshers.push(fn);

let lockAspect = true;
let suppressSync = false;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, kind === 'error' ? 6000 : 3200);
}

function change(el, event, fn) {
  el.addEventListener(event, fn);
}

/**
 * Binds a text input to a millimetre value. Accepts unit suffixes and
 * fractions; arrow keys step the value.
 */
function bindLength(input, get, set, { label = 'edit', min = -1e6, max = 1e6 } = {}) {
  const apply = (mm, withHistory = true) => {
    const v = clamp(mm, min, max);
    if (withHistory) commit(label);
    set(v);
    notify('doc');
  };

  change(input, 'change', () => {
    const mm = parseLength(input.value, doc.unit);
    if (mm === null) {
      sync();
      return;
    }
    apply(mm);
  });

  change(input, 'keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = parseLength(input.value, doc.unit) ?? get();
    const step = UNITS[doc.unit].step * (e.shiftKey ? 10 : 1);
    const delta = (e.key === 'ArrowUp' ? 1 : -1) * step;
    const next = cur + delta / UNITS[doc.unit].perMm;
    input.value = fmt(next, doc.unit);
    apply(next);
  });

  onRefresh(() => {
    if (document.activeElement !== input) input.value = fmt(get(), doc.unit);
  });
}

function bindCheck(input, get, set, label) {
  change(input, 'change', () => {
    commit(label);
    set(input.checked);
    notify('doc');
  });
  onRefresh(() => {
    input.checked = !!get();
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function initUi() {
  buildSelects();
  wireTopbar();
  wireSheetPanel();
  wireMarks();
  wireLayoutTools();
  wireGuides();
  wireSelectionPanel();
  wireLayers();
  wireExport();
  wireDropZone();
  sync();
}

function buildSelects() {
  const profile = $('machine-profile');
  for (const p of MACHINE_PROFILES) {
    profile.append(new Option(p.label, p.id));
  }

  const preset = $('page-preset');
  let group = null;
  for (const p of PAGE_PRESETS) {
    if (!group || group.label !== p.group) {
      group = document.createElement('optgroup');
      group.label = p.group;
      preset.append(group);
    }
    group.append(new Option(p.label, p.id));
  }

  const marks = $('mark-style');
  for (const m of MARK_STYLES) marks.append(new Option(m.label, m.id));
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function wireTopbar() {
  const fileInput = $('file-input');
  const openImport = () => fileInput.click();
  $('btn-import').onclick = openImport;
  $('btn-import-2').onclick = openImport;

  change(fileInput, 'change', async () => {
    await importFiles([...fileInput.files]);
    fileInput.value = '';
  });

  $('btn-undo').onclick = () => {
    if (undo()) invalidate();
  };
  $('btn-redo').onclick = () => {
    if (redo()) invalidate();
  };

  $('btn-new').onclick = async () => {
    if (doc.items.length && !confirm('Start a new sheet? Unsaved changes will be lost.')) return;
    project.newProject();
    fitToView();
    invalidate();
  };

  $('btn-open').onclick = () => $('project-input').click();
  change($('project-input'), 'change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await project.loadProjectFile(file);
      fitToView();
      invalidate();
      toast(`Opened ${file.name}`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('btn-save').onclick = saveProject;

  $('btn-zoom-in').onclick = () => {
    zoomTo(view.scale * 1.25);
    invalidate();
  };
  $('btn-zoom-out').onclick = () => {
    zoomTo(view.scale / 1.25);
    invalidate();
  };
  $('btn-zoom-level').onclick = () => {
    fitToView();
    invalidate();
  };

  $('btn-help').onclick = () => $('help-dialog').showModal();
  $('btn-export').onclick = openExport;
}

export async function saveProject() {
  try {
    const blob = await project.serializeProject();
    exporters.download(blob, `${exporters.safeName(doc.name)}.cutsheet.json`);
    toast('Project saved', 'ok');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
}

export async function importFiles(files, at = null) {
  const imageFiles = files.filter((f) => f.type.startsWith('image/'));
  const projectFile = files.find((f) => /\.(json|cutsheet)$/i.test(f.name) && !f.type.startsWith('image/'));

  if (projectFile) {
    try {
      await project.loadProjectFile(projectFile);
      fitToView();
      invalidate();
      toast(`Opened ${projectFile.name}`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  if (!imageFiles.length) {
    toast('No supported images in that drop', 'error');
    return;
  }

  const ids = [];
  for (const file of imageFiles) {
    try {
      const rec = await actions.loadImageFile(file);
      ids.push(rec.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (!ids.length) return;

  actions.placeImages(ids, { at });
  fitIfFirst();
  invalidate();
  toast(`Added ${ids.length} image${ids.length > 1 ? 's' : ''}`, 'ok');
}

let hasFit = false;
function fitIfFirst() {
  if (hasFit) return;
  hasFit = true;
  fitToView();
}

// ---------------------------------------------------------------------------
// Sheet panel
// ---------------------------------------------------------------------------

function wireSheetPanel() {
  change($('machine-profile'), 'change', (e) => {
    commit('machine profile');
    applyProfile(e.target.value);
    invalidate();
  });

  change($('page-preset'), 'change', (e) => {
    commit('page size');
    setPagePreset(e.target.value);
    fitToView();
    invalidate();
  });

  bindLength($('page-w'), () => doc.page.w, (v) => {
    doc.page.w = v;
    doc.page.preset = 'custom';
  }, { label: 'page width', min: 10 });

  bindLength($('page-h'), () => doc.page.h, (v) => {
    doc.page.h = v;
    doc.page.preset = 'custom';
  }, { label: 'page height', min: 10 });

  for (const btn of $('orientation').querySelectorAll('button')) {
    btn.onclick = () => {
      if (doc.page.orientation === btn.dataset.value) return;
      commit('orientation');
      doc.page.orientation = btn.dataset.value;
      notify('page');
      fitToView();
      invalidate();
    };
  }

  change($('units'), 'change', (e) => {
    doc.unit = e.target.value;
    notify('doc');
  });

  bindLength($('bleed'), () => doc.bleed, (v) => {
    doc.bleed = v;
  }, { label: 'bleed', min: 0, max: 50 });

  $('margin-link').onclick = () => {
    doc.margins.linked = !doc.margins.linked;
    if (doc.margins.linked) {
      const v = doc.margins.t;
      Object.assign(doc.margins, { r: v, b: v, l: v });
    }
    notify('doc');
  };

  for (const side of ['t', 'r', 'b', 'l']) {
    bindLength($(`margin-${side}`), () => doc.margins[side], (v) => {
      if (doc.margins.linked) Object.assign(doc.margins, { t: v, r: v, b: v, l: v });
      else doc.margins[side] = v;
    }, { label: 'margin', min: 0 });
  }

  onRefresh(() => {
    $('machine-profile').value = doc.machine;
    const note = findProfile(doc.machine).note;
    $('machine-note').textContent = note || '';
    $('machine-note').hidden = !note;

    $('page-preset').value = doc.page.preset;
    $('units').value = doc.unit;
    for (const btn of $('orientation').querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.value === doc.page.orientation);
    }
    $('margin-link').classList.toggle('on', doc.margins.linked);

    const p = pageSize();
    const m = marginRect();
    const media = { w: p.w + doc.bleed * 2, h: p.h + doc.bleed * 2 };
    $('sheet-readout').innerHTML =
      `Trim <b>${fmt(p.w, doc.unit)} × ${fmt(p.h, doc.unit)} ${doc.unit}</b><br>` +
      `With bleed <b>${fmt(media.w, doc.unit)} × ${fmt(media.h, doc.unit)} ${doc.unit}</b><br>` +
      `Live area <b>${fmt(Math.max(0, m.w), doc.unit)} × ${fmt(Math.max(0, m.h), doc.unit)} ${doc.unit}</b>`;
  });
}

function wireMarks() {
  change($('mark-style'), 'change', (e) => {
    commit('marks');
    doc.marks.style = e.target.value;
    notify('doc');
  });
  bindLength($('mark-size'), () => doc.marks.size, (v) => {
    doc.marks.size = v;
  }, { label: 'mark size', min: 0.5 });
  bindLength($('mark-offset'), () => doc.marks.offset, (v) => {
    doc.marks.offset = v;
  }, { label: 'mark inset', min: 0 });

  onRefresh(() => {
    $('mark-style').value = doc.marks.style;
  });
}

function wireLayoutTools() {
  bindLength($('gutter'), () => doc.layout.gutter, (v) => {
    doc.layout.gutter = v;
  }, { label: 'gutter', min: 0 });

  $('btn-arrange').onclick = () => {
    const res = actions.autoArrange({ gutter: doc.layout.gutter });
    invalidate();
    if (res.overflow) toast(`${res.overflow} image${res.overflow > 1 ? 's' : ''} did not fit on the sheet`, 'error');
    else if (res.placed) toast(`Arranged ${res.placed} images`, 'ok');
  };

  $('btn-tile').onclick = () => {
    if (selection.size !== 1) {
      toast('Select exactly one image to fill the sheet with', 'error');
      return;
    }
    const res = actions.tileSelection({ gutter: doc.layout.gutter });
    invalidate();
    toast(`Filled the sheet — ${res.cols} × ${res.rows} = ${res.added} copies`, 'ok');
  };

  for (const btn of $('align-buttons').querySelectorAll('button')) {
    btn.onclick = () => {
      if (!selection.size) {
        toast('Select something to align first', 'error');
        return;
      }
      if (btn.dataset.align) actions.align(btn.dataset.align, $('align-target').value);
      else actions.distribute(btn.dataset.distribute);
      invalidate();
    };
  }
}

function wireGuides() {
  bindCheck($('show-bleed'), () => doc.view.showBleed, (v) => { doc.view.showBleed = v; }, 'view');
  bindCheck($('show-margins'), () => doc.view.showMargins, (v) => { doc.view.showMargins = v; }, 'view');
  bindCheck($('show-cut'), () => doc.view.showCut, (v) => { doc.view.showCut = v; }, 'view');
  bindCheck($('show-images'), () => doc.view.showImages, (v) => { doc.view.showImages = v; }, 'view');
  bindCheck($('show-grid'), () => doc.grid.show, (v) => { doc.grid.show = v; }, 'grid');
  bindCheck($('snap-grid'), () => doc.grid.snapGrid, (v) => { doc.grid.snapGrid = v; }, 'snap');
  bindCheck($('snap-guides'), () => doc.grid.snapGuides, (v) => { doc.grid.snapGuides = v; }, 'snap');
  bindCheck($('snap-edges'), () => doc.grid.snapEdges, (v) => { doc.grid.snapEdges = v; }, 'snap');
  bindLength($('grid-size'), () => doc.grid.size, (v) => {
    doc.grid.size = v;
  }, { label: 'grid size', min: 0.5 });
}

// ---------------------------------------------------------------------------
// Selection panel
// ---------------------------------------------------------------------------

function firstSelected() {
  return selectedItems()[0] || null;
}

/** Width in mm the image would print at 100% (its natural 300 DPI size). */
function naturalWidth(img) {
  return (img.width / 300) * MM_PER_IN;
}

function applyToSelection(fn, label) {
  const items = selectedItems();
  if (!items.length) return;
  commit(label);
  for (const it of items) fn(it);
  notify('transform');
  invalidate();
}

function bindItemLength(input, get, set, label) {
  const commitValue = (mm) => {
    const items = selectedItems();
    if (!items.length) return;
    commit(label);
    for (const it of items) set(it, mm);
    notify('transform');
    invalidate();
  };

  change(input, 'change', () => {
    const mm = parseLength(input.value, doc.unit);
    if (mm === null) {
      sync();
      return;
    }
    commitValue(mm);
  });

  change(input, 'keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const it = firstSelected();
    if (!it) return;
    const cur = parseLength(input.value, doc.unit) ?? get(it);
    const step = UNITS[doc.unit].step * (e.shiftKey ? 10 : 1);
    const next = cur + ((e.key === 'ArrowUp' ? 1 : -1) * step) / UNITS[doc.unit].perMm;
    input.value = fmt(next, doc.unit);
    commitValue(next);
  });

  onRefresh(() => {
    const it = firstSelected();
    if (!it || document.activeElement === input) return;
    input.value = fmt(get(it), doc.unit);
  });
}

function wireSelectionPanel() {
  bindItemLength($('it-x'), (it) => itemBounds(it).x, (it, v) => {
    it.cx += v - itemBounds(it).x;
  }, 'position');
  bindItemLength($('it-y'), (it) => itemBounds(it).y, (it, v) => {
    it.cy += v - itemBounds(it).y;
  }, 'position');

  bindItemLength($('it-w'), (it) => it.w, (it, v) => {
    const next = Math.max(0.5, v);
    if (lockAspect) it.h *= next / it.w;
    it.w = next;
  }, 'size');
  bindItemLength($('it-h'), (it) => it.h, (it, v) => {
    const next = Math.max(0.5, v);
    if (lockAspect) it.w *= next / it.h;
    it.h = next;
  }, 'size');

  $('it-lock-aspect').onclick = () => {
    lockAspect = !lockAspect;
    $('it-lock-aspect').classList.toggle('on', lockAspect);
  };

  change($('it-rot'), 'change', () => {
    const v = parseFloat($('it-rot').value);
    if (!Number.isFinite(v)) {
      sync();
      return;
    }
    applyToSelection((it) => { it.rot = ((v % 360) + 360) % 360; }, 'rotate');
  });

  // Scale is expressed against the image's natural 300 DPI print size.
  change($('it-scale'), 'change', () => {
    const v = parseFloat($('it-scale').value);
    if (!Number.isFinite(v) || v <= 0) {
      sync();
      return;
    }
    applyToSelection((item) => {
      const img = getImage(item.imageId);
      if (!img) return;
      const factor = ((v / 100) * naturalWidth(img)) / item.w;
      item.w *= factor;
      item.h *= factor;
    }, 'scale');
  });

  $('it-flip-h').onclick = () => applyToSelection((it) => { it.flipH = !it.flipH; }, 'flip');
  $('it-flip-v').onclick = () => applyToSelection((it) => { it.flipV = !it.flipV; }, 'flip');
  $('it-rot-90').onclick = () => applyToSelection((it) => { it.rot = (it.rot + 90) % 360; }, 'rotate');

  $('it-fit').onclick = () => {
    actions.fitSelection('contain');
    invalidate();
  };
  $('it-actual').onclick = () => applyToSelection((it) => actions.actualSize(it), 'actual size');
  $('it-center').onclick = () => {
    const p = pageSize();
    applyToSelection((it) => {
      const b = itemBounds(it);
      it.cx += p.w / 2 - (b.x + b.w / 2);
      it.cy += p.h / 2 - (b.y + b.h / 2);
    }, 'centre');
  };

  $('it-duplicate').onclick = () => {
    actions.duplicateSelected();
    invalidate();
  };
  $('it-delete').onclick = () => {
    actions.deleteSelected();
    invalidate();
  };

  change($('cut-mode'), 'change', (e) => applyToSelection((it) => { it.cut.mode = e.target.value; }, 'cut mode'));
  bindItemLength($('cut-offset'), (it) => it.cut.offset, (it, v) => { it.cut.offset = clamp(v, -20, 50); }, 'cut offset');
  bindItemLength($('cut-radius'), (it) => it.cut.radius, (it, v) => { it.cut.radius = Math.max(0, v); }, 'corner radius');
  change($('cut-key'), 'change', (e) => applyToSelection((it) => { it.cut.key = e.target.value; }, 'cut key'));

  const outMap = {
    'cut-tolerance': 'cut-tol-out',
    'cut-smooth': 'cut-smooth-out',
    'cut-minarea': 'cut-minarea-out',
    'it-opacity': 'it-opacity-out',
  };

  const slider = (id, get, set, label, format) => {
    const input = $(id);
    const out = $(outMap[id]);
    change(input, 'input', () => {
      const v = parseFloat(input.value);
      out.textContent = format(v);
      applyToSelection((it) => set(it, v), label);
    });
    onRefresh(() => {
      const it = firstSelected();
      if (!it) return;
      input.value = get(it);
      out.textContent = format(get(it));
    });
  };

  slider('cut-tolerance', (it) => it.cut.tolerance, (it, v) => { it.cut.tolerance = v; }, 'tolerance', (v) => `${Math.round(v * 100)}%`);
  slider('cut-smooth', (it) => it.cut.smooth, (it, v) => { it.cut.smooth = v; }, 'smoothing', (v) => `${Math.round(v * 100)}%`);
  slider('cut-minarea', (it) => it.cut.minArea, (it, v) => { it.cut.minArea = v; }, 'min area', (v) => `${v.toFixed(2)}%`);
  slider('it-opacity', (it) => it.opacity, (it, v) => { it.opacity = v; }, 'opacity', (v) => `${Math.round(v * 100)}%`);

  $('cut-apply-all').onclick = () => {
    const src = firstSelected();
    if (!src) return;
    commit('apply cut settings');
    for (const it of doc.items) it.cut = { ...defaultCut(), ...structuredClone(src.cut) };
    notify('transform');
    invalidate();
    toast('Cut settings applied to every image', 'ok');
  };

  onRefresh(() => {
    const items = selectedItems();
    const it = items[0];
    $('selection-empty').hidden = !!it;
    $('selection-props').hidden = !it;
    if (!it) return;

    $('sel-title').textContent = items.length > 1 ? `${items.length} images selected` : it.name;
    $('it-lock-aspect').classList.toggle('on', lockAspect);
    if (document.activeElement !== $('it-rot')) $('it-rot').value = Math.round(it.rot * 10) / 10;

    const img = getImage(it.imageId);
    if (img && document.activeElement !== $('it-scale')) {
      $('it-scale').value = Math.round((it.w / naturalWidth(img)) * 1000) / 10;
    }

    const dpi = Math.round(actions.effectiveDpi(it));
    const quality = dpi >= 250 ? 'ok' : dpi >= 150 ? 'warn' : 'err';
    const label = { ok: 'good for print', warn: 'acceptable', err: 'too low for print' }[quality];
    $('it-dpi').innerHTML = img
      ? `Source <b>${img.width} × ${img.height} px</b> · printing at <b>${dpi} DPI</b> (${label})`
      : '';

    $('cut-mode').value = it.cut.mode;
    $('cut-key').value = it.cut.key;
    $('cut-radius-field').hidden = it.cut.mode !== 'box';
    $('contour-options').hidden = it.cut.mode !== 'contour';
    $('cut-apply-all-wrap').hidden = doc.items.length < 2;
  });
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function thumbFor(img) {
  if (img.thumb) return img.thumb;
  const size = 64;
  const s = Math.min(size / img.width, size / img.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  c.getContext('2d').drawImage(img.bitmap, 0, 0, c.width, c.height);
  img.thumb = c.toDataURL('image/png');
  return img.thumb;
}

const ICON = {
  eye: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5l11 11M6.2 6.3A2 2 0 0 0 8 10a2 2 0 0 0 1.8-1.1M4.2 4.6C2.6 5.7 1.5 8 1.5 8s2.4 4.2 6.5 4.2c1 0 1.9-.2 2.7-.6M12 10.4c1.6-1.1 2.5-2.4 2.5-2.4s-2.4-4.2-6.5-4.2c-.5 0-1 .1-1.5.2"/></svg>',
  lock: '<svg viewBox="0 0 16 16"><path d="M5 7V5a3 3 0 0 1 6 0v2M4 7h8v6H4z"/></svg>',
  unlock: '<svg viewBox="0 0 16 16"><path d="M5 7V5a3 3 0 0 1 5.7-1.8M4 7h8v6H4z"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
};

let dragId = null;

function wireLayers() {
  const list = $('layers');

  list.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const row = e.target.closest('li');
    for (const li of list.children) li.style.borderTopColor = 'transparent';
    if (row) row.style.borderTopColor = 'var(--accent)';
  });

  list.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const row = e.target.closest('li');
    for (const li of list.children) li.style.borderTopColor = '';
    if (!row || row.dataset.id === dragId) return;
    // The list is displayed top-of-stack first, so invert the index.
    const visualIndex = [...list.children].indexOf(row);
    commit('reorder');
    moveToIndex(dragId, doc.items.length - 1 - visualIndex);
    invalidate();
  });

  onRefresh(() => {
    $('layer-count').textContent = doc.items.length;
    const frag = document.createDocumentFragment();

    for (let i = doc.items.length - 1; i >= 0; i--) {
      const it = doc.items[i];
      const img = getImage(it.imageId);
      const li = document.createElement('li');
      li.dataset.id = it.id;
      li.draggable = true;
      li.className = selection.has(it.id) ? 'sel' : '';

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (img) thumb.style.backgroundImage = `url(${thumbFor(img)})`;
      li.append(thumb);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const cutLabel = { none: 'no cut', box: 'rect cut', contour: 'contour cut' }[it.cut.mode];
      meta.innerHTML =
        `<span class="name"></span>` +
        `<span class="sub">${fmt(it.w, doc.unit)} × ${fmt(it.h, doc.unit)} ${doc.unit} · ${cutLabel}</span>`;
      meta.querySelector('.name').textContent = it.name;
      li.append(meta);

      const visBtn = document.createElement('button');
      visBtn.className = `mini${it.visible ? '' : ' off'}`;
      visBtn.innerHTML = it.visible ? ICON.eye : ICON.eyeOff;
      visBtn.title = it.visible ? 'Hide' : 'Show';
      visBtn.onclick = (e) => {
        e.stopPropagation();
        commit('visibility');
        it.visible = !it.visible;
        notify('items');
        invalidate();
      };

      const lockBtn = document.createElement('button');
      lockBtn.className = `mini${it.locked ? '' : ' off'}`;
      lockBtn.innerHTML = it.locked ? ICON.lock : ICON.unlock;
      lockBtn.title = it.locked ? 'Unlock' : 'Lock';
      lockBtn.onclick = (e) => {
        e.stopPropagation();
        commit('lock');
        it.locked = !it.locked;
        if (it.locked) selection.delete(it.id);
        notify('items');
        invalidate();
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'mini';
      delBtn.innerHTML = ICON.trash;
      delBtn.title = 'Delete';
      delBtn.onclick = (e) => {
        e.stopPropagation();
        commit('delete');
        removeItems([it.id]);
        invalidate();
      };

      li.append(visBtn, lockBtn, delBtn);

      li.onclick = (e) => {
        setSelection([it.id], { toggle: e.shiftKey || e.metaKey || e.ctrlKey });
        invalidate();
      };
      li.ondragstart = () => {
        dragId = it.id;
      };
      li.ondragend = () => {
        dragId = null;
        for (const child of list.children) child.style.borderTopColor = '';
      };

      frag.append(li);
    }

    list.replaceChildren(frag);
  });
}

// ---------------------------------------------------------------------------
// Warnings + status
// ---------------------------------------------------------------------------

function refreshWarnings() {
  const list = $('warnings');
  const warnings = actions.layoutWarnings();
  $('warnings-group').hidden = warnings.length === 0;
  const frag = document.createDocumentFragment();
  for (const w of warnings.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = w.level === 'error' ? 'error' : '';
    li.textContent = w.text;
    li.onclick = () => {
      if (getItem(w.id)) {
        setSelection([w.id]);
        invalidate();
      }
    };
    frag.append(li);
  }
  list.replaceChildren(frag);
}

function refreshStatus() {
  const el = $('stage-status');
  const bits = [];
  const p = pageSize();
  bits.push(`${fmt(p.w, doc.unit)} × ${fmt(p.h, doc.unit)} ${doc.unit}`);
  if (doc.bleed > 0) bits.push(`bleed ${fmtWithUnit(doc.bleed, doc.unit)}`);
  bits.push(`${doc.items.length} image${doc.items.length === 1 ? '' : 's'}`);
  if (selection.size) bits.push(`${selection.size} selected`);
  const pending = pendingTraces();
  if (pending) bits.push(`tracing ${pending}…`);
  el.textContent = bits.join('  ·  ');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportOptions() {
  return {
    dpi: parseInt($('ex-dpi').value, 10),
    includeBleed: $('ex-bleed').checked,
    includeMarks: $('ex-marks').checked,
    includeCut: $('ex-cutlines').checked,
    background: $('ex-bg').value,
  };
}

function refreshExportSummary() {
  const o = exportOptions();
  const s = exporters.exportSummary(o);
  $('ex-summary').innerHTML =
    `Output <b>${s.px.w} × ${s.px.h} px</b> (${s.megapixels.toFixed(1)} MP)<br>` +
    `Sheet <b>${s.inches.w.toFixed(2)} × ${s.inches.h.toFixed(2)} in</b> · ${s.mm.w.toFixed(1)} × ${s.mm.h.toFixed(1)} mm`;
}

function openExport() {
  $('ex-dpi').value = String(doc.exportOpts.dpi);
  $('ex-bg').value = doc.exportOpts.background;
  refreshExportSummary();
  $('export-dialog').showModal();
}

async function runExport(fn, extension) {
  const dialog = $('export-dialog');
  const buttons = [...dialog.querySelectorAll('button')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const blob = await fn();
    exporters.download(blob, `${exporters.safeName(doc.name)}.${extension}`);
    toast(`Exported ${extension.toUpperCase()} — ${(blob.size / 1048576).toFixed(2)} MB`, 'ok');
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function wireExport() {
  for (const id of ['ex-dpi', 'ex-bleed', 'ex-marks', 'ex-cutlines', 'ex-bg']) {
    change($(id), 'change', () => {
      doc.exportOpts.dpi = parseInt($('ex-dpi').value, 10);
      doc.exportOpts.background = $('ex-bg').value;
      refreshExportSummary();
    });
  }

  const guard = (fn) => () => {
    if (!doc.items.length) {
      toast('Add some images first', 'error');
      return;
    }
    fn();
  };

  $('ex-png').onclick = guard(() => runExport(() => exporters.exportPng(exportOptions()), 'png'));
  $('ex-jpg').onclick = guard(() => runExport(() => exporters.exportJpeg({ ...exportOptions(), quality: doc.exportOpts.jpegQuality }), 'jpg'));
  $('ex-pdf').onclick = guard(() => runExport(() => {
    const o = exportOptions();
    return exporters.exportPdf({ ...o, includeCutPaths: o.includeCut });
  }, 'pdf'));
  $('ex-svg').onclick = guard(() => runExport(() => exporters.exportSvg({ ...exportOptions(), includeArt: true }), 'svg'));
  $('ex-svg-cut').onclick = guard(() => runExport(() => exporters.exportSvg({ ...exportOptions(), cutOnly: true }), 'cut.svg'));
  $('ex-dxf').onclick = guard(() => runExport(() => exporters.exportDxf(exportOptions()), 'dxf'));
}

export { openExport };

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

function wireDropZone() {
  const overlay = $('drop-overlay');
  let depth = 0;

  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    depth++;
    overlay.classList.add('on');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;

    // Drop position on the sheet, when the drop lands on the canvas.
    let at = null;
    const canvas = document.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      at = {
        x: (e.clientX - rect.left - view.tx) / view.scale,
        y: (e.clientY - rect.top - view.ty) / view.scale,
      };
    }
    await importFiles(files, at);
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export function sync() {
  if (suppressSync) return;
  suppressSync = true;
  try {
    for (const fn of refreshers) fn();
    const h = historyState();
    $('btn-undo').disabled = !h.canUndo;
    $('btn-redo').disabled = !h.canRedo;
    $('zoom-level').textContent = zoomPercent();
    $('empty-state').hidden = doc.items.length > 0 || images.size > 0;
    refreshWarnings();
    refreshStatus();
  } finally {
    suppressSync = false;
  }
}

/** Cheap sync during drags — skips list rebuilds. */
export function syncLight() {
  const it = firstSelected();
  if (it) {
    if (document.activeElement?.tagName !== 'INPUT') {
      const b = itemBounds(it);
      $('it-x').value = fmt(b.x, doc.unit);
      $('it-y').value = fmt(b.y, doc.unit);
      $('it-w').value = fmt(it.w, doc.unit);
      $('it-h').value = fmt(it.h, doc.unit);
      $('it-rot').value = Math.round(it.rot * 10) / 10;
    }
  }
  $('zoom-level').textContent = zoomPercent();
  refreshStatus();
}

/** 100% means one CSS pixel per CSS reference pixel at 96 dpi. */
function zoomPercent() {
  return `${Math.round((view.scale / (96 / MM_PER_IN)) * 100)}%`;
}
