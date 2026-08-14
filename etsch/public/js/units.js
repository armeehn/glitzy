// All internal geometry is stored in millimetres. This module converts to and
// from whatever unit the user is currently working in.

export const MM_PER_IN = 25.4;
export const PT_PER_IN = 72;

export const UNITS = {
  in: { label: 'in', perMm: 1 / MM_PER_IN, step: 0.05, digits: 3 },
  mm: { label: 'mm', perMm: 1, step: 1, digits: 2 },
  cm: { label: 'cm', perMm: 0.1, step: 0.1, digits: 3 },
  pt: { label: 'pt', perMm: PT_PER_IN / MM_PER_IN, step: 1, digits: 1 },
};

export function toMm(value, unit) {
  return value / UNITS[unit].perMm;
}

export function fromMm(mm, unit) {
  return mm * UNITS[unit].perMm;
}

export function mmToPx(mm, dpi) {
  return (mm / MM_PER_IN) * dpi;
}

export function mmToPt(mm) {
  return (mm / MM_PER_IN) * PT_PER_IN;
}

/** Round-trip safe display string, trailing zeros stripped. */
export function fmt(mm, unit) {
  const u = UNITS[unit];
  const v = fromMm(mm, unit);
  const s = v.toFixed(u.digits);
  return s.replace(/\.?0+$/, '') || '0';
}

export function fmtWithUnit(mm, unit) {
  return `${fmt(mm, unit)}${unit}`;
}

const FRACTION = /^\s*(-?\d*)\s+(\d+)\s*\/\s*(\d+)\s*$/;
const SIMPLE_FRACTION = /^\s*(-?\d+)\s*\/\s*(\d+)\s*$/;

/**
 * Parse user input into millimetres. Accepts a bare number in the current
 * unit, an explicit suffix ("3mm", "0.125in", "1cm"), or imperial fractions
 * ("1/8", "8 1/2") which are common on cut sheets.
 * Returns null when the input cannot be understood.
 */
export function parseLength(input, unit) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  let u = unit;
  const suffix = s.match(/(mm|cm|in|inch|inches|"|pt)\s*$/);
  if (suffix) {
    const tag = suffix[1];
    u = tag === 'inch' || tag === 'inches' || tag === '"' ? 'in' : tag;
    s = s.slice(0, suffix.index).trim();
  }

  let value = NaN;
  const mixed = s.match(FRACTION);
  const frac = s.match(SIMPLE_FRACTION);
  if (mixed) {
    const whole = mixed[1] === '' || mixed[1] === '-' ? 0 : parseFloat(mixed[1]);
    const sign = mixed[1].startsWith('-') ? -1 : 1;
    value = whole + sign * (parseFloat(mixed[2]) / parseFloat(mixed[3]));
  } else if (frac) {
    value = parseFloat(frac[1]) / parseFloat(frac[2]);
  } else {
    value = parseFloat(s);
  }

  if (!Number.isFinite(value)) return null;
  return toMm(value, u);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function round(v, places = 4) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
