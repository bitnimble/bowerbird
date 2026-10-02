import * as stylex from '@stylexjs/stylex';
import { color, derivedSize, size } from '../../../ui/tokens.stylex';
import { editSheet } from '../../raw_edit/edit_sheet.stylex';

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
  sheetOverStrip: {
    paddingBottom: 0,
  },
  belowTabs: (height: number) => ({ [editSheet.below]: `${height}px` }),
  // The frame runs from under the header, however many rows it wraps to, down to the page's padding.
  sheetTop: (frameHeight: number) => ({
    [editSheet.top]: `calc(100dvh - ${size.padB} - ${frameHeight}px)`,
  }),
  // Room above for the tabs, at their height with nothing in the safe area, which this takes.
  // Down over the page's own padding to the window's foot, so its height is what lifts the tabs.
  underTabs: {
    // Over the open panel's dismissing backdrop (z-index 18), which would otherwise take its swipes.
    position: 'relative',
    zIndex: 20,
    minWidth: 0,
    marginTop: `calc(${size.controlH} + 2 * ${size.sheetPad} + 1px)`,
    marginBottom: `calc(-1 * ${size.padB})`,
    paddingBottom: `max(${size.padB}, env(safe-area-inset-bottom))`,
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
  spanRow: {
    gridColumn: '1 / -1',
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
