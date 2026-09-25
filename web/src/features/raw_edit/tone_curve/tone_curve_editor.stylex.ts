import * as stylex from '@stylexjs/stylex';
import { color, size } from '../../../ui/tokens.stylex';

export const styles = stylex.create({
  editor: { paddingTop: '8px' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' },
  heading: { margin: 0, color: color.bone, fontSize: size.controlText, fontWeight: 500 },
  reset: {
    padding: '3px',
    border: 0,
    borderRadius: size.radius,
    backgroundColor: { default: 'transparent', ':hover': color.slate },
    color: color.boneDim,
    cursor: 'pointer',
  },
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
  grid: { stroke: color.slate, strokeWidth: 0.5, pointerEvents: 'none' },
  reference: { stroke: color.boneDim, strokeWidth: 0.6, opacity: 0.45, pointerEvents: 'none' },
  white: { stroke: color.glass, strokeWidth: 0.7, opacity: 0.6, pointerEvents: 'none' },
  curve: { fill: 'none', stroke: color.bone, strokeWidth: 1.2, pointerEvents: 'none' },
  pointTarget: {
    fill: 'transparent',
    cursor: 'grab',
  },
  point: { fill: color.bone, stroke: color.field, strokeWidth: 0.8, pointerEvents: 'none' },
  disabled: { opacity: 0.4, cursor: 'default' },
});
