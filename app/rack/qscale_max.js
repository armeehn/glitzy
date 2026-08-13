// Blockquant: pin quantisation high for hard DCT chunks and banding.
// frame.qscale.slice is an ARRAY OF OBJECTS keyed by macroblock index -- not a 2D array.
// Iterating it with .length silently does nothing and writes a byte-identical file.
let P = {};
export function setup(args) { args.features = [ "qscale" ]; P = args.params ?? {}; }
export function glitch_frame(frame) {
  const sl = frame.qscale?.slice;
  if ( !sl ) return;
  const q = Math.max(1, Math.min(31, P.qscale ?? 31));
  for ( let i = 0; i < sl.length; i++ ) {
    const row = sl[i];
    if ( row == null ) continue;
    for ( const k in row ) row[k] = q;
  }
}
