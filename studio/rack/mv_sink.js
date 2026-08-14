// Sink and rise: add a constant vector so the picture pours out of the frame.
import { clampMv } from "./_lib.js";
let P = {}, n = 0;
export function setup(args) { args.features = [ "mv" ]; P = args.params ?? {}; n = 0; }
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if ( !fwd ) return;
  n++;
  const dx = P.dx ?? 0, dy = P.dy ?? 6;
  const ramp = (P.ramp ?? 0) ? n / 25 : 1;
  for ( let i = 0; i < fwd.length; i++ ) {
    const row = fwd[i];
    for ( let j = 0; j < row.length; j++ ) {
      const mv = row[j];
      if ( mv == null ) continue;
      row[j] = MV(clampMv(mv[0] + dx * ramp), clampMv(mv[1] + dy * ramp));
    }
  }
}
