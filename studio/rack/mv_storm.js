// Storm: seeded random vectors. Full dissolve into confetti.
import { lcg, clampMv } from "./_lib.js";
let P = {}, rnd = null;
export function setup(args) { args.features = [ "mv" ]; P = args.params ?? {}; rnd = lcg(P.seed ?? 1); }
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if ( !fwd ) return;
  const amp = P.amp ?? 24, mix = (P.mix_pct ?? 100) / 100;
  for ( let i = 0; i < fwd.length; i++ ) {
    const row = fwd[i];
    for ( let j = 0; j < row.length; j++ ) {
      const mv = row[j];
      if ( mv == null ) continue;
      if ( rnd() > mix ) continue;
      row[j] = MV(clampMv(mv[0] + (rnd() * 2 - 1) * amp), clampMv(mv[1] + (rnd() * 2 - 1) * amp));
    }
  }
}
