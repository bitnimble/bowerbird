import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import type { RawEditPresenter } from './raw_edit_presenter';
import { LOUPE_SIZE, type RawEditStore } from './raw_edit_store';

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
  store: RawEditStore;
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
      className="loupe"
      data-testid="raw-edit-loupe"
      // Whether the glass is showing the export's own pixels yet, which is the difference the
      // loupe exists for and the only part of it visible from outside the canvas.
      data-tile={store.loupeSharp ? 'held' : 'none'}
      // Hidden rather than absent: the box only appears once the pointer is over the picture,
      // and a mount per pointer move would rebuild the canvas and its swapchain with it.
      style={at == null ? { visibility: 'hidden' } : { left: `${at.x}px`, top: `${at.y}px` }}
    >
      <canvas
        ref={canvas}
        className="loupe__glass"
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
      <span className="loupe__scale" data-testid="raw-edit-loupe-scale">
        {formatMagnification(store.loupeMagnification)}
        {store.loupeRendering && (
          <span className="loupe__spinner" data-testid="raw-edit-loupe-spinner" aria-label="Rendering" />
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
  return magnification < 10 ? `${magnification.toFixed(1)}x` : `${Math.round(magnification)}x`;
}
