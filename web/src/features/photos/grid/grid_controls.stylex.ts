import * as stylex from '@stylexjs/stylex';
import { color, font, size } from '../../../ui/tokens.stylex';

export const styles = stylex.create({
  controls: {
    marginBottom: '10px',
  },
  // The count and the menu behind it belong to the grid rather than to the filters.
  end: {
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '10px',
  },
  count: {
    whiteSpace: 'nowrap',
  },
  // The inset is the item padding either side, so the panel lines up with the labels around it.
  menuPanel: {
    display: 'grid',
    gap: '8px',
    paddingTop: '4px',
    paddingInline: '9px',
    paddingBottom: '6px',
  },
  // The popup is sized by its widest row, and a track at its natural width leaves the panel
  // narrower than the section headings it sits under.
  panelSlider: {
    width: '100%',
  },
  filters: {
    display: 'grid',
    gap: '8px',
  },
  foot: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  // A menu row that is a real checkbox, the panel being a popover and not a menu. A body or
  // lens ruled out by the other list stays, so the list keeps its shape.
  check: {
    color: color.bone,
    backgroundColor: { default: null, ':hover': color.slate },
    opacity: { default: null, ':has(input:disabled)': 0.45 },
    cursor: { default: 'pointer', ':has(input:disabled)': 'not-allowed' },
  },
  submenu: {
    width: '100%',
    backgroundColor: { default: 'transparent', ':hover': color.slate, '[data-popup-open]': color.slate },
    borderStyle: 'none',
    color: color.bone,
    textAlign: 'left',
  },
  caret: {
    color: color.glass,
  },
  // At the end whether or not a badge pushed itself there.
  caretAlone: {
    marginLeft: 'auto',
  },
  // Long enough for a lens name, capped so a submenu is a column rather than a second panel.
  models: {
    maxWidth: '320px',
  },
  caption: {
    display: 'flex',
    gap: '4px',
  },
  // A fixed width apiece, or the caption resizes as the months are stepped through and the
  // arrows move with it.
  month: {
    width: '108px',
    justifyContent: 'space-between',
  },
  year: {
    width: '72px',
    justifyContent: 'space-between',
  },
  calendar: {
    fontFamily: font.body,
    fontSize: size.controlText,
    marginBottom: '8px',
  },
  nav: {
    position: 'static',
    display: 'flex',
    height: size.controlH,
    gap: '2px',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  navButton: {
    width: size.controlH,
    height: size.controlH,
    color: { default: color.boneDim, ':hover': color.bone },
  },
  weekday: {
    fontFamily: font.mono,
    fontSize: '10px',
    textTransform: 'uppercase',
    color: color.boneDim,
  },
  // The caption's own content now that the nav is in it, rather than the one row
  // react-day-picker sizes for.
  monthCaption: {
    display: 'block',
    height: 'auto',
  },
  dayButton: {
    position: 'relative',
  },
  dayDot: {
    position: 'absolute',
    left: '50%',
    bottom: '-1px',
    width: '6px',
    height: '6px',
    // So a scaled-down dot keeps the row's baseline instead of creeping towards the number.
    transformOrigin: 'bottom center',
    transform: 'translateX(-50%)',
    borderRadius: '50%',
    backgroundColor: color.glass,
    pointerEvents: 'none',
  },
  // The accent is a picked day's own background, so its dot is drawn in the number's colour.
  dayDotPicked: {
    backgroundColor: 'currentColor',
  },
});

