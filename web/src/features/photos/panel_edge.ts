// Which edge the metadata panels take in the viewer and the editor.
//
// Decided the way the triage split is (`arrangement` in `stack_triage.ts`): from
// the box the photograph and the panels actually share, not from the photo's
// shape alone. A 3:2 frame on a 16:9 screen is already limited by the height,
// with width left over, so the panels belong in that spare width - the same
// frame in a portrait window is not, and they belong under it.

/** The panel column, from `.detail--beside` in `styles.css`. */
const PANEL_WIDTH = 320;
/** The strip's cap, from `.detail--below .detail__panels` (34vh). */
const PANEL_STRIP = 0.34;
/** `.detail`'s grid gap. */
const PANEL_GAP = 10;

// A photo of aspect `a` fitted into a `w`x`h` box covers `a·h²` when the height
// is what binds it and `w²/a` when the width is.
function fitArea(a: number, w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0;
  return w / h >= a ? a * h * h : (w * w) / a;
}

/**
 * The edge that leaves the photograph biggest, given the box the two share.
 *
 * The strip is taken as its cap rather than measured: the panels are laid out
 * inside whichever edge they were given, so the height they would have had on
 * the *other* one is not a thing the page can know without rendering it there -
 * and following a measurement taken under one answer into the other is how a
 * layout ends up oscillating. Against the box's own height rather than the
 * window's, which understates a 34vh cap by the bar above it and so only ever
 * favours the strip; the two areas are far enough apart either way except on
 * boxes that are close to square, where the choice hardly matters.
 */
export function panelEdge(aspect: number, width: number, height: number): 'beside' | 'below' {
  const beside = fitArea(aspect, width - PANEL_WIDTH - PANEL_GAP, height);
  const below = fitArea(aspect, width, height - height * PANEL_STRIP - PANEL_GAP);
  return beside >= below ? 'beside' : 'below';
}
