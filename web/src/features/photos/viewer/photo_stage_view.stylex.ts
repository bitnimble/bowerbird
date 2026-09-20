import * as stylex from '@stylexjs/stylex';
import { color, font } from '../../../ui/tokens.stylex';

export const styles = stylex.create({
  fullscreen: {
    backgroundColor: '#000',
  },
  viewportFullscreen: {
    height: '100vh',
  },
  detail: {
    position: 'absolute',
    display: 'block',
    pointerEvents: 'none',
  },
  picture: {
    position: 'absolute',
    inset: 0,
    transformOrigin: 'center center',
    pointerEvents: 'none',
  },
  // A resting state rather than where an animation leaves it, so it holds under reduced motion and
  // when stepping back reaches a picture lower in the stack.
  leaving: {
    opacity: 0,
  },
  pending: {
    display: 'grid',
    placeItems: 'center',
    width: '100%',
    height: '100%',
    fontFamily: font.mono,
    fontSize: '10px',
    letterSpacing: '0.08em',
    color: '#4a505c',
    textTransform: 'uppercase',
  },
  status: {
    position: 'absolute',
    margin: '8px',
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingBlock: '5px',
    paddingInline: '10px',
    borderRadius: '999px',
    backgroundColor: 'rgba(10, 12, 16, 0.72)',
    pointerEvents: 'none',
  },
  statusText: {
    color: color.bone,
    fontSize: '11px',
  },
  bar: {
    position: 'absolute',
    left: '50%',
    bottom: '22px',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    paddingBlock: '7px',
    paddingInline: '12px',
    borderRadius: '6px',
    backgroundColor: 'rgba(14, 16, 20, 0.72)',
    backdropFilter: 'blur(6px)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(232, 228, 218, 0.14)',
    opacity: 0,
    transition: 'opacity 160ms ease',
    pointerEvents: 'none',
  },
  barVisible: {
    opacity: 1,
    pointerEvents: 'auto',
  },
});

