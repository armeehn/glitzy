/* The studio's state, and a two-line event bus.
 *
 * One mutable object plus explicit fire() calls. Panels subscribe to what they
 * care about and re-render themselves; there is no diffing and no reactivity
 * to debug, which for a nine-panel studio is less machinery, not more.
 */

export const S = {
  ops: [],          // op schemas from /api/ops
  byId: {},         // op id -> schema
  cats: [],
  sources: [],

  proj: { id: null, name: 'untitled', chain: [], tray: [] },
  sel: -1,          // selected node index in the chain

  hashes: {},       // chain index -> cache hash of that node's output
  meta: null,       // meta of the node currently on screen
  notes: [],

  frame: 0,
  playing: false,
  zoom: 1,          // viewer zoom, as a multiple of "fits the stage"
  fast: true,       // shrink the source while scrubbing params
  busy: false,
  dirty: false,     // chain differs from what is on screen

  sticker: { mm: 76, dpi: 300, machine: 'generic' },
};

const subs = new Map();

export function on(ev, fn) {
  if (!subs.has(ev)) subs.set(ev, new Set());
  subs.get(ev).add(fn);
  return () => subs.get(ev).delete(fn);
}

export function fire(ev, data) {
  for (const fn of subs.get(ev) || []) {
    try { fn(data); } catch (e) { console.error('[' + ev + ']', e); }
  }
}

/** Default params for an op, straight from its schema. */
export function defaults(opId) {
  const spec = S.byId[opId];
  if (!spec) return {};
  return Object.fromEntries(spec.params.map((p) => [p.k, p.def]));
}

export function node(i) {
  return S.proj.chain[i] || null;
}

export function selNode() {
  return node(S.sel);
}

/** The hash of the last node that actually has a result. */
export function currentHash() {
  return S.hashes[S.sel] ?? null;
}

export function setChain(chain, { select = null } = {}) {
  S.proj.chain = chain;
  S.hashes = {};
  S.sel = select === null ? chain.length - 1 : select;
  fire('chain');
}

/** Insert an op after the selection -- where you were looking is where it goes. */
export function addOp(opId, params = null) {
  const spec = S.byId[opId];
  if (!spec) return -1;
  const n = { op: opId, params: params || defaults(opId), off: false };
  // A source has to lead, so it goes to the front no matter what is selected.
  const at = spec.domain === 'source' ? 0 : (S.sel < 0 ? S.proj.chain.length : S.sel + 1);
  S.proj.chain.splice(at, 0, n);
  S.hashes = shiftHashes(S.hashes, at, +1);
  S.sel = at;
  fire('chain');
  return at;
}

export function removeNode(i) {
  S.proj.chain.splice(i, 1);
  S.hashes = shiftHashes(S.hashes, i, -1);
  if (S.sel >= S.proj.chain.length) S.sel = S.proj.chain.length - 1;
  fire('chain');
}

export function moveNode(from, to) {
  const chain = S.proj.chain;
  if (to < 0 || to >= chain.length || from === to) return;
  const [n] = chain.splice(from, 1);
  chain.splice(to, 0, n);
  // Reordering changes every downstream hash, so drop them all rather than
  // leave a thumbnail that belongs to a chain that no longer exists.
  S.hashes = {};
  S.sel = to;
  fire('chain');
}

/** Hashes are keyed by index, so an insert or delete has to slide them. */
function shiftHashes(h, at, dir) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const i = +k;
    if (i < at) out[i] = v;
    else if (dir > 0) out[i + 1] = v;
    else if (i > at) out[i - 1] = v;
  }
  return out;
}

export function setParam(i, k, v) {
  const n = S.proj.chain[i];
  if (!n) return;
  n.params = { ...n.params, [k]: v };
  // Everything from here on is now wrong; keep the upstream thumbs.
  for (const key of Object.keys(S.hashes)) if (+key >= i) delete S.hashes[key];
  S.dirty = true;
  fire('params', i);
}
