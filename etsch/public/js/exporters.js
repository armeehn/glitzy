// Output: print raster (PNG/JPEG), print-ready PDF, cut SVG and DXF.
import { doc, pageSize, mediaRect, getImage } from './state.js';
import { itemCutPaths, pathToSvg, flushContours } from './cutpaths.js';
import { markPrimitives, marksToSvg } from './marks.js';
import { mmToPx, mmToPt, MM_PER_IN } from './units.js';

const CUT_COLOR = '#e6007e';

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeName(name) {
  const cleaned = String(name || '')
    .replace(/[^\w\-. ]+/g, '_')
    .replace(/^[_\s.]+|[_\s.]+$/g, '');
  return cleaned || 'sheet';
}

/** The exported area: the media box (trim + bleed) or just the trim box. */
export function exportArea(includeBleed) {
  return includeBleed ? mediaRect() : { x: 0, y: 0, ...pageSize() };
}

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

/**
 * Render the sheet to a canvas at the given DPI.
 * @returns {OffscreenCanvas}
 */
export function renderSheet({
  dpi = 300,
  includeBleed = true,
  includeMarks = true,
  includeCut = false,
  background = '#ffffff',
  transparent = false,
} = {}) {
  const area = exportArea(includeBleed);
  const w = Math.max(1, Math.round(mmToPx(area.w, dpi)));
  const h = Math.max(1, Math.round(mmToPx(area.h, dpi)));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const scale = w / area.w; // device px per mm

  if (!transparent) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }

  const project = (p) => ({ x: (p.x - area.x) * scale, y: (p.y - area.y) * scale });

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const item of doc.items) {
    if (!item.visible) continue;
    const img = getImage(item.imageId);
    if (!img || !img.bitmap) continue;
    const c = project({ x: item.cx, y: item.cy });
    ctx.save();
    ctx.globalAlpha = item.opacity;
    ctx.translate(c.x, c.y);
    ctx.rotate((item.rot * Math.PI) / 180);
    ctx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
    ctx.drawImage(img.bitmap, (-item.w / 2) * scale, (-item.h / 2) * scale, item.w * scale, item.h * scale);
    ctx.restore();
  }

  if (includeMarks) drawMarksTo(ctx, project, scale);

  if (includeCut) {
    ctx.save();
    ctx.strokeStyle = CUT_COLOR;
    ctx.lineWidth = Math.max(1, 0.25 * scale);
    ctx.beginPath();
    for (const item of doc.items) {
      for (const path of itemCutPaths(item)) {
        const s = project(path.start);
        ctx.moveTo(s.x, s.y);
        for (const seg of path.segs) {
          const c1 = project(seg.c1);
          const c2 = project(seg.c2);
          const p = project(seg.p);
          ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  return canvas;
}

function drawMarksTo(ctx, project, scale) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  for (const p of markPrimitives()) {
    if (p.type === 'line') {
      const a = project({ x: p.x1, y: p.y1 });
      const b = project({ x: p.x2, y: p.y2 });
      ctx.lineWidth = Math.max(1, p.weight * scale);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else if (p.type === 'rect') {
      const a = project({ x: p.x, y: p.y });
      ctx.fillRect(a.x, a.y, p.w * scale, p.h * scale);
    } else if (p.type === 'frame') {
      const a = project({ x: p.x, y: p.y });
      const t = p.thickness * scale;
      ctx.lineWidth = t;
      ctx.strokeRect(a.x + t / 2, a.y + t / 2, p.w * scale - t, p.h * scale - t);
    }
  }
  ctx.restore();
}

export async function exportPng(opts = {}) {
  await flushContours(doc.items);
  const canvas = renderSheet({ ...opts, transparent: opts.transparent });
  return canvas.convertToBlob({ type: 'image/png' });
}

export async function exportJpeg(opts = {}) {
  await flushContours(doc.items);
  const canvas = renderSheet({ ...opts, transparent: false });
  return canvas.convertToBlob({ type: 'image/jpeg', quality: opts.quality ?? 0.94 });
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

async function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

/**
 * Cut file. Real-world units: 1 SVG user unit = 1 mm, and the root width/height
 * carry the physical size so cutter software imports at the correct scale.
 */
export async function exportSvg({ includeArt = true, includeBleed = true, includeMarks = true, cutOnly = false } = {}) {
  await flushContours(doc.items);
  const area = exportArea(includeBleed);
  const f = (n) => Number(n.toFixed(3));
  const map = (p) => ({ x: p.x - area.x, y: p.y - area.y });

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${f(area.w)}mm" height="${f(area.h)}mm" ` +
    `viewBox="0 0 ${f(area.w)} ${f(area.h)}" version="1.1">`
  );
  parts.push(`<title>${escapeXml(doc.name)}</title>`);
  parts.push(
    `<desc>Cut sheet — page ${f(pageSize().w)}×${f(pageSize().h)} mm, bleed ${f(doc.bleed)} mm. ` +
    `Cut paths are on the CutContour layer.</desc>`
  );

  if (includeArt && !cutOnly) {
    parts.push(`<g inkscape:groupmode="layer" inkscape:label="Artwork" id="Artwork">`);
    for (const item of doc.items) {
      if (!item.visible) continue;
      const img = getImage(item.imageId);
      if (!img) continue;
      const href = img.dataUrl || (img.dataUrl = await blobToDataUrl(img.blob));
      const c = map({ x: item.cx, y: item.cy });
      const tf = [
        `translate(${f(c.x)} ${f(c.y)})`,
        item.rot ? `rotate(${f(item.rot)})` : '',
        item.flipH || item.flipV ? `scale(${item.flipH ? -1 : 1} ${item.flipV ? -1 : 1})` : '',
      ].filter(Boolean).join(' ');
      parts.push(
        `<image transform="${tf}" x="${f(-item.w / 2)}" y="${f(-item.h / 2)}" ` +
        `width="${f(item.w)}" height="${f(item.h)}" ` +
        `${item.opacity < 1 ? `opacity="${f(item.opacity)}" ` : ''}` +
        `preserveAspectRatio="none" xlink:href="${href}"/>`
      );
    }
    parts.push(`</g>`);
  }

  if (includeMarks && doc.marks.style !== 'none' && !cutOnly) {
    const offsetGroup = `translate(${f(-area.x)} ${f(-area.y)})`;
    parts.push(`<g inkscape:groupmode="layer" inkscape:label="RegMarks" id="RegMarks" transform="${offsetGroup}">`);
    parts.push(...marksToSvg());
    parts.push(`</g>`);
  }

  parts.push(`<g inkscape:groupmode="layer" inkscape:label="CutContour" id="CutContour" fill="none" stroke="${CUT_COLOR}" stroke-width="0.1">`);
  for (const item of doc.items) {
    const paths = itemCutPaths(item);
    if (!paths.length) continue;
    parts.push(`<g id="cut-${item.id}" data-name="${escapeXml(item.name)}">`);
    for (const p of paths) parts.push(`<path d="${pathToSvg(p, map)}"/>`);
    parts.push(`</g>`);
  }
  parts.push(`</g>`);
  parts.push(`</svg>`);

  return new Blob([parts.join('\n')], { type: 'image/svg+xml' });
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ---------------------------------------------------------------------------
// PDF (single page, embedded JPEG artwork + vector cut paths)
// ---------------------------------------------------------------------------

export async function exportPdf({ dpi = 300, includeBleed = true, includeMarks = true, includeCutPaths = true, quality = 0.94 } = {}) {
  await flushContours(doc.items);
  const area = exportArea(includeBleed);
  const canvas = renderSheet({ dpi, includeBleed, includeMarks, includeCut: false, transparent: false });
  const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());

  const pw = mmToPt(area.w);
  const ph = mmToPt(area.h);
  const toPt = (p) => ({ x: mmToPt(p.x - area.x), y: ph - mmToPt(p.y - area.y) });
  const n = (v) => Number(v.toFixed(3));

  let content = `q ${n(pw)} 0 0 ${n(ph)} 0 0 cm /Im0 Do Q\n`;

  if (includeCutPaths) {
    content += `q 0.902 0 0.494 RG 0.25 w 1 J 1 j\n`;
    for (const item of doc.items) {
      for (const path of itemCutPaths(item)) {
        const s = toPt(path.start);
        content += `${n(s.x)} ${n(s.y)} m\n`;
        for (const seg of path.segs) {
          const c1 = toPt(seg.c1);
          const c2 = toPt(seg.c2);
          const p = toPt(seg.p);
          content += `${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(p.x)} ${n(p.y)} c\n`;
        }
        content += `h S\n`;
      }
    }
    content += `Q\n`;
  }

  const enc = new TextEncoder();
  const contentBytes = enc.encode(content);
  const objects = [];
  const push = (parts) => objects.push(parts);

  push([enc.encode('<< /Type /Catalog /Pages 2 0 R >>')]);
  push([enc.encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')]);
  push([enc.encode(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pw)} ${n(ph)}] ` +
    `/TrimBox [${n(mmToPt(0 - area.x))} ${n(ph - mmToPt(pageSize().h - area.y))} ` +
    `${n(mmToPt(pageSize().w - area.x))} ${n(ph - mmToPt(0 - area.y))}] ` +
    `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`
  )]);
  push([enc.encode(`<< /Length ${contentBytes.length} >>\nstream\n`), contentBytes, enc.encode('\nendstream')]);
  push([
    enc.encode(
      `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    ),
    jpeg,
    enc.encode('\nendstream'),
  ]);

  const chunks = [];
  let offset = 0;
  const write = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  write(enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
  const offsets = [];
  objects.forEach((parts, i) => {
    offsets.push(offset);
    write(enc.encode(`${i + 1} 0 obj\n`));
    for (const p of parts) write(p);
    write(enc.encode('\nendobj\n'));
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  write(enc.encode(xref));

  return new Blob(chunks, { type: 'application/pdf' });
}

// ---------------------------------------------------------------------------
// DXF (polylines, millimetres) — accepted by most plotters and CAM software
// ---------------------------------------------------------------------------

function flattenBezier(p0, c1, c2, p1, tolerance = 0.12) {
  const approxLen = Math.hypot(c1.x - p0.x, c1.y - p0.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(p1.x - c2.x, p1.y - c2.y);
  const steps = Math.max(2, Math.min(32, Math.ceil(approxLen / Math.max(0.05, tolerance))));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p1.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p1.y,
    });
  }
  return pts;
}

export async function exportDxf({ includeBleed = true } = {}) {
  await flushContours(doc.items);
  const area = exportArea(includeBleed);
  // DXF is Y-up; flip so the sheet reads the same way as on screen.
  const map = (p) => ({ x: p.x - area.x, y: area.h - (p.y - area.y) });

  const lines = [];
  const pair = (code, value) => lines.push(String(code), String(value));

  pair(0, 'SECTION'); pair(2, 'HEADER');
  pair(9, '$INSUNITS'); pair(70, 4); // 4 = millimetres
  pair(9, '$EXTMIN'); pair(10, 0); pair(20, 0);
  pair(9, '$EXTMAX'); pair(10, area.w.toFixed(4)); pair(20, area.h.toFixed(4));
  pair(0, 'ENDSEC');

  pair(0, 'SECTION'); pair(2, 'ENTITIES');
  for (const item of doc.items) {
    for (const path of itemCutPaths(item)) {
      const pts = [map(path.start)];
      let cur = path.start;
      for (const seg of path.segs) {
        for (const p of flattenBezier(cur, seg.c1, seg.c2, seg.p)) pts.push(map(p));
        cur = seg.p;
      }
      pair(0, 'LWPOLYLINE');
      pair(8, 'CutContour');
      pair(100, 'AcDbEntity');
      pair(100, 'AcDbPolyline');
      pair(90, pts.length);
      pair(70, 1); // closed
      for (const p of pts) {
        pair(10, p.x.toFixed(4));
        pair(20, p.y.toFixed(4));
      }
    }
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return new Blob([lines.join('\n')], { type: 'application/dxf' });
}

// ---------------------------------------------------------------------------
// Summary shown in the export panel
// ---------------------------------------------------------------------------

export function exportSummary({ dpi, includeBleed }) {
  const area = exportArea(includeBleed);
  const px = { w: Math.round(mmToPx(area.w, dpi)), h: Math.round(mmToPx(area.h, dpi)) };
  return {
    mm: { w: area.w, h: area.h },
    inches: { w: area.w / MM_PER_IN, h: area.h / MM_PER_IN },
    px,
    megapixels: (px.w * px.h) / 1e6,
  };
}
