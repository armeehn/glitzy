// Contour generation: turn artwork into a cuttable outline.
//
// Pipeline: rasterise the artwork into a padded working buffer -> build a
// binary mask (transparency key or background-colour key) -> grow the mask by
// the requested cut offset with an exact Euclidean distance transform ->
// discard specks -> trace each blob's boundary -> simplify -> smooth into
// cubic beziers. Output is in the item's local millimetre space, centred on
// the item, so it only needs the item's rotation/translation applied.

const INF = 1e20;

/** Squared Euclidean distance transform, Felzenszwalb & Huttenlocher. */
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Distance (in pixels) from every cell to the nearest cell where seed[i] is
 * truthy. Returns a Float64Array of true distances.
 */
export function distanceTransform(seed, w, h) {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = seed[i] ? 0 : INF;

  const maxDim = Math.max(w, h);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[row + x] = Math.sqrt(d[x]);
  }
  return grid;
}

/**
 * Median of the four corner samples, used to auto-detect a flat background.
 * `region` confines sampling to the artwork so a transparent padding ring
 * is never mistaken for the background colour.
 */
function sampleBackground(data, w, region) {
  const pick = [];
  const probe = (x, y) => {
    const i = (y * w + x) * 4;
    pick.push([data[i], data[i + 1], data[i + 2]]);
  };
  const m = 2;
  const x0 = region.x + m;
  const y0 = region.y + m;
  const x1 = region.x + region.w - 1 - m;
  const y1 = region.y + region.h - 1 - m;
  probe(x0, y0);
  probe(x1, y0);
  probe(x0, y1);
  probe(x1, y1);
  const chan = (k) => {
    const vals = pick.map((p) => p[k]).sort((a, b) => a - b);
    return (vals[1] + vals[2]) / 2;
  };
  return [chan(0), chan(1), chan(2)];
}

/**
 * Build the foreground mask for the working buffer.
 * @param {{x:number,y:number,w:number,h:number}} [region] artwork area within
 *   the buffer; defaults to the whole buffer.
 */
export function buildMask(imageData, mode, tolerance, region) {
  const { data, width: w, height: h } = imageData;
  const mask = new Uint8Array(w * h);
  const tol = Math.max(0.002, tolerance);

  if (mode === 'alpha') {
    const t = tol * 255;
    for (let i = 0, p = 3; i < mask.length; i++, p += 4) mask[i] = data[p] > t ? 1 : 0;
    return mask;
  }

  // Background-colour key: anything within `tolerance` of the sampled
  // background (and not already transparent) becomes background.
  const bg = sampleBackground(data, w, region || { x: 0, y: 0, w, h });
  const t = tol * 441.673; // tolerance as a fraction of max RGB distance
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (data[p + 3] < 8) {
      mask[i] = 0;
      continue;
    }
    const dr = data[p] - bg[0];
    const dg = data[p + 1] - bg[1];
    const db = data[p + 2] - bg[2];
    mask[i] = Math.sqrt(dr * dr + dg * dg + db * db) > t ? 1 : 0;
  }
  return mask;
}

/** Grow (offset > 0) or shrink (offset < 0) a mask by a pixel radius. */
export function offsetMask(mask, w, h, radiusPx) {
  if (Math.abs(radiusPx) < 0.5) return mask;
  const out = new Uint8Array(w * h);
  if (radiusPx > 0) {
    const dist = distanceTransform(mask, w, h);
    for (let i = 0; i < out.length; i++) out[i] = dist[i] <= radiusPx ? 1 : 0;
  } else {
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
    const dist = distanceTransform(inv, w, h);
    for (let i = 0; i < out.length; i++) out[i] = dist[i] > -radiusPx ? 1 : 0;
  }
  return out;
}

/** 8-connected labelling; returns { labels, blobs:[{label, area, seedX, seedY}] }. */
export function labelBlobs(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const blobs = [];
  const stack = [];
  const nx = [1, -1, 0, 0, 1, 1, -1, -1];
  const ny = [0, 0, 1, -1, 1, -1, 1, -1];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i] || labels[i] !== -1) continue;
      const label = blobs.length;
      let area = 0;
      let seedX = x;
      let seedY = y;
      stack.push(i);
      labels[i] = label;
      while (stack.length) {
        const p = stack.pop();
        const px = p % w;
        const py = (p / w) | 0;
        area++;
        if (py < seedY || (py === seedY && px < seedX)) {
          seedX = px;
          seedY = py;
        }
        for (let k = 0; k < 8; k++) {
          const qx = px + nx[k];
          const qy = py + ny[k];
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const q = qy * w + qx;
          if (mask[q] && labels[q] === -1) {
            labels[q] = label;
            stack.push(q);
          }
        }
      }
      blobs.push({ label, area, seedX, seedY });
    }
  }
  return { labels, blobs };
}

/** Moore-neighbour boundary trace of one labelled blob. */
export function traceBlob(labels, w, h, blob) {
  const inBlob = (x, y) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === blob.label;
  // Clockwise neighbourhood starting east.
  const dirs = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];

  const startX = blob.seedX;
  const startY = blob.seedY;
  const contour = [{ x: startX, y: startY }];

  let cx = startX;
  let cy = startY;
  // `dir` is the index pointing back at the pixel we arrived from. The seed is
  // the top-left-most pixel of the blob, so north is guaranteed to be outside.
  let dir = 6;

  // Jacob's stopping criterion: the walk is closed once we re-enter a pixel
  // from the same direction as the first time. Recording that state for the
  // step *after* the seed handles blobs whose boundary passes through the seed
  // more than once (thin necks, spiral shapes).
  let firstX = -1;
  let firstY = -1;
  let firstDir = -1;

  // A Moore walk visits each boundary pixel at most once per entry direction,
  // so this bound can only be hit by a genuinely degenerate mask.
  const limit = 8 * blob.area + 64;

  for (let steps = 0; steps < limit; steps++) {
    let found = false;
    // Sweep clockwise starting one step past the backtrack direction.
    for (let k = 1; k <= 8; k++) {
      const d = (dir + k) % 8;
      const nxp = cx + dirs[d][0];
      const nyp = cy + dirs[d][1];
      if (inBlob(nxp, nyp)) {
        cx = nxp;
        cy = nyp;
        dir = (d + 4) % 8;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel

    if (firstX < 0) {
      firstX = cx;
      firstY = cy;
      firstDir = dir;
    } else if (cx === firstX && cy === firstY && dir === firstDir) {
      break;
    }
    contour.push({ x: cx, y: cy });
  }

  // The walk closes back onto the seed; keep the ring implicit so the first
  // and last points are never identical.
  const last = contour[contour.length - 1];
  if (contour.length > 2 && last.x === startX && last.y === startY) contour.pop();
  return contour;
}

/** Ramer-Douglas-Peucker on an open polyline. */
export function simplify(points, epsilon) {
  if (points.length < 3) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const pa = points[a];
    const pb = points[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    // When the two anchors coincide, perpendicular distance is undefined —
    // fall back to radial distance so the span cannot collapse to nothing.
    const degenerate = len < 1e-9;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const d = degenerate
        ? Math.hypot(p.x - pa.x, p.y - pa.y)
        : Math.abs((p.x - pa.x) * dy - (p.y - pa.y) * dx) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * RDP for a closed ring. The ring is split at the point farthest from the
 * start so each half is a well-conditioned open chain — running RDP straight
 * across a ring would measure every point against a near-zero-length baseline
 * and throw the whole outline away.
 */
export function simplifyClosed(points, epsilon) {
  const n = points.length;
  if (n < 5) return points.slice();

  let split = 1;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - points[0].x;
    const dy = points[i].y - points[0].y;
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      split = i;
    }
  }

  // The shared split point is dropped from the head so it appears once.
  const head = simplify(points.slice(0, split + 1), epsilon);
  const tail = simplify(points.slice(split), epsilon);
  return head.slice(0, -1).concat(tail);
}

/**
 * Closed Catmull-Rom -> cubic bezier. `smooth` of 0 keeps hard corners,
 * 1 gives a fully rounded path.
 */
export function toBezier(points, smooth) {
  const n = points.length;
  const segs = [];
  if (n < 3) return segs;
  const k = smooth / 6;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    segs.push({
      c1: { x: p1.x + (p2.x - p0.x) * k, y: p1.y + (p2.y - p0.y) * k },
      c2: { x: p2.x - (p3.x - p1.x) * k, y: p2.y - (p3.y - p1.y) * k },
      p: { x: p2.x, y: p2.y },
    });
  }
  return segs;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(a / 2);
}

const WORK_MAX = 560; // longest working-buffer edge, before padding

/**
 * Trace an item's cut contour.
 * @returns {{paths: Array, boxW:number, boxH:number}} local-mm geometry.
 */
export function traceContour(bitmap, item) {
  const cut = item.cut;
  const boxW = item.w;
  const boxH = item.h;

  // Square working pixels: the artwork is drawn stretched into the item box,
  // so pixels-per-mm must be identical on both axes for the offset to be even.
  const longest = Math.max(boxW, boxH);
  const pxPerMm = WORK_MAX / longest;
  const iw = Math.max(8, Math.round(boxW * pxPerMm));
  const ih = Math.max(8, Math.round(boxH * pxPerMm));

  const offsetPx = cut.offset * pxPerMm;
  const pad = Math.ceil(Math.max(2, Math.abs(offsetPx) + 3));
  const w = iw + pad * 2;
  const h = ih + pad * 2;

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(pad + iw / 2, pad + ih / 2);
  ctx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
  ctx.drawImage(bitmap, -iw / 2, -ih / 2, iw, ih);
  ctx.restore();

  const imageData = ctx.getImageData(0, 0, w, h);

  const fallback = () => ({
    paths: [rectPath(boxW, boxH, cut.offset, cut.radius)],
    boxW,
    boxH,
    degenerate: true,
  });

  let mode = cut.key;
  if (mode === 'auto') mode = hasTransparency(imageData) ? 'alpha' : 'bg';
  let mask = buildMask(imageData, mode, cut.tolerance, { x: pad, y: pad, w: iw, h: ih });

  // The padding ring must stay background so blobs never touch the border.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) mask[y * w + x] = 0;
    }
  }

  let foreground = 0;
  for (let i = 0; i < mask.length; i++) foreground += mask[i];
  // Nothing was keyed out — fall back to the full artwork rectangle.
  if (foreground < 4) return fallback();

  // Drop specks *before* offsetting: a 3 mm offset would otherwise inflate a
  // stray pixel into a blob large enough to survive the size filter.
  const minArea = (cut.minArea / 100) * iw * ih;
  const raw = labelBlobs(mask, w, h);
  if (!raw.blobs.length) return fallback();

  const survivors = raw.blobs.filter((b) => b.area >= minArea);
  const keepLabels = new Set(
    (survivors.length ? survivors : [raw.blobs.reduce((a, b) => (b.area > a.area ? b : a))]).map((b) => b.label)
  );
  if (keepLabels.size !== raw.blobs.length) {
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && !keepLabels.has(raw.labels[i])) mask[i] = 0;
    }
  }

  mask = offsetMask(mask, w, h, offsetPx);

  const { labels, blobs } = labelBlobs(mask, w, h);
  if (!blobs.length) return fallback();

  const epsilon = Math.max(0.5, 0.0016 * WORK_MAX);
  const paths = [];
  for (const blob of blobs) {
    let pts = traceBlob(labels, w, h, blob);
    if (pts.length < 8) continue;
    pts = simplifyClosed(pts, epsilon);
    // Specks are already gone; this only rejects rings too thin to cut.
    if (pts.length < 3 || polygonArea(pts) < 4) continue;
    // Pixel space -> local millimetres, centred on the item.
    const local = pts.map((p) => ({
      x: ((p.x - pad + 0.5) / iw) * boxW - boxW / 2,
      y: ((p.y - pad + 0.5) / ih) * boxH - boxH / 2,
    }));
    paths.push({ start: local[0], segs: toBezier(local, cut.smooth) });
  }

  if (!paths.length) return fallback();
  return { paths, boxW, boxH, degenerate: false };
}

function hasTransparency(imageData) {
  const { data } = imageData;
  for (let p = 3; p < data.length; p += 4 * 7) {
    if (data[p] < 250) return true;
  }
  return false;
}

/** Rounded rectangle as a bezier path in local-mm space. */
export function rectPath(w, h, offset, radius) {
  const hw = w / 2 + offset;
  const hh = h / 2 + offset;
  const r = Math.max(0, Math.min(radius, Math.min(hw, hh)));
  const k = 0.5522847498 * r;

  if (r <= 0.0001) {
    const pts = [
      { x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh },
    ];
    return { start: pts[0], segs: pts.map((_, i) => {
      const p = pts[(i + 1) % 4];
      const a = pts[i];
      return { c1: { x: a.x + (p.x - a.x) / 3, y: a.y + (p.y - a.y) / 3 },
               c2: { x: a.x + (2 * (p.x - a.x)) / 3, y: a.y + (2 * (p.y - a.y)) / 3 },
               p };
    }) };
  }

  const segs = [];
  const line = (from, to) => segs.push({
    c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
    c2: { x: from.x + (2 * (to.x - from.x)) / 3, y: from.y + (2 * (to.y - from.y)) / 3 },
    p: to,
  });

  const start = { x: -hw + r, y: -hh };
  let cur = start;
  const p1 = { x: hw - r, y: -hh };
  line(cur, p1); cur = p1;
  segs.push({ c1: { x: hw - r + k, y: -hh }, c2: { x: hw, y: -hh + r - k }, p: { x: hw, y: -hh + r } });
  cur = { x: hw, y: -hh + r };
  const p2 = { x: hw, y: hh - r };
  line(cur, p2); cur = p2;
  segs.push({ c1: { x: hw, y: hh - r + k }, c2: { x: hw - r + k, y: hh }, p: { x: hw - r, y: hh } });
  cur = { x: hw - r, y: hh };
  const p3 = { x: -hw + r, y: hh };
  line(cur, p3); cur = p3;
  segs.push({ c1: { x: -hw + r - k, y: hh }, c2: { x: -hw, y: hh - r + k }, p: { x: -hw, y: hh - r } });
  cur = { x: -hw, y: hh - r };
  const p4 = { x: -hw, y: -hh + r };
  line(cur, p4); cur = p4;
  segs.push({ c1: { x: -hw, y: -hh + r - k }, c2: { x: -hw + r - k, y: -hh }, p: start });

  return { start, segs };
}
