import * as stylex from '@stylexjs/stylex';
import { color } from '../../../ui/tokens.stylex';

const GAP = '12px';

// Which photograph a verdict means, said in colour rather than in position: A and B are the reading
// order, which is left-to-right on one arrangement and top-to-bottom on the other.
export const SIDE_COLOR = { a: color.rose, b: color.satin } as const;

export const styles = stylex.create({
  page: {
    paddingBottom: GAP,
  },
  bar: {
    marginBottom: GAP,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  // Equal claims rather than `auto`, so the picks share a centre line with Show A / Show B and the
  // photograph; a claim rather than a size, so an end needing more still keeps its buttons and wraps.
  barEnd: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  barLast: {
    justifyContent: 'flex-end',
  },
  // A grid, so the two flanks resolve to one width: that is what centres the picks.
  verdicts: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
  },
  flankFirst: {
    justifyContent: 'flex-end',
  },
  view: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flip: {
    flexDirection: 'column',
  },
  switch: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    justifyContent: 'center',
    marginTop: GAP,
  },
  // A long press on a touch screen would otherwise raise the context menu instead of peeking.
  peek: {
    touchAction: 'none',
  },
  // Sized from the frame's own decoded pixels, so the hairline runs parallel to the picture on all
  // four sides.
  frame: {
    position: 'relative',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    display: 'flex',
    minWidth: 0,
    minHeight: 0,
  },
  stage: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    minHeight: 0,
  },
  slot: {
    position: 'absolute',
    top: '6px',
    left: '8px',
    textShadow: '0 1px 3px rgb(0 0 0 / 85%)',
    pointerEvents: 'none',
  },
  slotA: {
    color: color.rose,
  },
  slotB: {
    color: color.satin,
  },
  // A mark, not a fill: a verdict that read as pressed would say a choice had been made. Inset
  // rather than on the border, which hover owns.
  markA: {
    boxShadow: `inset 2px 0 0 ${color.rose}`,
  },
  markB: {
    boxShadow: `inset 2px 0 0 ${color.satin}`,
  },
  hintA: {
    color: color.rose,
    opacity: 1,
  },
  hintB: {
    color: color.satin,
    opacity: 1,
  },
  // Clipped to nothing on purpose: never painted, so never decoded - ten decoded full-resolution
  // frames is hundreds of megabytes, where ten fetched ones cost only the bytes.
  warm: {
    position: 'absolute',
    width: 0,
    height: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  warmImage: {
    width: '1px',
    height: '1px',
  },
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
});
