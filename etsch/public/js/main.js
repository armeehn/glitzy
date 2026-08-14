// Boot: wire the canvas, panels, keyboard and autosave together.
import { doc, subscribe, selection, setSelection, clearSelection, undo, redo, commit, notify } from './state.js';
import { attach, draw, invalidate, fitToView, handleViewportResize, onAfterDraw, view, zoomTo } from './render.js';
import { attachInteractions, isTyping } from './interact.js';
import { initUi, sync, syncLight, toast, saveProject, openExport, importFiles } from './ui.js';
import * as actions from './actions.js';
import * as project from './project.js';
import { MM_PER_IN } from './units.js';

const canvas = document.getElementById('canvas');

attach(canvas);
attachInteractions(canvas);
initUi();
onAfterDraw(syncLight);

// Live drags only refresh the numeric readouts; everything else does a full
// panel sync.
subscribe((reason) => {
  // Live drags redraw themselves; the readouts refresh from the draw hook.
  if (reason === 'transform-live') return;
  sync();
  invalidate();
  if (reason !== 'selection') project.scheduleAutosave();
});

// Resizes are rare, so redraw synchronously rather than waiting a frame —
// that keeps the sheet on screen instead of flashing an empty canvas.
const observer = new ResizeObserver(() => {
  handleViewportResize();
  draw();
});
observer.observe(document.getElementById('stage'));

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  const nudgeStep = e.shiftKey ? MM_PER_IN / 4 : doc.grid.snapGrid ? doc.grid.size : MM_PER_IN / 32;

  if (mod) {
    switch (e.key.toLowerCase()) {
      case 'z':
        e.preventDefault();
        if (e.shiftKey ? redo() : undo()) invalidate();
        return;
      case 'y':
        e.preventDefault();
        if (redo()) invalidate();
        return;
      case 'a':
        e.preventDefault();
        setSelection(doc.items.filter((it) => !it.locked).map((it) => it.id));
        invalidate();
        return;
      case 'd':
        e.preventDefault();
        actions.duplicateSelected();
        invalidate();
        return;
      case 's':
        e.preventDefault();
        saveProject();
        return;
      case 'e':
        e.preventDefault();
        openExport();
        return;
      case '0':
        e.preventDefault();
        fitToView();
        invalidate();
        return;
      case '=':
      case '+':
        e.preventDefault();
        zoomTo(view.scale * 1.25);
        invalidate();
        return;
      case '-':
        e.preventDefault();
        zoomTo(view.scale / 1.25);
        invalidate();
        return;
      default:
        return;
    }
  }

  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      if (selection.size) {
        e.preventDefault();
        actions.deleteSelected();
        invalidate();
      }
      break;
    case 'Escape':
      clearSelection();
      invalidate();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      actions.nudge(-nudgeStep, 0);
      break;
    case 'ArrowRight':
      e.preventDefault();
      actions.nudge(nudgeStep, 0);
      break;
    case 'ArrowUp':
      e.preventDefault();
      actions.nudge(0, -nudgeStep);
      break;
    case 'ArrowDown':
      e.preventDefault();
      actions.nudge(0, nudgeStep);
      break;
    case 'i':
    case 'I':
      e.preventDefault();
      document.getElementById('file-input').click();
      break;
    case '?':
      document.getElementById('help-dialog').showModal();
      break;
    default:
      break;
  }
});

// Paste images straight from the clipboard.
window.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  await importFiles(files);
});

// The sheet is restored from IndexedDB on the next visit, so no exit prompt.
window.addEventListener('pagehide', () => {
  if (doc.items.length) project.autosave();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  try {
    const restored = await project.restoreAutosave();
    if (restored) toast('Restored your last sheet', 'ok');
  } catch (err) {
    console.warn('restore failed', err);
  }
  fitToView();
  sync();
  draw();
})();

// Expose a small surface for debugging in the console.
window.cutsheet = { doc, actions, project, commit, notify, fitToView };
