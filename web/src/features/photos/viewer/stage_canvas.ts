import { useCallback } from 'react';
import { settingsApi } from '../../../api/settings';
import { displayIsHdr } from '../../../app/device';
import { gpuThread } from '../../../gpu/gpu_thread';
import { PaintedSchema, type Painted } from '../../../gpu/gpu_protocol';
import type { RenderingIntent } from '../../../../../src/schemas/rendering_intent';
import type { Decoded } from './stage_bitmaps';
import { SDR_WHITE_NITS, type Region } from './stage_gpu';

/** `hdr_peak_nits`'s own default, for the draw that cannot wait for the settings to arrive. */
const DEFAULT_PEAK_NITS = 1000;

/**
 * The canvas took a WebGPU context and then could not be drawn into.
 *
 * It can hold one kind of context for its whole life, so there is no falling back on this
 * element: the caller has to mount a fresh one. Distinct from a decline, which happens
 * before the context is taken and leaves the canvas free for the 2D path.
 */
export class CanvasLost extends Error {}

/** A canvas's backing store, which the page cannot set once the canvas is handed over. */
export interface CanvasSize {
  width: number;
  height: number;
}

/** One masked layer over an already-drawn canvas. */
export interface MaskedLayer {
  picture: VideoFrame;
  /** Alpha per canvas pixel, at the canvas's own size - `merge_mask.ts` rasterises it. */
  mask: OffscreenCanvas | HTMLCanvasElement;
  /** Where the picture is read for a canvas pixel, relative to it, in canvas pixels. */
  shift: readonly [number, number];
  /** What the picture's light is multiplied by. */
  gain: number;
}

/**
 * The page's canvases as the GPU thread holds them (`stage_gpu.ts`), which is where every one of
 * them is drawn: the device is the module's, and it does not leave that thread.
 *
 * **Handed over on the first paint, for good.** `transferControlToOffscreen` moves the backing
 * store and the element can never take a context on this thread again, so from then on its size
 * is set over there and every paint names it by number.
 */
class StageCanvases {
  private readonly numbered = new WeakMap<HTMLCanvasElement, number>();
  /** Let go while a paint was still waiting to send, which then has nothing to draw into. */
  private readonly released = new WeakSet<HTMLCanvasElement>();
  private counted = 0;
  private peak: Promise<number> | null = null;

  /** A decoded frame, or `region` of it, drawn into `canvas` at `size`. */
  async paint(
    canvas: HTMLCanvasElement,
    size: CanvasSize,
    frame: Decoded,
    region?: Region,
    proof: RenderingIntent | null = null,
  ): Promise<void> {
    const [headroom, sourcePeak] = await Promise.all([this.displayHeadroom(), this.renditionHeadroom()]);
    if (this.released.has(canvas)) return;
    const { id, handed } = this.handOver(canvas);
    const painted = await gpuThread().ask(
      PaintedSchema,
      {
        to: 'stage',
        ask: {
          kind: 'paint',
          canvas: id,
          handed,
          ...size,
          picture: frame.picture,
          region: region ?? null,
          rotation: frame.rotation,
          proof,
          headroom,
          sourcePeak,
        },
      },
      handed == null ? [] : [handed],
    );
    lostIf(painted);
  }

  /**
   * Draws a base layer, then a set of masked layers over it, onto one canvas - the merge page's
   * hover preview. False where the GPU thread declined it.
   */
  async paintMasked(canvas: HTMLCanvasElement, size: CanvasSize, base: VideoFrame, layers: readonly MaskedLayer[]): Promise<boolean> {
    const [headroom, masks] = await Promise.all([
      this.displayHeadroom(),
      Promise.all(layers.map((layer) => createImageBitmap(layer.mask))),
    ]);
    try {
      if (this.released.has(canvas)) return false;
      const { id, handed } = this.handOver(canvas);
      const painted = await gpuThread().ask(
        PaintedSchema,
        {
          to: 'stage',
          ask: {
            kind: 'paintMasked',
            canvas: id,
            handed,
            ...size,
            base,
            layers: layers.map((layer, at) => ({ picture: layer.picture, mask: masks[at]!, shift: [...layer.shift], gain: layer.gain })),
            headroom,
          },
        },
        [...masks, ...(handed == null ? [] : [handed])],
      );
      lostIf(painted);
      return painted === 'drawn';
    } finally {
      // Transferred where the paint was sent, which leaves these detached and the close a no-op.
      for (const mask of masks) mask.close();
    }
  }

  /** Lets a canvas go with its element. */
  release(canvas: HTMLCanvasElement): void {
    this.released.add(canvas);
    const id = this.numbered.get(canvas);
    if (id == null) return;
    this.numbered.delete(canvas);
    void gpuThread()
      .ask(PaintedSchema.nullable(), { to: 'stage', ask: { kind: 'releaseCanvas', canvas: id } })
      .catch(() => undefined);
  }

  private handOver(canvas: HTMLCanvasElement): { id: number; handed: OffscreenCanvas | null } {
    const id = this.numbered.get(canvas);
    if (id != null) return { id, handed: null };
    const numbered = ++this.counted;
    this.numbered.set(canvas, numbered);
    return { id: numbered, handed: canvas.transferControlToOffscreen() };
  }

  /**
   * How far above SDR white this draw may go.
   *
   * **One above white on an SDR screen, and that is not a detail.** The roll-off holds a
   * colour's ratios while it compresses, so aiming at a peak the display cannot reach leaves
   * the brightest pixels above what it shows and the *compositor* does the clipping - per
   * channel, which is the mauve `prelude.slang` records through a cloud top. A window dragged
   * between two screens changes the answer, so it is asked per draw rather than cached.
   *
   * The peak itself is a setting because the platform will not say: Chrome 151 exposes no
   * headroom on `screen`, and `dynamic-range` is a boolean.
   */
  private async displayHeadroom(): Promise<number> {
    if (!displayIsHdr()) return 1;
    return this.renditionHeadroom();
  }

  /**
   * How far over SDR white a rendition was graded to reach, whatever this display can show: the
   * peak the roll-off aims at, `hdr_peak_nits`.
   *
   * The editor's ceiling and not a second opinion on it (`frame.slang`'s `display_nits`), which
   * is what makes a rendition and the edit it came from agree about a highlight. Aiming lower
   * than the display can show is not merely dim: the roll-off holds a colour's ratios while it
   * compresses, so a 6x blue sky squeezed into 2x arrives as a hugely saturated blue at the
   * ceiling, and the compositor maps that to pink.
   */
  private async renditionHeadroom(): Promise<number> {
    this.peak ??= settingsApi
      .get()
      .then((settings) => settings.hdr_peak_nits)
      .catch(() => DEFAULT_PEAK_NITS);
    return (await this.peak) / SDR_WHITE_NITS;
  }
}

function lostIf(painted: Painted): void {
  if (painted === 'lost') throw new CanvasLost('this canvas took a WebGPU context it cannot be drawn into');
}

export const stageCanvases = new StageCanvases();

/**
 * A ref for a canvas the GPU thread draws, which lets the canvas go when the element does: the
 * thread holds what was handed over for as long as it is told to.
 */
export function useStageCanvas(held: { current: HTMLCanvasElement | null }): (element: HTMLCanvasElement | null) => void {
  return useCallback(
    (element: HTMLCanvasElement | null) => {
      if (held.current != null && held.current !== element) stageCanvases.release(held.current);
      held.current = element;
    },
    [held],
  );
}
