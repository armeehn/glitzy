/* Starters: a whole chain in one click.
 *
 * These are not a separate template system -- each one is just a chain, and
 * the moment it lands you can pull nodes off it, reorder them, or swap the
 * silhouette. That is the point: a starter is somewhere to begin arguing with,
 * not a preset that produces a finished thing you cannot take apart.
 */

const SRC = { width: 480, height: 480, frames: 48, fps: 25 };

export const STARTERS = [
  {
    id: 'mosh-badge', name: 'Mosh badge', blurb: 'Circular, smeared, hard quantised edges.',
    chain: [
      ['source.flow', { ...SRC, seed: 4816, palette: 'riposte', scale: 10, warp: 50 }],
      ['codec.smear', { gain_pct: 320, bias_y: 2 }],
      ['codec.blockquant', { qscale: 26 }],
      ['colour.palette', { palette: 'riposte', mode: 'quantise' }],
      ['matte.shape', { shape: 'circle' }],
      ['matte.border', { width: 12 }],
    ],
  },
  {
    id: 'acid-burst', name: 'Acid burst', blurb: 'Starburst cut, full dissolve, acid palette.',
    chain: [
      ['source.moire', { ...SRC, seed: 22, palette: 'acid', scale: 20 }],
      ['codec.storm', { amp: 30, mix_pct: 85 }],
      ['colour.palette', { palette: 'acid', mode: 'quantise' }],
      ['matte.shape', { shape: 'burst' }],
      ['matte.border', { width: 10 }],
    ],
  },
  {
    id: 'ribbon-tag', name: 'Ribbon tag', blurb: 'Swallowtail banner with combed streaks.',
    chain: [
      ['source.truchet', { ...SRC, seed: 91, palette: 'mono', scale: 8, drift: 6 }],
      ['codec.tail', { tail: 20 }],
      ['colour.palette', { palette: 'mono', mode: 'duotone' }],
      ['matte.shape', { shape: 'banner' }],
      ['matte.border', { width: 9 }],
    ],
  },
  {
    id: 'datamosh', name: 'Datamosh square', blurb: 'Squircle, feedback zoom, colour bleed.',
    chain: [
      ['source.feedback', { ...SRC, seed: 5, palette: 'neon', scale: 14, warp: 60 }],
      ['codec.smear', { gain_pct: 420 }],
      ['codec.bleed', { drift: 70, mix_pct: 70, chroma: true }],
      ['colour.palette', { palette: 'neon', mode: 'quantise' }],
      ['matte.shape', { shape: 'squircle' }],
      ['matte.border', { width: 11 }],
    ],
  },
  {
    id: 'ghost-blob', name: 'Ghost blob', blurb: 'Organic outline, frozen blocks, soft palette.',
    chain: [
      ['source.flow', { ...SRC, seed: 314, palette: 'pastel', scale: 6, warp: 70 }],
      ['codec.freeze', { prob_pct: 65 }],
      ['codec.tail', { tail: 8 }],
      ['colour.palette', { palette: 'pastel', mode: 'duotone' }],
      ['matte.shape', { shape: 'blob' }],
      ['matte.border', { width: 14 }],
    ],
  },
  {
    id: 'hard-chunk', name: 'Hard chunk', blurb: 'Hexagon, maximum quantiser, process colours.',
    chain: [
      ['source.truchet', { ...SRC, seed: 77, palette: 'cmyk', scale: 6 }],
      ['codec.blockquant', { qscale: 31 }],
      ['codec.storm', { amp: 14, mix_pct: 45 }],
      ['colour.palette', { palette: 'cmyk', mode: 'quantise' }],
      ['matte.shape', { shape: 'hex' }],
      ['matte.border', { width: 11 }],
    ],
  },
  {
    id: 'pixel-melt', name: 'Pixel melt', blurb: 'No codec at all — sorted and torn in the pixels.',
    chain: [
      ['source.plasma', { ...SRC, seed: 1201, palette: 'sunset', scale: 30 }],
      ['pixel.sort', { axis: 'x', mode: 'span', lo: 20, hi: 75 }],
      ['pixel.shift', { red: -7, blue: 7 }],
      ['colour.palette', { palette: 'sunset', mode: 'quantise' }],
      ['matte.shape', { shape: 'circle' }],
      ['matte.border', { width: 12 }],
    ],
  },
  {
    id: 'cell-print', name: 'Cell print', blurb: 'Dithered cells, two inks, star cut.',
    chain: [
      ['source.voronoi', { ...SRC, seed: 640, palette: 'mono', scale: 26, drift: 2 }],
      ['colour.dither', { palette: 'mono', matrix: 4, mono: true }],
      ['matte.shape', { shape: 'star' }],
      ['matte.border', { width: 10 }],
    ],
  },
];

/** Expand a starter into chain nodes, filling in each op's own defaults. */
export function buildChain(starter, defaultsFor) {
  return starter.chain.map(([op, params]) => ({
    op,
    params: { ...defaultsFor(op), ...params },
    off: false,
  }));
}
