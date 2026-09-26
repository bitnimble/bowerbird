import * as stylex from '@stylexjs/stylex';
import { color, size } from '../../../ui/tokens.stylex';

export const pointMarker = stylex.defineMarker();

export const styles = stylex.create({
  editor: { paddingTop: '8px' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' },
  heading: { margin: 0, color: color.bone, fontSize: size.controlText, fontWeight: 500 },
  plot: {
    display: 'block',
    width: '100%',
    aspectRatio: '1',
    overflow: 'hidden',
    borderRadius: size.radius,
    backgroundColor: color.field,
    touchAction: 'none',
    cursor: 'crosshair',
  },
  grid: { stroke: color.slate, strokeWidth: '0.5px', vectorEffect: 'non-scaling-stroke', pointerEvents: 'none' },
  reference: { stroke: color.boneDim, strokeWidth: 0.6, opacity: 0.45, pointerEvents: 'none' },
  white: { stroke: color.glass, strokeWidth: 0.7, opacity: 0.6, pointerEvents: 'none' },
  curve: { fill: 'none', stroke: color.bone, strokeWidth: '3px', vectorEffect: 'non-scaling-stroke', pointerEvents: 'none' },
  pointTarget: {
    fill: 'transparent',
    cursor: 'grab',
    outline: 'none',
  },
  point: {
    fill: {
      default: color.bone,
      [stylex.when.ancestor(':has(:focus-visible)', pointMarker)]: color.satin,
    },
    r: `calc(${size.thumb} / 2)`,
    pointerEvents: 'none',
    transitionProperty: 'fill',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease',
  },
  pointActive: { fill: color.satin },
  disabled: { opacity: 0.4, cursor: 'default' },
});
