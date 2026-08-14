// Bleed: drift the DC coefficients so blocks flood with flat, wrong colour.
import { lcg } from "./_lib.js";
let P = {}, rnd = null;
export function setup(args) { args.features = [ "q_dc_delta" ]; P = args.params ?? {}; rnd = lcg(P.seed ?? 3); }
export function glitch_frame(frame) {
  const k = frame.q_dc_delta;
  if ( !k || !k.data ) return;
  const drift = P.drift ?? 30, mix = (P.mix_pct ?? 50) / 100, chroma = P.chroma ?? 1;
  for ( let p = 0; p < k.data.length; p++ ) {
    if ( p > 0 && !chroma ) continue;
    const plane = k.data[p];
    for ( let r = 0; r < plane.length; r++ ) {
      const row = plane[r];
      for ( let c = 0; c < row.length; c++ ) {
        if ( row[c] === 0 ) continue;
        if ( rnd() > mix ) continue;
        row[c] = Math.round(row[c] + (rnd() * 2 - 1) * drift);
      }
    }
  }
}
