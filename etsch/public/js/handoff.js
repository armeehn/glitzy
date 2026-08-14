// Accept a sheet handed over by another app on the same deployment.
//
// A companion app (Glitzy) builds a `etsch/1` project server-side and
// sends the browser here with `#handoff=<file id>`. We fetch that one sheet
// from a fixed same-origin path and open it with the ordinary project loader.
//
// Two constraints shape all of this:
//
//   The URL carries an ID, never a URL. `connect-src 'self'` would refuse a
//   cross-origin fetch anyway, but the real reason is that a page which
//   fetches whatever its own fragment names is a redirector for anyone who can
//   get a link in front of you. The deployment decides where /handoff/ points;
//   the link only picks which sheet.
//
//   Nothing here may break the plain static deployment. Cloudflare has no
//   /handoff/ route, so the fetch 404s and this reports a miss and leaves the
//   sheet you already had alone.

import { loadProjectFile } from './project.js';

const FILE_ID = /^[0-9a-f]{16}$/;

/* Both readers take the fragment rather than reaching for `location`: this
   module stays pure so it can be tested without a window, and main.js is the
   one place that knows it is running in a browser. */

/** The file id in a URL fragment, or null. */
export function pendingHandoff(hash) {
  const m = /(?:^|[#&])handoff=([^&]*)/.exec(hash || '');
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return FILE_ID.test(id) ? id : null;
}

/** Drop the handoff out of a fragment, keeping the rest of it. */
export function stripHandoff(hash) {
  const rest = (hash || '').replace(/^#/, '')
    .split('&')
    .filter((part) => part && !/^handoff=/.test(part))
    .join('&');
  return rest ? '#' + rest : '';
}

/**
 * Fetch the handed-over sheet and open it.
 *
 * Throws with a message worth showing in a toast. The caller decides what to
 * do about the sheet already on screen — this only replaces it on success,
 * because loadProjectFile validates the payload before it touches the doc.
 */
export async function importHandoff(id, fetchImpl = (...a) => fetch(...a)) {
  if (!FILE_ID.test(id)) throw new Error('That handoff link is malformed.');
  let res;
  try {
    res = await fetchImpl(`/handoff/${id}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new Error('Could not reach the app that sent this sheet.');
  }
  if (res.status === 404) {
    throw new Error('That sheet is no longer available, or this Etsch is not '
      + 'the one it was sent to.');
  }
  if (!res.ok) throw new Error(`The sheet could not be fetched (HTTP ${res.status}).`);

  const text = await res.text();
  // A forward-auth gate answers an expired session with a login page and a
  // 200, so a JSON parse error here is far more likely to be HTML than a
  // corrupt sheet. Say so, rather than "not a Etsch project".
  if (/^\s*</.test(text)) {
    throw new Error('The sheet came back as a web page, not a project — your '
      + 'session may have expired. Reload and try again.');
  }
  await loadProjectFile({ text: async () => text });
  return text.length;
}
