import * as stylex from '@stylexjs/stylex';
import { color, size } from '../../ui/tokens.stylex';
import { overlayColour } from './overlay.stylex';

const COARSE = '@media (pointer: coarse)';

const spin = stylex.keyframes({ to: { rotate: '360deg' } });

export const styles = stylex.create({
  // Its own grid rather than `display: contents`, which leaves the element boxless and so
  // invisible to anything that asks.
  panel: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    alignContent: 'start',
    gap: '8px',
  },
  group: {
    marginBottom: 0,
  },
  groupTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '5px',
  },
  spinner: {
    width: '10px',
    height: '10px',
    borderWidth: '1.5px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderTopColor: color.glass,
    borderRadius: '50%',
    animationName: spin,
    animationDuration: '0.8s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  // Asymmetric, so a control reads as belonging with its own track rather than the one under it.
  control: {
    paddingTop: '1px',
    paddingInline: 0,
    paddingBottom: '7px',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    height: '18px',
  },
  // The width of the reset button this row has not got, so its readout lines up with theirs.
  headBare: {
    paddingRight: '24px',
  },
  // The 10px a slider's name clears its track by, which a button filling its box has to ask for.
  headAboveSelect: {
    marginBottom: '9px',
  },
  name: {
    fontSize: size.controlText,
  },
  // Tabular, or a column of numbers shuffles sideways under its own drag.
  value: {
    marginLeft: 'auto',
    color: color.boneDim,
    fontVariantNumeric: 'tabular-nums',
  },
  reset: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: { default: '18px', [COARSE]: '30px' },
    height: { default: '18px', [COARSE]: '30px' },
    padding: 0,
    borderWidth: 0,
    borderRadius: size.radius,
    backgroundColor: { default: 'transparent', ':hover': color.slate },
    color: { default: color.boneDim, ':hover': color.bone },
    cursor: 'pointer',
  },
  resetClean: {
    visibility: 'hidden',
  },
  resetIcon: {
    width: { default: null, [COARSE]: '16px' },
    height: { default: null, [COARSE]: '16px' },
  },
  resetAtEnd: {
    marginLeft: 'auto',
  },
  // Not shorter on a touch screen, where the thumb's grab is `size.controlH` tall and a shorter
  // row would overlap every thumb's target with its neighbour's.
  slider: {
    width: '100%',
    height: { default: size.controlH, '@media (pointer: fine)': '22px' },
  },
  // The full column, so the control does not change width with the ratio picked.
  selectTrigger: {
    width: '100%',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    paddingTop: '6px',
    paddingInline: 0,
    paddingBottom: '2px',
  },
  check: {
    paddingTop: '4px',
    paddingInline: 0,
    paddingBottom: '2px',
    cursor: 'pointer',
  },
  guide: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: '22px',
  },
  swatch: {
    width: '10px',
    height: '10px',
    borderRadius: '2px',
    flex: '0 0 auto',
  },
  vertical: {
    backgroundColor: overlayColour.sky,
  },
  horizontal: {
    backgroundColor: overlayColour.amber,
  },
  repairs: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginTop: '12px',
    paddingTop: '12px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
  },
  repair: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  thumbnail: {
    position: 'relative',
    width: '48px',
    height: '48px',
    padding: 0,
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: color.slate, ':hover:not(:disabled)': color.boneDim },
    borderRadius: size.radius,
    backgroundColor: color.slateSoft,
    cursor: 'pointer',
  },
  fill: {
    width: '100%',
    height: 'auto',
    aspectRatio: 1,
    color: color.boneDim,
  },
  chosen: {
    borderColor: color.satin,
    boxShadow: `0 0 0 1px ${color.satin}`,
  },
  thumbnailLayer: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
  seam: {
    fill: 'none',
    stroke: overlayColour.sky,
    strokeWidth: '1.5px',
    vectorEffect: 'non-scaling-stroke',
  },
  divider: {
    width: '100%',
    marginBlock: '4px',
    marginInline: 0,
    borderWidth: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
  },
  fills: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '8px',
  },
});
export type RawEditPanelStyles = typeof styles;
