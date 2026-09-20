import * as stylex from '@stylexjs/stylex';
import { color, derivedSize, font, size } from '../../../ui/tokens.stylex';
import type { ViewMode } from '../photos_store';
import { gridVars, stripMarker, tileMarker } from './grid.stylex';

// Not `ICON`, which is the size a control's icons are: these sit in a badge whose siblings are 9px
// uppercase, and a glyph at control size towers over the words beside it.
export const BADGE_ICON = 11;

const BACKDROP = '#090b0e';
const SCRIM = 'rgba(10, 12, 16, 0.66)';
const LIST_THUMB = '120px';
const BULK_BAR_H = '64px';
const EDGE_INSET = `calc(${size.tilePad} + 6px)`;
const BAR_THUMB_INSET = `calc((${gridVars.barW} - 6px) / 2)`;
const FUSE_RIGHT = `calc(${gridVars.fuseX} + ${gridVars.fuseW})`;
const RING = (colour: string): string => `inset 0 0 0 ${size.ring} ${colour}`;

/** How the cells around a tile are laid out: the gallery's three modes, or the strip along either axis. */
export type Layout = ViewMode | 'x' | 'y';

export const layoutOf = (mode: ViewMode, inStrip: 'x' | 'y' | null): Layout => inStrip ?? mode;

export const viewport = stylex.create({
  gallery: {
    position: 'relative',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minHeight: 0,
    display: 'flex',
    // Out through the page's inset to the window edge: the bar centres its thumb in its own
    // width, and stopping short left it a pad closer to the tiles than to the window.
    marginRight: `calc(-1 * ${size.padX})`,
    [gridVars.barW]: '24px',
  },
  scroller: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    // Constant whether or not a bar is drawn: the bar's presence would otherwise change the
    // column count, and so the content height that decides whether a bar is needed.
    paddingRight: gridVars.barW,
    paddingBottom: size.padB,
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': { display: 'none' },
  },
  barred: {
    paddingBottom: `calc(${size.padB} + ${BULK_BAR_H})`,
  },
  content: {
    position: 'relative',
    // Load-bearing: the browser's own scroll anchoring adjusts scrollTop to hold a row still,
    // which fights every anchor write.
    overflowAnchor: 'none',
  },
  stripContent: {
    height: '100%',
  },
  stripContentY: {
    width: '100%',
  },
  railWidth: (length: number) => ({ width: `${length}px` }),
  railHeight: (length: number) => ({ height: `${length}px` }),
});

export const bar = stylex.create({
  track: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: gridVars.barW,
    // The track spans the grid's whole height, and events there would swallow a click, a
    // wheel notch or a touch pan anywhere down that edge.
    pointerEvents: 'none',
    userSelect: 'none',
    // Above the stack overlay (1) and the focus ring (2), which only a window's transform
    // traps below this - a masonry block makes no stacking context. Under the bulk bar (5).
    zIndex: 3,
  },
  across: {
    top: 'auto',
    left: 0,
    width: 'auto',
    height: gridVars.barW,
  },
  thumb: {
    position: 'absolute',
    left: 0,
    right: 0,
    pointerEvents: 'auto',
    touchAction: 'none',
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: BAR_THUMB_INSET,
      right: BAR_THUMB_INSET,
      borderRadius: size.radius,
      // boneDim, not a divider tint: a slate thumb on ink is 1.2:1, and this is the only
      // readout of where in the collection the reader is. Forced colours flatten a bare
      // background to Canvas.
      backgroundColor: { default: color.boneDim, ':hover': color.bone, '@media (forced-colors: active)': 'CanvasText' },
    },
  },
  thumbAcross: {
    left: 'auto',
    right: 'auto',
    top: 0,
    bottom: 0,
    '::after': {
      left: 0,
      right: 0,
      top: BAR_THUMB_INSET,
      bottom: BAR_THUMB_INSET,
    },
  },
});

export const cells = stylex.create({
  section: {
    gap: size.gridGap,
  },
  window: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
  },
  block: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  grid: {
    display: 'grid',
    gridAutoRows: gridVars.rowH,
  },
  masonry: {
    display: 'flex',
    flexWrap: 'wrap',
    // Eats the last line's free space, so two leftover photos don't stretch to a
    // screen-wide row.
    '::after': {
      content: '""',
      flexGrow: 1000000,
      flexShrink: 0,
      flexBasis: 0,
    },
  },
  // A block ending on a line break justifies its last line like the rest, which is what stops
  // the block seam reading as a short row.
  continues: {
    '::after': { content: 'none' },
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
  },
  x: {
    display: 'flex',
    flexWrap: 'nowrap',
    flexDirection: 'row',
    height: '100%',
  },
  y: {
    display: 'flex',
    flexWrap: 'nowrap',
    flexDirection: 'column',
    width: '100%',
  },
  windowX: {
    bottom: 0,
    right: 'auto',
    width: 'max-content',
  },
  windowY: {
    height: 'max-content',
  },
  lineEnd: {
    flexGrow: 1000000,
    flexShrink: 0,
    flexBasis: 0,
  },
  columns: (columns: number) => ({ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }),
  rows: (height: number) => ({ [gridVars.rowH]: `${height}px` }),
  down: (top: number) => ({ transform: `translateY(${top}px)` }),
  along: (along: 'x' | 'y', at: number) => ({
    transform: along === 'x' ? `translateX(${at}px)` : `translateY(${at}px)`,
  }),
  top: (top: number) => ({ top: `${top}px` }),
  stripCells: (cell: number, spine: number) => ({ [gridVars.cell]: `${cell}px`, [gridVars.spine]: `${spine}px` }),
});

export const band = stylex.create({
  band: {
    backgroundColor: 'rgba(120, 140, 180, 0.1)',
    borderRadius: derivedSize.cellRadius,
    // Ringed by an overlay rather than bordered: a border would spend rows' worth of the
    // band's height and push its last row into the grid below.
    '::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      borderWidth: size.ring,
      borderStyle: 'solid',
      borderColor: gridVars.band,
      borderRadius: 'inherit',
    },
  },
  // A full-width item on masonry's flex line, and the ring's containing block: the placed
  // band's window is absolute already.
  inline: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: '100%',
    position: 'relative',
  },
  list: {
    paddingLeft: '28px',
  },
  fused: {
    [gridVars.fuseCutLeft]: `calc(${gridVars.fuseX} + ${size.ring} - ${size.radius})`,
    [gridVars.fuseCutRight]: `calc(${FUSE_RIGHT} + ${size.radius} - ${size.ring})`,
    '::before': {
      content: '""',
      position: 'absolute',
      // Pseudo-elements miss the global reset, and a content-box border lands a ring's width
      // past the tile's own edge.
      boxSizing: 'border-box',
      left: gridVars.fuseX,
      width: gridVars.fuseW,
      top: `calc(-1 * ${size.gridGap})`,
      height: size.gridGap,
      pointerEvents: 'none',
    },
    // What is left of the ring is kept from a pixel clear of the top edge: a mask edge on the
    // border's own half-covers one device row on a fractional ratio, a hairline across the cut.
    '::after': {
      mask: `linear-gradient(#000 0 0) 0 0 / ${gridVars.fuseCutLeft} 100% no-repeat, linear-gradient(#000 0 0) 100% 0 / calc(100% - ${gridVars.fuseCutRight}) 100% no-repeat, linear-gradient(#000 0 0) 0 100% / 100% calc(100% - ${size.ring} - 1px) no-repeat`,
    },
  },
  fuseFirst: {
    borderTopLeftRadius: 0,
    [gridVars.fuseCutLeft]: `calc(${gridVars.fuseX} + ${size.ring})`,
    '::before': {
      borderLeftWidth: size.ring,
      borderLeftStyle: 'solid',
      borderLeftColor: gridVars.band,
    },
  },
  fuseLast: {
    borderTopRightRadius: 0,
    [gridVars.fuseCutRight]: `calc(${FUSE_RIGHT} - ${size.ring})`,
    '::before': {
      borderRightWidth: size.ring,
      borderRightStyle: 'solid',
      borderRightColor: gridVars.band,
    },
  },
  join: {
    position: 'absolute',
    top: `calc(-1 * ${size.gridGap})`,
    width: size.radius,
    height: `calc(${size.gridGap} + ${size.ring})`,
    borderBottomWidth: size.ring,
    borderBottomStyle: 'solid',
    borderBottomColor: gridVars.band,
    pointerEvents: 'none',
  },
  joinLeft: {
    left: `calc(${gridVars.fuseX} + ${size.ring} - ${size.radius})`,
    borderRightWidth: size.ring,
    borderRightStyle: 'solid',
    borderRightColor: gridVars.band,
    borderBottomRightRadius: size.radius,
  },
  joinRight: {
    left: `calc(${FUSE_RIGHT} - ${size.ring})`,
    borderLeftWidth: size.ring,
    borderLeftStyle: 'solid',
    borderLeftColor: gridVars.band,
    borderBottomLeftRadius: size.radius,
  },
  measured: (x: number, width: number) => ({ [gridVars.fuseX]: `${x}px`, [gridVars.fuseW]: `${width}px` }),
  column: (columns: number, column: number) => ({
    [gridVars.fuseW]: `calc((100% - ${columns - 1} * ${size.gridGap}) / ${columns})`,
    [gridVars.fuseX]: `calc((${gridVars.fuseW} + ${size.gridGap}) * ${column})`,
  }),
  cap: (cap: number) => ({ [gridVars.bandCap]: `${cap}px` }),
});

// None of them is the house blue, which the selection has: in blue an open stack's ringed tile
// reads as a second photo selected.
const bandColour = stylex.create({
  violet: { [gridVars.band]: '#9d7ce8' },
  pink: { [gridVars.band]: '#d96bb0' },
  ochre: { [gridVars.band]: '#d9b23a' },
});

const BAND_COLOUR_STYLES = [bandColour.violet, bandColour.pink, bandColour.ochre];

export const bandColourOf = (index: number | undefined): stylex.StyleXStyles | null =>
  index == null ? null : (BAND_COLOUR_STYLES[index] ?? bandColour.violet);

export const tile = stylex.create({
  tile: {
    position: 'relative',
    aspectRatio: '3 / 2',
    overflow: 'hidden',
    cursor: 'pointer',
    display: 'block',
    // The room the ring stands off the photograph; the picture and its backdrop are inset by
    // exactly this, so a background here would show as a border round every cell.
    padding: size.tilePad,
    borderRadius: derivedSize.cellRadius,
  },
  grid: {
    aspectRatio: 'auto',
  },
  list: {
    aspectRatio: 'auto',
    padding: 0,
    height: gridVars.rowH,
  },
  strip: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    aspectRatio: 'auto',
  },
  x: {
    width: gridVars.cell,
  },
  y: {
    height: gridVars.cell,
  },
  spineX: {
    width: gridVars.spine,
    padding: 0,
  },
  spineY: {
    height: gridVars.spine,
    padding: 0,
  },
  // content-box, so the shape is the photograph's: on the cell's box the pad comes off both
  // sides and the backdrop shows as a hairline down two edges.
  masonry: (aspect: number, tileSize: number) => ({
    boxSizing: 'content-box',
    aspectRatio: aspect,
    flexGrow: aspect,
    flexShrink: 1,
    flexBasis: `${aspect * tileSize}px`,
  }),
  capped: (aspect: number) => ({ maxWidth: `calc(${gridVars.bandCap} * ${aspect})` }),
  waiting: {
    cursor: 'default',
    // Clipped to where the hit overlay would be, so the placeholder packs at the width of the
    // photo it stands in for.
    backgroundColor: BACKDROP,
    backgroundClip: 'content-box',
  },
  // Drawn by an overlay rather than an inset shadow: the rendition is a child and paints over
  // any shadow cast inward.
  ring: {
    '::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 2,
      borderRadius: 'inherit',
    },
  },
  selected: {
    '::after': { boxShadow: RING(color.satin) },
  },
  cursor: {
    '::after': { boxShadow: RING(color.glass) },
  },
  // Solid where the cursor's ring is an accent: not where the keyboard is but where you are.
  open: {
    '::after': { boxShadow: RING(color.bone) },
  },
  band: {
    '::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 2,
      borderRadius: 'inherit',
      boxShadow: RING(gridVars.band),
    },
  },
  fused: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    // Each shadow is offset down as well as sideways: two coincident antialiased edges on a
    // fractional device ratio drew the bottom the band owns as a faint hairline.
    '::before': {
      boxShadow: `inset ${size.ring} ${size.ring} 0 ${gridVars.band}, inset calc(-1 * ${size.ring}) ${size.ring} 0 ${gridVars.band}`,
    },
  },
  spine: {
    '::before': { content: 'none' },
  },
  photo: {
    position: 'absolute',
    inset: size.tilePad,
    borderRadius: size.radius,
    overflow: 'hidden',
    backgroundColor: BACKDROP,
  },
  photoList: {
    inset: 0,
    borderRadius: 'inherit',
    display: 'grid',
    gridTemplateColumns: `${LIST_THUMB} minmax(0, 1fr)`,
    alignItems: 'center',
    gap: '12px',
  },
  photoSpine: {
    inset: 0,
    borderRadius: 'inherit',
  },
  hit: {
    position: 'absolute',
    inset: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: 'inherit',
    textDecorationLine: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    // On the picture's own box, so the wash stops where the photograph does.
    '::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      backgroundColor: { default: 'transparent', [stylex.when.ancestor(':hover', tileMarker)]: 'rgb(232 228 218 / 0.07)' },
      boxShadow: {
        default: 'inset 0 0 0 1px transparent',
        [stylex.when.ancestor(':hover', tileMarker)]: 'inset 0 0 0 1px rgb(232 228 218 / 0.22)',
      },
      transitionProperty: 'background-color, box-shadow',
      transitionDuration: '120ms',
      transitionTimingFunction: 'ease',
    },
  },
  // contain, not cover: cropping a portrait frame to a landscape cell hides the part of the
  // picture it is judged by.
  img: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: '220ms',
    transitionTimingFunction: 'ease',
  },
  imgList: {
    width: LIST_THUMB,
    height: '100%',
    paddingBlock: '3px',
    paddingInline: 0,
  },
  // Until it decodes the image is a probe behind the placeholder: in flow the two stack and
  // the placeholder is pushed out of the tile.
  imgPending: {
    position: 'absolute',
    inset: 0,
    height: '100%',
  },
  imgLoaded: {
    opacity: 1,
  },
  imgOutside: {
    opacity: 0.35,
  },
  imgRejected: {
    opacity: 0.55,
  },
  pending: {
    display: 'grid',
    placeItems: 'center',
    width: '100%',
    height: '100%',
    fontFamily: font.mono,
    fontSize: '10px',
    letterSpacing: '0.08em',
    color: '#4a505c',
    textTransform: 'uppercase',
  },
  busy: {
    position: 'absolute',
    inset: 0,
    zIndex: 2,
    display: 'grid',
    placeItems: 'center',
    backgroundColor: 'rgba(10, 12, 16, 0.62)',
    pointerEvents: 'none',
  },
  spinner: {
    width: '26px',
    height: '26px',
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderTopColor: color.glass,
    borderRadius: '50%',
  },
  // The right corner: the tick box has the left, and a badge under it would be covered the
  // moment the tile is hovered.
  badges: {
    position: 'absolute',
    right: EDGE_INSET,
    top: EDGE_INSET,
    display: 'flex',
    gap: '4px',
    zIndex: 2,
  },
  badge: {
    fontFamily: font.mono,
    fontSize: '9px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    paddingBlock: '2px',
    paddingInline: '5px',
    borderRadius: '2px',
    backgroundColor: 'rgba(10, 12, 16, 0.82)',
    color: color.boneDim,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  },
  missing: {
    color: color.ochre,
  },
  deleted: {
    color: color.rose,
  },
  // A lone glyph: the text badges' padding would sit it off-centre in a box twice its width.
  hidden: {
    paddingBlock: '3px',
    paddingInline: '3px',
  },
  // A mark, not a control: the click has to reach the frame under it.
  stack: {
    pointerEvents: 'none',
    position: 'absolute',
    inset: 0,
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    backgroundColor: 'rgba(10, 12, 16, 0.35)',
    color: color.bone,
    fontFamily: font.mono,
    fontSize: '20px',
  },
  stackOpen: {
    backgroundColor: 'rgba(10, 12, 16, 0.62)',
  },
  // After `stackOpen`: an uncollapsed stack and a composite ring the tile without dimming it.
  stackClear: {
    backgroundColor: 'transparent',
  },
  stackList: {
    display: 'grid',
    gridTemplateColumns: `${LIST_THUMB} minmax(0, 1fr)`,
    justifyItems: 'center',
  },
  stackSpine: {
    backgroundColor: gridVars.band,
    color: color.ink,
  },
  // One size open and closed, or every click on a stack resizes the mark under the pointer.
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    minWidth: '72px',
    height: '34px',
    paddingBlock: 0,
    paddingInline: '10px',
    lineHeight: 1,
    borderRadius: '4px',
    backgroundColor: SCRIM,
  },
  chipSpine: {
    minWidth: 0,
    height: 'auto',
    paddingInline: 0,
    backgroundColor: 'transparent',
  },
  count: {
    fontVariantNumeric: 'tabular-nums',
    minWidth: '2ch',
    textAlign: 'center',
  },
  outside: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    pointerEvents: 'none',
    color: color.boneDim,
    fontFamily: font.mono,
    fontSize: '10px',
    textAlign: 'center',
  },
});

export const foot = stylex.create({
  foot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: '14px',
    paddingRight: '7px',
    paddingBottom: '5px',
    paddingLeft: '7px',
    backgroundImage: 'linear-gradient(transparent, rgba(6, 8, 11, 0.9))',
    display: 'flex',
    justifyContent: 'space-between',
    // Centred against a row as tall as the tallest control, so which marks are switched on
    // decides none of their heights.
    minHeight: '18px',
    alignItems: 'center',
    gap: '6px',
  },
  list: {
    // Positioned: the hit overlay is absolute, so an in-flow foot paints under it.
    position: 'relative',
    gridColumn: 2,
    pointerEvents: 'none',
    backgroundImage: 'none',
    paddingTop: 0,
    paddingLeft: 0,
    paddingBottom: 0,
    // Clear of the row's own rounded corner.
    paddingRight: '20px',
    gap: '14px',
  },
  // A label rather than a control here, and one that swallowed the click would make the
  // bottom of every cell a dead spot.
  strip: {
    pointerEvents: 'none',
    minHeight: 0,
  },
  name: {
    fontFamily: font.mono,
    fontSize: '10px',
    color: '#b9bcc4',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Keeps the marks against the right edge: three items under `space-between` would centre
  // the badge.
  badgeAfterName: {
    marginRight: 'auto',
  },
  nameList: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: '12px',
  },
  nameListBeforeBadge: {
    flexGrow: 0,
    flexBasis: 'auto',
  },
  badge: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    pointerEvents: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    padding: 0,
    borderWidth: 0,
    borderRadius: '3px',
    backgroundColor: SCRIM,
    color: color.bone,
    cursor: 'pointer',
  },
});

export const strip = stylex.create({
  viewport: {
    // No gutter unless there is something to seek: the bar is unmounted for a collection
    // the strip shows whole, and an empty gutter reads as a missing photograph.
    [gridVars.barW]: '0px',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'content-box',
    padding: '4px',
    borderRadius: size.radius,
    backgroundColor: color.bower,
  },
  seekable: {
    [gridVars.barW]: '12px',
  },
  viewportY: {
    width: `calc(${gridVars.strip} + ${gridVars.barW})`,
  },
  track: {
    position: 'relative',
    minWidth: 0,
    minHeight: 0,
  },
  // Added to the track rather than taken out of the strip: the scroller's height sizes a
  // cell, so a gutter out of the cells would have the bar deciding whether a bar is needed.
  trackX: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    height: `calc(${gridVars.strip} + ${gridVars.barW})`,
    paddingBottom: gridVars.barW,
  },
  trackY: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    paddingRight: gridVars.barW,
  },
  scroller: {
    width: '100%',
    height: '100%',
    position: 'relative',
    overscrollBehavior: 'contain',
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': { display: 'none' },
  },
  scrollerX: {
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  scrollerY: {
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  zoom: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    display: 'flex',
    justifyContent: 'flex-end',
    // Inside the bar's gutter and a little more: a track hard against the strip's edge reads
    // as something that has slipped off it.
    paddingTop: 0,
    paddingRight: `calc(${gridVars.barW} + 6px)`,
    paddingBottom: '4px',
    paddingLeft: 0,
    opacity: { default: 0.45, [stylex.when.ancestor(':hover', stripMarker)]: 1, ':focus-within': 1 },
    transitionProperty: 'opacity',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease-out',
  },
  zoomY: {
    paddingTop: '4px',
    paddingBottom: 0,
  },
  // Shorter than a control: a 30px track over a 104px strip is a third as tall as the photographs.
  slider: {
    width: '84px',
    height: '14px',
  },
  thickness: (thickness: number) => ({ [gridVars.strip]: `${thickness}px` }),
});
