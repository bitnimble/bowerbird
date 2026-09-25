import * as stylex from '@stylexjs/stylex';
import { color, derivedSize, size } from '../../../ui/tokens.stylex';

export const styles = stylex.create({
  menuRating: {
    paddingTop: '4px',
    paddingInline: '9px',
    paddingBottom: '6px',
  },
  page: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  // One line: a wrapped bar pushes the photo down and moves every control out from under the
  // thumb. The path gives up its width first, then the menus fold into one button.
  nav: {
    // Above the mobile panels' dismissing backdrop (z-index 18), so a tool or Done still
    // takes the tap that closes an open panel instead of spending it on the backdrop.
    position: 'relative',
    zIndex: 21,
    marginBottom: '8px',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    flexWrap: 'nowrap',
  },
  // A phone's editing bar holds eight controls and no path to give up width.
  navEditing: {
    flexWrap: 'wrap',
  },
  path: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: 'auto',
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  // The popup is sized by its widest row, and a path has no word to break at.
  pathMenu: {
    display: 'block',
    maxWidth: '70vw',
    paddingBlock: '6px',
    paddingInline: '9px',
    overflowWrap: 'anywhere',
  },
  tools: {
    display: 'contents',
  },
  frame: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minHeight: 0,
    gap: '10px',
  },
  frameBelow: {
    flexDirection: 'column',
  },
  frameBeside: {
    flexDirection: 'row',
  },
  // minmax(0, 1fr), never the implicit `auto` column: an auto track is at least min-content wide,
  // and the strip's min-content is the whole rail, which the stage beside it then stretched to.
  detail: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: '10px',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    minHeight: 0,
  },
  beside: {
    gridTemplateColumns: 'minmax(0, 1fr) 320px',
  },
  below: {
    gridTemplateRows: 'minmax(0, 1fr) auto',
  },
  only: {
    gridTemplateRows: 'minmax(0, 1fr)',
  },
  // The bar below is fixed rather than in the flow, so the verdict is always under the same thumb
  // and the stage never resizes as the fold opens over it.
  sheet: {
    gridTemplateRows: 'minmax(0, 1fr)',
    paddingBottom: derivedSize.sheetH,
  },
  sheetStrip: {
    gridTemplateRows: 'minmax(0, 1fr) auto',
  },
  panels: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: '8px',
    alignContent: 'start',
    overflow: 'auto',
    minHeight: 0,
  },
  panelsBelow: {
    gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
    maxHeight: '34vh',
  },
  panelsInSheet: {
    maxHeight: '60vh',
    marginBottom: size.sheetPad,
  },
  panelFlush: {
    marginBottom: 0,
  },
  sheetBar: {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    display: 'flex',
    flexDirection: 'column',
    paddingTop: size.sheetPad,
    paddingInline: size.padX,
    paddingBottom: `max(${size.sheetPad}, env(safe-area-inset-bottom))`,
    backgroundColor: color.ink,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
  },
  verdictControl: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
  },
  rating: {
    justifyContent: 'space-between',
    marginTop: '10px',
    marginInline: 0,
    marginBottom: 0,
  },
  notice: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    paddingTop: '8px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '6px',
  },
  noticeText: {
    margin: 0,
  },
  clip: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

// Longest edge the decode is fitted to; 0 is the sensor's own.
//
// It was 3840, back when a tick cost what the frame cost. The draw runs once per canvas
// pixel now, so the frame's size is paid for once at the open and never again, and holding
// the decode below the sensor would only mean a reader who zooms in sees detail the decode
// threw away (`docs/raw-edit-gpu.md` §4.1).
