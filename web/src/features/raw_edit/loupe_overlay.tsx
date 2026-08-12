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
      // Hidden rather than absent: the box only appears once the pointer is over the picture,
      // and a mount per pointer move would rebuild the canvas and its swapchain with it.
      style={at == null ? { visibility: 'hidden' } : { left: `${at.x}px`, top: `${at.y}px` }}
    >
      {/* The rendition's own pixels, over the tick's, once they have arrived. Two canvases
          rather than one because they are drawn by different things - the tick by WebGPU and
          this by the 2D context - and a context is claimed for the life of an element. */}
      <TileGlass store={store} />
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
      {/* Outside the box, so the number never covers the pixels it describes. */}
      <span className="loupe__scale" data-testid="raw-edit-loupe-scale">
        {formatMagnification(store.loupeMagnification)}
      </span>
    </div>
  );
});

/**
 * The tile, drawn over the tick's own render of the same place.
 *
 * **The two agree about geometry or the reader sees the picture jump.** The glass is showing a
 * `span`-wide window of the frame centred on the pointer; the tile holds some larger rectangle
 * around it. So what is drawn is the part of the tile that window covers, scaled to the glass -
 * which is the same arithmetic the tick's own draw does with its region, arrived at from the
 * other side.
 *
 * Absent until a tile has arrived, so the first look at any part of a photograph is the tick's
 * render and the sharpening comes a tenth of a second later.
 */
const TileGlass = observer(function TileGlass({ store }: { store: RawEditStore }): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null);
  const showing = store.loupeTile;

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (element == null || context == null || showing == null) return;
    const { tile, centre, span } = showing;
    context.clearRect(0, 0, element.width, element.height);
    // Nearest, not smoothed: a magnifier that interpolated would be showing its own guesses
    // where the reader is looking for the photograph's grain.
    context.imageSmoothingEnabled = false;
    context.drawImage(
      tile.bitmap,
      centre.x - span / 2 - tile.rect.left,
      centre.y - span / 2 - tile.rect.top,
      span,
      span,
      0,
      0,
      element.width,
      element.height,
    );
  }, [showing]);

  if (showing == null) return null;
  const dpr = globalThis.devicePixelRatio || 1;
  return (
    <canvas
      ref={canvas}
      className="loupe__glass loupe__glass--tile"
      data-testid="raw-edit-loupe-tile"
      width={LOUPE_SIZE * dpr}
      height={LOUPE_SIZE * dpr}
      style={{ width: `${LOUPE_SIZE}px`, height: `${LOUPE_SIZE}px` }}
    />
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
