/* Tiny DOM helpers. Deliberately not a framework: the studio's state is a
   plain object and the panels re-render themselves, which is less machinery
   than a dependency and leaves the modules readable on their own. */

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'hidden') n.hidden = !!v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
}

export const on = (node, ev, fn, opts) => node && node.addEventListener(ev, fn, opts);

/** Coalesce bursts of calls (a slider drag fires one event per pixel). */
export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.now = (...a) => { clearTimeout(t); fn(...a); };
  return wrapped;
}

export function fmt(n, d = 2) {
  return (+n).toFixed(d).replace(/\.?0+$/, '');
}

export function bytes(n) {
  if (!n) return '0';
  const u = ['B', 'kB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return fmt(n / 1024 ** i, 1) + ' ' + u[i];
}

let toastTimer = 0;
export function toast(msg, bad = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.dataset.bad = String(!!bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3600);
}
