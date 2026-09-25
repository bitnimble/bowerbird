import * as stylex from '@stylexjs/stylex';
import { size } from '../../../ui/tokens.stylex';

export const stageStyles = stylex.create({
  stage: {
    position: 'relative',
    overflow: 'hidden',
    minHeight: 0,
  },
  viewport: {
    position: 'relative',
    height: '100%',
    overflow: 'hidden',
    touchAction: 'none',
  },
  // object-fit rather than max-width/max-height: a percentage max-height on a grid item does not
  // reliably clamp, and a portrait frame then overflowed the stage and got cropped.
  content: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
    cursor: 'zoom-in',
    userSelect: 'none',
    opacity: 0,
  },
  // The frame on screen takes the pointer and nothing else does: the neighbours and the other
  // renditions are stacked over it, and left hit-testable they take the pan instead.
  ready: {
    opacity: 1,
    pointerEvents: 'auto',
  },
  // Needs `stylex.defaultMarker()` on the viewport.
  zoomed: {
    cursor: { default: 'grab', [stylex.when.ancestor(':active')]: 'grabbing' },
  },
  tools: {
    position: 'absolute',
    right: '8px',
    top: '8px',
    zIndex: 3,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    backgroundColor: 'rgba(10, 12, 16, 0.7)',
    borderRadius: size.radius,
    padding: '2px',
  },
  busy: {
    position: 'absolute',
    inset: 0,
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    backgroundColor: 'rgba(10, 12, 16, 0.6)',
    pointerEvents: 'none',
  },
  // Takes the pointer, which a failed open leaves nothing under to want, so its reason can be copied.
  failed: {
    pointerEvents: 'auto',
    userSelect: 'text',
    cursor: 'text',
  },
});
