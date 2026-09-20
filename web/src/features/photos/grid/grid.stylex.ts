import * as stylex from '@stylexjs/stylex';

export const gridVars = stylex.defineVars({
  /** An open stack's colour, worn by its tile and its band. */
  band: '#9d7ce8',
  rowH: '160px',
  /** How far along the strip one of its cells runs. */
  cell: '150px',
  spine: '20px',
  /** How thick the strip is across. */
  strip: '104px',
  /** The drawn scrollbar's gutter. */
  barW: '24px',
  /** The tallest a masonry band's line may draw its photographs. */
  bandCap: '100%',
  /** Where a joined band's top edge is cut for its tile's column, and how wide. */
  fuseX: '0px',
  fuseW: '0px',
  fuseCutLeft: '0px',
  fuseCutRight: '0px',
});

/** On a tile, for what a tile's own children draw while it is hovered or holds focus. */
export const tileMarker = stylex.defineMarker();

export const stripMarker = stylex.defineMarker();
