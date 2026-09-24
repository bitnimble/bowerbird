import { rasteriseMask } from './merge_mask';
import type { DrawnLayer } from './merge_layers';
import { PREVIEW_HOLDER, type Compositor } from './merge_presenter';
import { decodeFrame, keepOnly, releaseHolder, type Decoded } from '../viewer/stage_bitmaps';
import { type CanvasSize, stageCanvases } from '../viewer/stage_canvas';

/**
 * The real `Compositor`: a fresh one per canvas mount, exactly like the viewer's frames.
 *
 * **One paint at a time, and only the newest waiting.** A paint copies every layer's planes out
 * before it touches the canvas, so two started together finish in whichever order the copies do,
 * and a hover run across the swatches would end on a swatch the pointer already left.
 */
export class MergeStage implements Compositor {
  private painting = false;
  private waiting: { base: number; layers: DrawnLayer[] } | { url: string } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** The analysis plane's, which the canvas is drawn at. */
    private readonly size: () => CanvasSize,
    private readonly layers: ReadonlyMap<number, Decoded>,
  ) {}

  draw(base: number, layers: DrawnLayer[]): void {
    // The render this replaces is a picture of picks the reader has already moved past.
    releaseHolder(PREVIEW_HOLDER);
    this.waiting = { base, layers };
    if (!this.painting) void this.paintWaiting();
  }

  drawSettled(url: string): void {
    this.waiting = { url };
    if (!this.painting) void this.paintWaiting();
  }

  private async paintWaiting(): Promise<void> {
    this.painting = true;
    try {
      while (this.waiting != null) {
        const asked = this.waiting;
        this.waiting = null;
        const painting = 'url' in asked ? this.paintSettled(asked.url) : this.paint(asked.base, asked.layers);
        await painting.catch(() => undefined);
      }
    } finally {
      this.painting = false;
    }
  }

  /** The server's own render of these picks, which needs no mask: it is the whole picture. */
  private async paintSettled(url: string): Promise<void> {
    // Held before the decode, so a render landing after the next pick is swept rather than drawn.
    keepOnly(PREVIEW_HOLDER, [url]);
    const settled = await decodeFrame(url);
    const size = this.size();
    if (this.waiting != null || settled.closed || !isFrame(settled.picture) || isEmpty(size)) return;
    await stageCanvases.paintMasked(this.canvas, size, settled.picture, []);
  }

  private async paint(base: number, layers: DrawnLayer[]): Promise<void> {
    const baseLayer = this.layers.get(base);
    const size = this.size();
    if (baseLayer == null || baseLayer.closed || !isFrame(baseLayer.picture) || isEmpty(size)) return;
    const masked = layers.flatMap((layer) => {
      const decoded = this.layers.get(layer.source);
      if (decoded == null || decoded.closed || !isFrame(decoded.picture)) return [];
      return [
        {
          picture: decoded.picture,
          mask: rasteriseMask(size.width, size.height, layer.mask, layer.feather),
          shift: layer.shift,
          gain: layer.gain,
        },
      ];
    });
    await stageCanvases.paintMasked(this.canvas, size, baseLayer.picture, masked);
  }
}

/** Before the analysis plane is known. */
function isEmpty(size: CanvasSize): boolean {
  return size.width === 0 || size.height === 0;
}

function isFrame(picture: ImageBitmap | VideoFrame): picture is VideoFrame {
  return typeof VideoFrame === 'function' && picture instanceof VideoFrame;
}
