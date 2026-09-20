import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { font } from '../../../ui/tokens.stylex';
import { LoupeOverlayStrings } from './loupe_overlay.strings';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import { LOUPE_SIZE } from './loupe_store';
import type { LoupeStore } from './loupe_store';

const spin = stylex.keyframes({ to: { rotate: '360deg' } });

const styles = stylex.create({
  // Centred on the pointer by a translate: the store holds where the reader points, and how the
  // box hangs off that point is presentation.
  loupe: {
    position: 'absolute',
    transform: 'translate(-50%, -50%)',
    // Over the picture and under nothing: the overlays sharing this stage are the geometry tools,
    // and neither is open while the loupe is.
    zIndex: 3,
    // A hit test landing on the glass would stop the pointer moves that move it.
    pointerEvents: 'none',
  },
  glass: {
    display: 'block',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgb(255 255 255 / 65%)',
    // Dark: a light surround shifts what the eye calls noise.
    backgroundColor: '#000',
    boxShadow: '0 2px 12px rgb(0 0 0 / 55%)',
  },
  scale: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: '4px',
    paddingBlock: '1px',
    paddingInline: '6px',
    borderRadius: '3px',
    backgroundColor: 'rgb(0 0 0 / 70%)',
    color: '#fff',
    fontFamily: font.mono,
    fontSize: '11px',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },
  spinner: {
    display: 'inline-block',
    width: '9px',
    height: '9px',
    marginLeft: '5px',
    verticalAlign: '-1px',
    borderWidth: '1.5px',
    borderStyle: 'solid',
    borderColor: 'rgb(255 255 255 / 35%)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animationName: spin,
    animationDuration: '0.8s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
});

/**
 * The magnifier that follows the pointer.
 *
 * A canvas of its own rather than a scaled copy of the stage's: the tick draws whatever
 * rectangle it is given, so magnifying is drawing a smaller rectangle onto the same number of
 * pixels - the photograph's own, at the size the reader asked for, rather than a raster blown
 * up. The same grade, from the same frame, through the same shaders.
 *
 * **Centred on the pointer, which the pointer is then hidden under.** A loupe that sat beside
 * the cursor would leave the reader aiming at a point they cannot see the magnification of, and
 * an arrow drawn over the middle of it would cover the pixels being judged.
 */
export const LoupeOverlay = observer(function LoupeOverlay({
  store,
  presenter,
}: {
  store: LoupeStore;
  presenter: RawEditPresenter;
}): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!store.loupeOpen) return;
    presenter.attachLoupe(canvas.current);
    return () => presenter.attachLoupe(null);
  }, [presenter, store.loupeOpen]);

  if (!store.loupeOpen) return null;
  const at = store.loupeAt;

  return (
    <div
      {...stylex.props(styles.loupe)}
      // Hidden rather than absent: the box only appears once the pointer is over the picture,
      // and a mount per pointer move would rebuild the canvas and its swapchain with it.
      style={at == null ? { visibility: 'hidden' } : { left: `${at.x}px`, top: `${at.y}px` }}
    >
      <canvas
        ref={canvas}
        {...stylex.props(styles.glass)}
        role="img"
        aria-label={LoupeOverlayStrings.magnified()}
        // The backing store is the box, in device pixels, so one loupe pixel is one drawn
        // pixel - a magnifier that resampled its own output would be answering a different
        // question from the one it was asked.
        width={LOUPE_SIZE * (globalThis.devicePixelRatio || 1)}
        height={LOUPE_SIZE * (globalThis.devicePixelRatio || 1)}
        style={{ width: `${LOUPE_SIZE}px`, height: `${LOUPE_SIZE}px` }}
      />
      {/* Outside the box, so neither the number nor the spinner covers the pixels they
          describe. The spinner says the glass is still showing the tick's own render and the
          export's is on its way - which is worth saying, because the two differ in exactly the
          thing a reader opens a loupe to judge. */}
      <span {...stylex.props(styles.scale)}>
        {formatMagnification(store.loupeMagnification)}
        {store.loupeRendering && (
          <span {...stylex.props(styles.spinner)} role="status" aria-label={LoupeOverlayStrings.rendering()} />
        )}
      </span>
    </div>
  );
});

/**
 * The magnification, as a reader of a lens would say it.
 *
 * A decimal below ten and a whole number above it: the difference between 11x and 11.4x is not
 * one anybody acts on, where the one between 1.5x and 2x is the reason they turned the wheel.
 */
function formatMagnification(magnification: number): string {
  return LoupeOverlayStrings.magnification(magnification < 10 ? magnification.toFixed(1) : String(Math.round(magnification)));
}
