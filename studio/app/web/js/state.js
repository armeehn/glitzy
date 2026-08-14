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
  layerSpec: { params: [], blends: [], max: 8 },  // layer schema from /api/ops

  proj: null,       // set by makeProj() below -- .chain is the ACTIVE layer's
  active: 0,        // index of the layer being edited
  view: 'composite', // 'composite' = the whole stack, 'layer' = solo the active one
  sel: -1,          // selected node index in the active layer's chain

  hashes: {},       // chain index -> cache hash, for the ACTIVE layer
  hashCache: {},    // layer id -> that layer's hashes, kept across switches
  layerOut: {},     // layer id -> hash of that layer's finished output
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

/* ------------------------------------------------------------------------ */
/* Layers                                                                    */
/*                                                                           */
/* A project is a stack of layers, bottom first, each holding its own chain.  */
/* `S.proj.chain` is an accessor onto the active layer's chain, which is why  */
/* the chain strip, the inspector and the variants panel needed no changes at */
/* all: from their side of the wall a project still has one chain, and which  */
/* one it is happens to be a setting.                                        */
/* ------------------------------------------------------------------------ */

const rid = () => Math.random().toString(16).slice(2, 10);

/** A layer's compositing defaults, taken from the engine's own schema. */
export function layerDefaults() {
  return Object.fromEntries((S.layerSpec.params || []).map((p) => [p.k, p.def]));
}

export function makeLayer(chain = [], props = {}) {
  return {
    id: rid(), name: 'Layer', off: false, solo: false,
    ...layerDefaults(), ...props, chain,
  };
}

/** Build the project object, giving it the live `chain` accessor. */
export function makeProj(doc = {}) {
  const raw = (Array.isArray(doc.layers) && doc.layers.length)
    ? doc.layers
    : [{ name: 'Base', chain: doc.chain || [] }];
  const proj = {
    id: doc.id || null,
    name: doc.name || 'untitled',
    layers: raw.map((l) => makeLayer(l.chain || [], { ...l, id: l.id || rid() })),
    tray: doc.tray || [],
  };
  Object.defineProperty(proj, 'chain', {
    // Not enumerable: the accessor must not turn up in JSON.stringify(proj)
    // and get saved as a second copy of the active layer's chain.
    enumerable: false,
    get() { return (proj.layers[S.active] || { chain: [] }).chain; },
    set(v) { if (proj.layers[S.active]) proj.layers[S.active].chain = v; },
  });
  return proj;
}

export function activeLayer() {
  return S.proj.layers[S.active] || null;
}

/** Park the current layer's node hashes so switching back keeps its thumbs. */
function stashHashes() {
  const l = activeLayer();
  if (l) S.hashCache[l.id] = S.hashes;
}

export function setActive(i) {
  if (i === S.active || !S.proj.layers[i]) return;
  stashHashes();
  S.active = i;
  S.hashes = S.hashCache[S.proj.layers[i].id] || {};
  S.sel = S.proj.layers[i].chain.length - 1;
  fire('layers');
}

export function addLayer(props = {}) {
  if (S.proj.layers.length >= (S.layerSpec.max || 8)) return -1;
  stashHashes();
  const n = S.proj.layers.length + 1;
  S.proj.layers.push(makeLayer([], { name: 'Layer ' + n, ...props }));
  S.active = S.proj.layers.length - 1;
  S.hashes = {};
  S.sel = -1;
  fire('layers');
  return S.active;
}

export function duplicateLayer(i) {
  const l = S.proj.layers[i];
  if (!l || S.proj.layers.length >= (S.layerSpec.max || 8)) return;
  stashHashes();
  // A deep copy of the params: two layers sharing a params object means
  // dragging a slider on one silently moves the other.
  const chain = l.chain.map((n) => ({ ...n, params: { ...n.params } }));
  S.proj.layers.splice(i + 1, 0, makeLayer(chain, { ...l, id: rid(), solo: false,
    name: l.name + ' copy' }));
  S.active = i + 1;
  S.hashes = {};
  fire('layers');
}

export function removeLayer(i) {
  if (S.proj.layers.length < 2) return;   // a project is at least one layer
  const [gone] = S.proj.layers.splice(i, 1);
  delete S.hashCache[gone.id];
  delete S.layerOut[gone.id];
  S.active = Math.min(S.active > i ? S.active - 1 : S.active,
                      S.proj.layers.length - 1);
  S.hashes = S.hashCache[activeLayer().id] || {};
  S.sel = activeLayer().chain.length - 1;
  fire('layers');
}

export function moveLayer(from, to) {
  const ls = S.proj.layers;
  if (to < 0 || to >= ls.length || from === to || !ls[from]) return;
  const active = ls[S.active];
  const [l] = ls.splice(from, 1);
  ls.splice(to, 0, l);
  S.active = ls.indexOf(active);
  fire('layers');
}

/** A compositing setting. Layer hashes survive: reordering or reblending the
 *  stack re-runs the composite, never the ops inside a layer.
 *
 *  Fires 'layerprop', not 'layers', for the same reason setParam has its own
 *  event: this runs once per pixel of a slider drag, and rebuilding the
 *  inspector under a slider takes the pointer capture away mid-drag. */
export function setLayerProp(i, k, v) {
  const l = S.proj.layers[i];
  if (!l || l[k] === v) return;
  l[k] = v;
  S.dirty = true;
  fire('layerprop', i);
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

// A project exists from the first line of script, so no panel has to guard
// against a null one; boot() replaces it once the engine's schemas are in.
S.proj = makeProj();

export function setParam(i, k, v) {
  const n = S.proj.chain[i];
  if (!n) return;
  n.params = { ...n.params, [k]: v };
  // Everything from here on is now wrong; keep the upstream thumbs.
  for (const key of Object.keys(S.hashes)) if (+key >= i) delete S.hashes[key];
  S.dirty = true;
  fire('params', i);
}
