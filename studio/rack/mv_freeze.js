// Freeze: zero a seeded fraction of vectors so those blocks lock in place.
import { lcg } from "./_lib.js";
let P = {}, rnd = null;
export function setup(args) { args.features = [ "mv" ]; P = args.params ?? {}; rnd = lcg(P.seed ?? 7); }
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if ( !fwd ) return;
  const prob = (P.prob_pct ?? 50) / 100;
  for ( let i = 0; i < fwd.length; i++ ) {
    const row = fwd[i];
    for ( let j = 0; j < row.length; j++ ) {
      if ( row[j] == null ) continue;
      if ( rnd() < prob ) row[j] = MV(0, 0);
    }
  }
}
