// Page presets. Dimensions are millimetres, portrait orientation.
import { MM_PER_IN } from './units.js';

const inches = (n) => n * MM_PER_IN;

export const PAGE_PRESETS = [
  { id: 'letter', label: 'US Letter — 8.5 × 11 in', group: 'Print', w: inches(8.5), h: inches(11) },
  { id: 'legal', label: 'US Legal — 8.5 × 14 in', group: 'Print', w: inches(8.5), h: inches(14) },
  { id: 'tabloid', label: 'Tabloid — 11 × 17 in', group: 'Print', w: inches(11), h: inches(17) },
  { id: 'a3', label: 'A3 — 297 × 420 mm', group: 'Print', w: 297, h: 420 },
  { id: 'a4', label: 'A4 — 210 × 297 mm', group: 'Print', w: 210, h: 297 },
  { id: 'a5', label: 'A5 — 148 × 210 mm', group: 'Print', w: 148, h: 210 },
  { id: 'mat-12x12', label: 'Cutting mat — 12 × 12 in', group: 'Cutter mats', w: inches(12), h: inches(12) },
  { id: 'mat-12x24', label: 'Cutting mat — 12 × 24 in', group: 'Cutter mats', w: inches(12), h: inches(24) },
  { id: 'roll-vinyl-12', label: 'Vinyl roll — 12 in wide', group: 'Cutter mats', w: inches(12), h: inches(36) },
  { id: 'custom', label: 'Custom size…', group: 'Custom', w: inches(8.5), h: inches(11) },
];

export function findPreset(id) {
  return PAGE_PRESETS.find((p) => p.id === id) || PAGE_PRESETS[0];
}

/**
 * Machine profiles seed sensible bleed / margin / registration defaults.
 * Values come from each vendor's print-and-cut documentation; they are all
 * editable afterwards.
 */
export const MACHINE_PROFILES = [
  {
    id: 'generic',
    label: 'Generic / manual cutter',
    bleed: inches(0.125),
    margin: inches(0.25),
    marks: 'crop',
  },
  {
    id: 'cricut',
    label: 'Cricut — Print Then Cut',
    bleed: inches(0.0625),
    // Cricut reserves a wide band for its sensor border on Letter stock.
    margin: inches(0.5),
    marks: 'cricut',
    note: 'Cricut scans a solid black border. Keep artwork inside the margin.',
  },
  {
    id: 'silhouette',
    label: 'Silhouette — Print & Cut',
    bleed: inches(0.0625),
    margin: inches(0.5),
    marks: 'silhouette',
    note: 'Silhouette needs the L-shaped registration marks unobstructed.',
  },
  {
    id: 'roland',
    label: 'Roland / contour plotter',
    bleed: inches(0.125),
    margin: inches(0.375),
    marks: 'crop',
    note: 'Cut paths export on a CutContour layer in the SVG.',
  },
];

export function findProfile(id) {
  return MACHINE_PROFILES.find((p) => p.id === id) || MACHINE_PROFILES[0];
}
