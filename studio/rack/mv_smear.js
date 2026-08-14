// Smear: scale every motion vector, optionally push it in one direction.
import { clampMv } from "./_lib.js";
let P = {};
export function setup(args) { args.features = [ "mv" ]; P = args.params ?? {}; }
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if ( !fwd ) return;
  const gain = (P.gain_pct ?? 250) / 100, bx = P.bias_x ?? 0, by = P.bias_y ?? 0;
  for ( let i = 0; i < fwd.length; i++ ) {
    const row = fwd[i];
    for ( let j = 0; j < row.length; j++ ) {
      const mv = row[j];
      if ( mv == null ) continue;
      row[j] = MV(clampMv(mv[0] * gain + bx), clampMv(mv[1] * gain + by));
    }
  }
}
