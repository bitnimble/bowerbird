// Which edge the metadata panels take in the viewer and the editor, and which the
// filmstrip takes.
//
// Decided the way the triage split is (`arrangement` in `stack_triage.ts`): from
// the box the photograph and the panels actually share, not from the photo's
// shape alone. A 3:2 frame on a 16:9 screen is already limited by the height,
// with width left over, so the panels belong in that spare width - the same
// frame in a portrait window is not, and they belong under it.
//
// One call each, because they are one trade each: a 320px column and a 34vh fold
// cost different things from a strip a hundred pixels thick, so the two edges are
// routinely not the same edge. The strip chooses first and the panels choose
// inside what it left, which is how they are nested on the page.

/** The panel column, from `styles.beside` in `photo_detail_page.tsx`. */
const PANEL_WIDTH = 320;
/** The panels' fold along the foot, from `styles.panelsBelow` (34vh). */
const PANEL_FOLD = 0.34;
/** `styles.detail`'s grid gap, and `styles.frame`'s. */
const GAP = 10;
/** What the strip spends across its cells besides them: its viewport's padding, the resize handle's gutter, and the seek bar's (`photo_grid_styles.ts`). */
const STRIP_CHROME = 24;

export type Edge = 'beside' | 'below';

// A photo of aspect `a` fitted into a `w`x`h` box covers `a·h²` when the height
// is what binds it and `w²/a` when the width is.
function fitArea(a: number, w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0;
  return w / h >= a ? a * h * h : (w * w) / a;
}

function betterEdge(aspect: number, width: number, height: number, beside: number, below: number): Edge {
  return fitArea(aspect, width - beside, height) >= fitArea(aspect, width, height - below) ? 'beside' : 'below';
}

/**
 * The edge that leaves the photograph biggest, given the whole frame.
 *
 * The strip spans the frame on whichever edge it takes - full width along the
 * foot, full height down the side - so it is this one that chooses first, and
 * the panels choose inside what it leaves.
 */
export function stripEdge(aspect: number, width: number, height: number, thickness: number): Edge {
  const cost = stripCost(thickness);
  return betterEdge(aspect, width, height, cost, cost);
}

/**
 * The same question for the panels, over what the strip has left of the frame.
 *
 * `strip` is the edge it took and how thick it is drawn, or null where it is
 * shut. Answered second, so opening the panels never moves the strip: the two
 * are nested on the page, and a decision that ran the other way would have an
 * inner control relocating the one around it.
 *
 * The panels are taken as their cap rather than measured: they are laid out
 * inside whichever edge they were given, so the height they would have had on
 * the *other* one is not a thing the page can know without rendering it there -
 * and following a measurement taken under one answer into the other is how a
 * layout ends up oscillating. The two areas are far enough apart either way
 * except on boxes that are close to square, where the choice hardly matters.
 */
export function panelEdge(aspect: number, width: number, height: number, strip: { edge: Edge; thickness: number } | null): Edge {
  // 34vh is the window's height, so the strip's slice does not come off it.
  const fold = height * PANEL_FOLD + GAP;
  const taken = strip == null ? 0 : stripCost(strip.thickness);
  const w = strip?.edge === 'beside' ? width - taken : width;
  const h = strip?.edge === 'below' ? height - taken : height;
  return betterEdge(aspect, w, h, PANEL_WIDTH + GAP, fold);
}

function stripCost(thickness: number): number {
  return thickness + STRIP_CHROME + GAP;
}
