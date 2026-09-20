import * as stylex from '@stylexjs/stylex';
import { color, font, size } from './tokens.stylex';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });

/** Any open menu, select or popover, by the role each announces itself with: a key typed in one is its own. */
export const POPUP = '[role="menu"], [role="listbox"], [role="dialog"]';

/** The one surface menus, selects and popovers share, and the rows inside it. */
export const menuStyles = stylex.create({
  positioner: {
    // On the positioner, not the popup: base-ui positions with a transform, so the positioner is
    // a stacking context and a z-index inside it cannot lift the menu over the stage's buttons.
    zIndex: 60,
  },
  popup: {
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '6px',
    padding: '4px',
    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.5)',
    maxHeight: '60vh',
    overflow: 'auto',
  },
  popupPad: {
    padding: '10px',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    height: size.controlH,
    paddingBlock: 0,
    paddingInline: '9px',
    borderRadius: size.radius,
    fontSize: size.controlText,
    cursor: { default: 'pointer', '[data-disabled]': 'not-allowed' },
    opacity: { default: null, '[data-disabled]': 0.45 },
    color: { default: color.boneDim, '[data-highlighted]': color.bone },
    backgroundColor: { default: null, '[data-highlighted]': color.slate },
    outline: 'none',
    userSelect: 'none',
  },
  destructive: {
    color: color.rose,
  },
  check: {
    width: '16px',
    // Margin, not padding: the column is a border-box 16px, so padding is taken out of the mark.
    marginLeft: 'auto',
    // A flex line gives a mark's width up to a long label without this.
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    display: 'inline-flex',
    justifyContent: 'center',
    color: color.glass,
  },
  into: {
    // Margin, not padding: an svg's own width is border-box, so padding shrinks the glyph.
    marginLeft: 'auto',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    color: color.bone,
  },
  dot: {
    width: '6px',
    height: '6px',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    borderRadius: '50%',
    backgroundColor: color.glass,
  },
  hint: {
    marginLeft: 'auto',
    paddingLeft: '12px',
  },
  badge: {
    marginLeft: 'auto',
    minWidth: '16px',
    height: '16px',
    paddingBlock: 0,
    paddingInline: '4px',
    borderRadius: '8px',
    backgroundColor: color.satin,
    color: '#08111f',
    fontFamily: font.mono,
    fontSize: '10px',
    fontWeight: 600,
    lineHeight: '16px',
    textAlign: 'center',
  },
  spin: {
    animationName: spin,
    animationDuration: '0.8s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  rule: {
    height: '1px',
    marginBlock: '4px',
    marginInline: '2px',
    backgroundColor: color.slate,
  },
  group: {
    display: 'grid',
  },
  groupLabel: {
    display: 'block',
    paddingTop: '6px',
    paddingInline: '9px',
    paddingBottom: '4px',
  },
});
