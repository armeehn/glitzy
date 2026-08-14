// Shared helpers for the Glitchsheet rack.
// NOTE: ffglitch MV arrays accept only null or MV(x,y) -- never a plain [x,y].
export function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
export function clampMv(v) { return v < -2047 ? -2047 : (v > 2047 ? 2047 : v | 0); }
