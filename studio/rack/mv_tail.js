// Tail: rolling average of the last N frames of vectors. Motion combs into streaks.
import { clampMv } from "./_lib.js";
let P = {}, hist = [];
export function setup(args) { args.features = [ "mv" ]; P = args.params ?? {}; hist = []; }
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if ( !fwd ) return;
  const tail = Math.max(1, Math.min(60, P.tail ?? 10));
  const rows = fwd.length, cols = fwd[0].length;
  const cur = new Array(rows * cols * 2).fill(0);
  for ( let i = 0; i < rows; i++ ) {
    const row = fwd[i];
    for ( let j = 0; j < row.length; j++ ) {
      const mv = row[j];
      if ( mv == null ) continue;
      const k = (i * cols + j) * 2;
      cur[k] = mv[0]; cur[k + 1] = mv[1];
    }
  }
  hist.push(cur);
  while ( hist.length > tail ) hist.shift();
  const n = hist.length;
  for ( let i = 0; i < rows; i++ ) {
    const row = fwd[i];
    for ( let j = 0; j < row.length; j++ ) {
      if ( row[j] == null ) continue;
      const k = (i * cols + j) * 2;
      let sx = 0, sy = 0;
      for ( let h = 0; h < n; h++ ) { sx += hist[h][k]; sy += hist[h][k + 1]; }
      row[j] = MV(clampMv(sx / n), clampMv(sy / n));
    }
  }
}
