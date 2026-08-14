// Registration and crop marks, emitted as page-space primitives so the
// on-screen renderer and every exporter draw exactly the same geometry.
import { doc, pageSize } from './state.js';
import { MM_PER_IN } from './units.js';

export const MARK_STYLES = [
  { id: 'none', label: 'None' },
  { id: 'crop', label: 'Crop marks (trim corners)' },
  { id: 'squares', label: 'Corner squares' },
  { id: 'silhouette', label: 'Silhouette — square + L brackets' },
  { id: 'cricut', label: 'Cricut — sensor border' },
];

const line = (x1, y1, x2, y2, weight) => ({ type: 'line', x1, y1, x2, y2, weight });
const rect = (x, y, w, h) => ({ type: 'rect', x, y, w, h });

/**
 * @returns {Array} primitives: {type:'line'|'rect'|'frame', ...} in millimetres
 * relative to the trim origin.
 */
export function markPrimitives() {
  const m = doc.marks;
  if (!m || m.style === 'none') return [];
  const { w, h } = pageSize();
  const bleed = doc.bleed;
  const weight = Math.max(0.05, m.weight);

  switch (m.style) {
    case 'crop': {
      const out = [];
      // Crop marks belong in the bleed band, but a typical 1/8 in bleed cannot
      // hold a legible mark. When there is not enough room for most of the
      // requested length, draw them just inside the trim instead, where they
      // still guide a hand trim.
      const gapInBleed = Math.min(m.offset, Math.max(0, bleed * 0.45));
      const inBleed = bleed - gapInBleed >= Math.max(2, m.size * 0.6);
      const gap = inBleed ? gapInBleed : Math.min(m.offset, 3);
      const len = inBleed ? Math.min(m.size, bleed - gap) : Math.max(2, m.size);
      const s = inBleed ? 1 : -1; // direction: outward into bleed, or inward

      for (const [x, sx] of [[0, 1], [w, -1]]) {
        for (const [y, sy] of [[0, 1], [h, -1]]) {
          const ox = -sx * s;
          const oy = -sy * s;
          out.push(line(x + ox * gap, y, x + ox * (gap + len), y, weight));
          out.push(line(x, y + oy * gap, x, y + oy * (gap + len), weight));
        }
      }
      return out;
    }

    case 'squares': {
      const size = Math.max(2, m.size);
      const off = m.offset;
      return [
        rect(off, off, size, size),
        rect(w - off - size, off, size, size),
        rect(off, h - off - size, size, size),
        rect(w - off - size, h - off - size, size, size),
      ];
    }

    case 'silhouette': {
      // Silhouette Studio: 5 mm filled square top-left, 20 mm L brackets at
      // top-right and bottom-left, all inset from the page edge.
      const inset = Math.max(m.offset, MM_PER_IN * 0.25);
      const sq = 5;
      const arm = 20;
      const thick = Math.max(1, weight * 4);
      return [
        rect(inset, inset, sq, sq),
        // top-right bracket
        rect(w - inset - arm, inset, arm, thick),
        rect(w - inset - thick, inset, thick, arm),
        // bottom-left bracket
        rect(inset, h - inset - thick, arm, thick),
        rect(inset, h - inset - arm, thick, arm),
      ];
    }

    case 'cricut': {
      // Cricut Print Then Cut scans a solid rectangular border.
      const inset = Math.max(m.offset, MM_PER_IN * 0.17);
      const thick = Math.max(1.2, weight * 5);
      return [{ type: 'frame', x: inset, y: inset, w: w - inset * 2, h: h - inset * 2, thickness: thick }];
    }

    default:
      return [];
  }
}

/**
 * Areas artwork should stay clear of so the machine can read its marks.
 * Used by auto-arrange and the layout warnings.
 */
export function markKeepOut() {
  const m = doc.marks;
  if (!m || m.style === 'none' || m.style === 'crop') return [];
  const { w, h } = pageSize();
  const prims = markPrimitives();
  const pad = 2;
  const boxes = [];
  for (const p of prims) {
    if (p.type === 'rect') boxes.push({ x: p.x - pad, y: p.y - pad, w: p.w + pad * 2, h: p.h + pad * 2 });
    if (p.type === 'frame') {
      boxes.push({ x: 0, y: 0, w, h: p.y + p.thickness + pad });
      boxes.push({ x: 0, y: p.y + p.h - p.thickness - pad, w, h: h - (p.y + p.h) + p.thickness + pad * 2 });
      boxes.push({ x: 0, y: 0, w: p.x + p.thickness + pad, h });
      boxes.push({ x: p.x + p.w - p.thickness - pad, y: 0, w: w - (p.x + p.w) + p.thickness + pad * 2, h });
    }
  }
  return boxes;
}

/** Draw marks with a projection from page mm to device pixels. */
export function drawMarks(ctx, project, scale, color = '#000') {
  const prims = markPrimitives();
  if (!prims.length) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (const p of prims) {
    if (p.type === 'line') {
      const a = project({ x: p.x1, y: p.y1 });
      const b = project({ x: p.x2, y: p.y2 });
      ctx.lineWidth = Math.max(0.75, p.weight * scale);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else if (p.type === 'rect') {
      const a = project({ x: p.x, y: p.y });
      ctx.fillRect(a.x, a.y, p.w * scale, p.h * scale);
    } else if (p.type === 'frame') {
      const a = project({ x: p.x, y: p.y });
      ctx.lineWidth = p.thickness * scale;
      ctx.strokeRect(a.x + (p.thickness * scale) / 2, a.y + (p.thickness * scale) / 2, p.w * scale - p.thickness * scale, p.h * scale - p.thickness * scale);
    }
  }
  ctx.restore();
}

/** Marks as SVG element strings, given a mm->user-unit mapping (identity). */
export function marksToSvg() {
  const prims = markPrimitives();
  const f = (n) => Number(n.toFixed(3));
  return prims.map((p) => {
    if (p.type === 'line') {
      return `<line x1="${f(p.x1)}" y1="${f(p.y1)}" x2="${f(p.x2)}" y2="${f(p.y2)}" stroke="#000" stroke-width="${f(p.weight)}"/>`;
    }
    if (p.type === 'rect') {
      return `<rect x="${f(p.x)}" y="${f(p.y)}" width="${f(p.w)}" height="${f(p.h)}" fill="#000"/>`;
    }
    return `<rect x="${f(p.x + p.thickness / 2)}" y="${f(p.y + p.thickness / 2)}" width="${f(p.w - p.thickness)}" height="${f(p.h - p.thickness)}" fill="none" stroke="#000" stroke-width="${f(p.thickness)}"/>`;
  });
}
