import * as stylex from '@stylexjs/stylex';
import { useRef } from 'react';
import { focusRing } from './focus_ring';
import { stopFlings } from './stop_flings';
import { color, size } from './tokens.stylex';

const COARSE = '@media (pointer: coarse)';
const GRAB_LENGTH = '36px';

const styles = stylex.create({
  edge: {
    position: 'absolute',
    touchAction: 'none',
    '::after': {
      content: '""',
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      borderRadius: size.radius,
      backgroundColor: { default: color.satin, [COARSE]: color.boneDim },
      transitionProperty: 'width, height',
      transitionDuration: '150ms',
      transitionTimingFunction: 'ease',
    },
  },
  sideways: {
    cursor: 'col-resize',
    '::after': {
      height: { default: '100%', [COARSE]: GRAB_LENGTH },
      // Drawn from the start under a finger, which has no hover to reveal it with.
      width: { default: 0, [COARSE]: '4px', ':hover': '3px', ':focus-visible': '3px' },
    },
  },
  upDown: {
    cursor: 'row-resize',
    '::after': {
      width: { default: '100%', [COARSE]: GRAB_LENGTH },
      height: { default: 0, [COARSE]: '4px', ':hover': '3px', ':focus-visible': '3px' },
    },
  },
});

/**
 * A panel's edge, dragged or nudged with the arrow keys. `axis` is the way the edge moves;
 * `grows` is which way along it makes the panel bigger. The caller places it.
 */
export function EdgeResizer({
  axis,
  grows,
  value,
  min,
  max,
  label,
  onResize,
  onNudge,
  onDoubleClick,
  style,
}: {
  axis: 'x' | 'y';
  grows: 1 | -1;
  value: number;
  min: number;
  max: number;
  label: string;
  onResize: (value: number) => void;
  onNudge: (steps: number) => void;
  onDoubleClick?: () => void;
  style?: stylex.StyleXStyles;
}): JSX.Element {
  // Delta from the grab point: the far edge's distance would need a layout read per move.
  const grabbed = useRef({ x: 0, y: 0, value: 0, axis });
  const hold = (e: { clientX: number; clientY: number }): void => {
    grabbed.current = { x: e.clientX, y: e.clientY, value, axis };
  };

  return (
    <div
      ref={stopFlings}
      {...stylex.props(
        styles.edge,
        // The `::after` bar marks focus.
        focusRing.none,
        axis === 'x' ? styles.sideways : styles.upDown,
        style,
      )}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        // Without this the drag selects the text behind the edge instead of moving it.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        hold(e);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        // A drag can swap the panel's edge (`stripEdge`); restart the delta on the new axis.
        if (grabbed.current.axis !== axis) hold(e);
        const moved = axis === 'x' ? e.clientX - grabbed.current.x : e.clientY - grabbed.current.y;
        onResize(grabbed.current.value + grows * moved);
      }}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        if (e.key !== forward && e.key !== back) return;
        e.preventDefault();
        onNudge((e.key === forward ? 1 : -1) * grows);
      }}
    />
  );
}
