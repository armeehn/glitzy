/* The leaving-Glitchsheet interstitial.
 *
 * The studio opens this page in a new tab the instant the button is clicked --
 * before the sheet exists -- because window.open() only escapes the popup
 * blocker while it is still inside the user gesture, and packing a sheet takes
 * seconds. So this page starts in its "packing" state and the studio navigates
 * it to ?id=... when the export lands. See tray.js openInCutsheet().
 *
 * The destination is NEVER taken from the query string: it comes from the
 * engine's own config (/api/health), so a crafted link into this page cannot
 * turn it into an open redirect. All the URL can say is *which sheet*, and
 * that is checked against the file-id shape before it is used.
 */

import { $ } from './dom.js';
import { jget } from './api.js';

const FILE_ID = /^[0-9a-f]{16}$/;

const q = new URLSearchParams(location.search);
const id = q.get('id') || '';
const errText = q.get('err') || '';

function setState(text, kind) {
  const s = $('#state');
  s.textContent = text;
  s.dataset.state = kind || '';
}

function fail(msg) {
  setState('Could not build the sheet', 'error');
  $('#lede').textContent = 'Nothing has been sent anywhere.';
  const box = $('#err');
  box.textContent = msg;
  box.hidden = false;
  $('#note').hidden = true;
  disable($('#go'));
}

/* The Continue control is an <a>, so "disabled" is a state we keep ourselves:
   no href (nothing to activate, and it drops out of the tab order the moment
   it has nothing to do) plus aria-disabled for anyone listening. */
function disable(a) {
  a.removeAttribute('href');
  a.setAttribute('aria-disabled', 'true');
}

async function main() {
  $('#stay').addEventListener('click', () => {
    // A tab this page opened itself can be closed; one restored from history
    // cannot, so fall back to the studio rather than appearing to do nothing.
    window.close();
    setTimeout(() => { location.href = '/'; }, 120);
  });

  if (errText) return fail(errText);
  if (!id) {
    // Still packing. The studio will navigate this tab when the file exists.
    return;
  }
  if (!FILE_ID.test(id)) return fail('That handoff link is malformed.');

  let health;
  try {
    health = await jget('/api/health');
  } catch {
    return fail('The Glitchsheet engine is not answering, so the destination '
      + 'could not be confirmed.');
  }

  const base = (health.cutsheet || '').replace(/\/+$/, '');
  if (!base) {
    return fail('This Glitchsheet has no Cutsheet configured '
      + '(GLITCHSHEET_CUTSHEET is unset), so there is nowhere to hand the '
      + 'sheet to. The file itself is fine — download it and open it in '
      + 'Cutsheet by hand.');
  }

  const name = q.get('name') || 'sheet.cutsheet.json';
  const count = +q.get('n') || 0;
  const size = +q.get('bytes') || 0;

  $('#f-name').textContent = name;
  $('#f-count').textContent = count
    ? `${count} sticker${count === 1 ? '' : 's'}`
    : '—';
  $('#f-bytes').textContent = size ? `${(size / 1024).toFixed(0)} kB` : '—';
  let host = base;
  try { host = new URL(base).host; } catch { /* show it raw */ }
  $('#f-dest').textContent = host;
  $('#facts').hidden = false;
  $('#note').hidden = false;

  const dl = $('#dl');
  dl.href = `/api/file/${id}?dl=1`;
  dl.setAttribute('download', name);
  dl.hidden = false;

  setState('Sheet ready', 'ready');
  $('#lede').textContent = 'The sheet is built and waiting. Continuing opens '
    + 'Cutsheet in this tab and loads it there automatically.';

  const go = $('#go');
  const dest = `${base}/#handoff=${id}`;
  go.href = dest;
  go.setAttribute('aria-disabled', 'false');
  go.focus();
  go.addEventListener('click', (e) => {
    // replace(), not the link's own navigation: going Back should land in the
    // studio, not on an interstitial that immediately forwards again. The href
    // stays real so the destination is visible and the link still works if
    // this handler never runs.
    e.preventDefault();
    setState('Opening Cutsheet', 'ready');
    location.replace(dest);
  });
}

main();
