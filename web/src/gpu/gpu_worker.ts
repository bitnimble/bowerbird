/// <reference lib="webworker" />
import init, {
  type HeldRaw,
  finishDraw,
  holdPicture,
  holdPlanes,
  holdPmridWeights,
  holdRaw,
  pageDevice,
  renderRendition,
} from '../../../native/rawshim/pkg/rawshim';
import { pmridWeightsUrl } from '../../../native/rawshim/pkg/pmrid_weights';
import { z } from 'zod';
import type { OpenAsk, PrepareCrossing } from '../features/raw_edit/local_decode/local_open';
import { cachedRecipes, PipelineWarmth } from '../features/raw_edit/stage/pipeline_warmth';
import { planarLayout } from '../features/photos/viewer/planar_layout';
import { WebCodecs } from '../features/photos/viewer/image_decoder';
import { StagePainter } from '../features/photos/viewer/stage_gpu';
import { AnswerSchema, MessageSchema, ProgressSchema, type Message } from './gpu_protocol';

/** The other half of `GpuThread`, which says why the module is over here. */

const worker = self as unknown as DedicatedWorkerGlobalScope;

new PipelineWarmth(cachedRecipes()).install(worker);

const device: Promise<GPUDevice | null> = openDevice();
const painter: Promise<StagePainter> = device.then((opened) => new StagePainter(opened));
const opens = new Map<number, Open>();
let weights: Promise<void> | null = null;

const IdSchema = z.object({ id: z.number() });

worker.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
  const { id } = IdSchema.parse(event.data);
  const report = (stage: string): void => worker.postMessage(ProgressSchema.parse({ id, stage }));
  try {
    const { value, transfer } = await answer(MessageSchema.parse(event.data), report);
    worker.postMessage(AnswerSchema.parse({ id, ok: true, value }), transfer ?? []);
  } catch (error) {
    worker.postMessage(
      AnswerSchema.parse({ id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  }
};

/**
 * The one device, opened before anything is answered so that every later call finds it rather
 * than two arriving together each opening their own. Null where the browser has no adapter, and
 * photographs are then drawn in 2D.
 */
async function openDevice(): Promise<GPUDevice | null> {
  await init();
  // Asked here first: wgpu's page backend never settles when the adapter comes back null.
  if ((await navigator.gpu?.requestAdapter()) == null) return null;
  return (pageDevice() as Promise<GPUDevice | null>).catch(() => null);
}

type Report = (stage: string) => void;

async function answer(message: Message, report: Report): Promise<{ value: unknown; transfer?: Transferable[] }> {
  await device;
  switch (message.to) {
    case 'stage':
      return { value: await (await painter).answer(message.ask) };
    case 'close':
      opens.get(message.session)?.close();
      opens.delete(message.session);
      return { value: null };
    case 'open': {
      let open = opens.get(message.session);
      if (open == null) {
        open = new Open();
        opens.set(message.session, open);
      }
      return open.answer(message.ask, report);
    }
  }
}

/** One photograph opened on this thread: what `LocalDecoder` holds a session of. */
class Open {
  /** The RAW this open was given, kept so a tile costs neither a download nor a copy. */
  private raw: Uint8Array | null = null;
  /**
   * The same photograph opened as far as the mosaic, which is what a Detail or dust slider re-runs
   * from - and what holds the particle detection, so only the first prepare that switches dust on
   * pays for looking.
   *
   * Freed and rebuilt when the open's other settings move, since everything above the mosaic was
   * decided with them.
   */
  private held: { held: HeldRaw; request: string } | null = null;
  private closed = false;

  close(): void {
    this.closed = true;
    this.raw = null;
    this.release();
  }

  async answer(ask: OpenAsk, report: Report): Promise<{ value: unknown; transfer?: Transferable[] }> {
    switch (ask.kind) {
      case 'hold':
        this.raw = ask.raw;
        this.release();
        return { value: null };
      case 'render': {
        // wasm-bindgen copies a returned Vec out into a fresh ArrayBuffer; its d.ts just does not say so.
        const framed = (await renderRendition(ask.raw, ask.job)) as Uint8Array<ArrayBuffer>;
        const zipped = new Blob([framed]).stream().pipeThrough(new CompressionStream('gzip'));
        const value = new Uint8Array(await new Response(zipped).arrayBuffer());
        return { value, transfer: [value.buffer] };
      }
      case 'prepare':
        return { value: await this.preparedAt(ask.request, ask.mosaic, report) };
      case 'holdPicture':
        return { value: await this.pictureAt(ask.framed, ask.request) };
      case 'holdRendition':
        return { value: await this.renditionAt(ask.avif, ask.request, report) };
      case 'takePicture':
        // The same open, a different picture of it: the stage stays where it was transferred.
        return { value: this.drawing().takePicture(ask.framed) };
      case 'takeTiles':
        return { value: this.drawing().takeTiles(ask.framed, ask.asked) };
      case 'showTiles':
        return { value: JSON.parse(this.drawing().showTiles(ask.level, ask.rect)) };
      case 'picturePart':
        return { value: JSON.parse(this.drawing().picturePart(ask.region)) };
      case 'attach': {
        const editor = this.drawing();
        if (ask.which === 'stage') editor.attachStage(ask.canvas, ask.width, ask.height);
        else editor.attachLoupe(ask.canvas, ask.width, ask.height);
        return { value: null };
      }
      case 'releaseLoupe':
        this.drawing().releaseLoupe();
        return { value: null };
      case 'holdTile':
        return { value: JSON.parse(await this.drawing().holdTile(ask.request)) };
      case 'releaseTile':
        this.drawing().releaseTile();
        return { value: null };
      case 'analysis': {
        // Spread to plain numbers, as `LocalOpen.photoAnalysis` is: this goes back out inside a
        // request that crosses as JSON, and a `Uint8Array` stringifies to an object of numeric keys
        // that the far side rejects as malformed.
        const bytes = this.held?.held.analysis();
        return { value: bytes == null ? null : [...bytes] };
      }
      case 'bandInto': {
        await networkWeights(ask.mosaic.denoiser);
        const { enabled, sensitivity, intensity } = ask.mosaic.dust;
        await this.drawing().bandInto(
          ask.mosaic.luminance,
          ask.mosaic.colour,
          ask.mosaic.denoiser,
          ask.mosaic.sharpen,
          enabled,
          sensitivity,
          intensity,
          ask.top,
          ask.rows,
          ask.frame[0],
          ask.frame[1],
          ask.mosaic.repairs,
        );
        return { value: null };
      }
      case 'redrawRepairs':
        this.drawing().redrawRepairs(ask.repairs);
        return { value: null };
      case 'refreshDetail':
        this.drawing().refreshDetail();
        return { value: null };
      case 'solveRepair':
        return {
          value: JSON.parse(
            await this.drawing().solveRepair(
              ask.drawn,
              ask.others,
              ask.grow,
              ask.without ?? undefined,
              ask.donor ?? undefined,
            ),
          ),
        };
      case 'setRepairs':
        return { value: JSON.parse(this.drawing().setRepairs(ask.repairs)) };
      case 'dropTiles':
        this.drawing().dropTiles();
        return { value: null };
      case 'setSearched':
        return { value: JSON.parse(this.drawing().setSearched(ask.drawn, ask.donor ?? undefined)) };
      case 'pictureOfOutput':
        return { value: JSON.parse(this.drawing().pictureOfOutput(ask.geometry, ask.points)) };
      case 'outputOfPicture':
        return { value: JSON.parse(this.drawing().outputOfPicture(ask.geometry, ask.points)) };
      case 'repairThumbnail': {
        const canvas = new OffscreenCanvas(ask.side, ask.side);
        this.drawing().drawThumbnail(canvas, ask.side, ask.ev, ask.region, ask.repair);
        return { value: await eightBitPng(canvas) };
      }
      case 'optionThumbnail': {
        const canvas = new OffscreenCanvas(ask.side, ask.side);
        this.drawing().drawOptionThumbnail(canvas, ask.side, ask.ev, ask.region, ask.showing ?? undefined, ask.option);
        return { value: await eightBitPng(canvas) };
      }
      case 'tick': {
        const editor = this.drawing();
        // The size first: the draw below reads the backing store this settles, and a stage sized
        // after it draws is a picture stretched across the shape it had before.
        if (ask.stage != null) editor.resizeStage(ask.stage.width, ask.stage.height);
        if (ask.adjust != null) editor.setAdjust(ask.adjust);
        if (ask.geometry != null) editor.setGeometry(ask.geometry);
        if (ask.proof != null) editor.setProof(ask.proof.output, ask.proof.intent, ask.proof.displayHdr);
        if (ask.printerProfile !== undefined) editor.setPrinterProfile(ask.printerProfile ?? undefined);
        editor.setPrint(ask.print == null ? undefined : JSON.stringify(ask.print));
        if (ask.drawStage) editor.tick(ask.ev, ask.region ?? undefined);
        if (ask.loupe != null) editor.tickLoupe(ask.ev, ask.loupe);
        await finishDraw();
        return { value: null };
      }
    }
  }

  private heldRaw(): Uint8Array {
    if (this.raw == null) throw new Error('this decoder was given no RAW to read');
    return this.raw;
  }

  private release(): void {
    this.held?.held.free();
    this.held = null;
  }

  /**
   * The open holding this photograph's frame, which is what the canvases draw from.
   *
   * A canvas or a tick arriving before the first prepare is a page asking for a picture of nothing,
   * so it says so rather than drawing an empty canvas.
   */
  private drawing(): HeldRaw {
    if (this.held == null) throw new Error('no photograph is open to draw');
    return this.held.held;
  }

  /**
   * Keeps what an open just built, unless the page closed it while it was being built: nothing
   * else would ever free it.
   */
  private keep(held: HeldRaw, request: string): HeldRaw {
    if (this.closed) {
      held.free();
      throw new Error('this decoder was closed');
    }
    this.release();
    this.held = { held, request };
    return held;
  }

  /**
   * The prepared frame at these mosaic settings, off a photograph held at the mosaic.
   *
   * **The held open is keyed on everything else in the request.** Only these are applied below the
   * mosaic; the size, the grade and the camera match were all decided above it, so a request that
   * changes one of those is a different open and the old one is freed rather than reused.
   *
   * They are arguments rather than fields of the request for exactly that reason: in the JSON they
   * would change the key on every slider move and rebuild the open each time, which is the cost this
   * exists to avoid - and for dust that would also throw away the particle detection, which is the
   * expensive half and does not depend on any of them.
   */
  private async preparedAt(request: string, mosaic: PrepareCrossing, report: Report): Promise<string> {
    await networkWeights(mosaic.denoiser);
    if (this.held?.request !== request) this.release();
    const held = this.held?.held ?? this.keep(await holdRaw(this.heldRaw(), request, report), request);
    const { enabled, sensitivity, intensity } = mosaic.dust;
    return held.prepare(
      mosaic.luminance,
      mosaic.colour,
      mosaic.denoiser,
      mosaic.sharpen,
      enabled,
      sensitivity,
      intensity,
      mosaic.repairs,
      report,
    );
  }

  /**
   * The same open, from a picture that arrived coded.
   *
   * **Not keyed, because there is nothing to re-run.** A held mosaic exists so a Detail amount costs
   * a denoise rather than a decode; a picture prepared elsewhere has no mosaic here, so a new amount
   * is a new prepare on the far side and arrives as new bytes. Whatever was open is freed and this
   * replaces it.
   */
  private async pictureAt(framed: Uint8Array, request: string): Promise<string> {
    this.release();
    // The header the module answers `prepare` with, which this one already computed: what came back
    // with the samples, read on the side that knows the framing.
    return this.keep(await holdPicture(framed, request), request).header();
  }

  /**
   * The same open, from a rendition this browser decodes, so what crosses the network is the file
   * rather than the samples the server would decode it to. Null where the decode is not planar PQ.
   */
  private async renditionAt(avif: Uint8Array<ArrayBuffer>, request: string, report: Report): Promise<string | null> {
    report('decoding');
    const planes = await decodedPlanes(avif);
    if (planes == null) return null;
    this.release();
    const held = this.keep(await holdPlanes(avif, planes.samples, JSON.stringify(planes.layout), request), request);
    return held.prepare(undefined, undefined, 'galosh', 0, false, 0, 0, '[]', report);
  }
}

/** A thumbnail the module drew, as an 8-bit sRGB PNG. */
async function eightBitPng(drawn: OffscreenCanvas): Promise<Blob> {
  // The drawn canvas is float16 and encodes as a 16-bit PNG, and in Chrome on Windows one of those
  // leaving the page drops the stage's canvas to SDR for as long as it keeps redrawing.
  const flat = new OffscreenCanvas(drawn.width, drawn.height);
  const context = flat.getContext('2d');
  if (context == null) throw new Error('this worker would not open a 2D canvas for a thumbnail');
  // Before any await: the drawn canvas's image expires when the current event-loop task ends.
  context.drawImage(drawn, 0, 0);
  return flat.convertToBlob();
}

/**
 * PMRID's weights, fetched once for the tab the first time a reader asks for that filter.
 *
 * **Four megabytes the module does not carry**, so they are cached under a name of their own and a
 * reader who stays on GALOSH never asks for them. Awaited before the prepare that needs them
 * rather than at startup: the module answers nothing until they are in, and an open on the other
 * filter should not wait for a download it will not read.
 */
async function networkWeights(denoiser: PrepareCrossing['denoiser']): Promise<void> {
  if (denoiser !== 'pmrid') return;
  weights ??= fetch(pmridWeightsUrl)
    .then(async (answer) => {
      if (!answer.ok) throw new Error(`${answer.status} ${answer.statusText}`);
      holdPmridWeights(new Uint8Array(await answer.arrayBuffer()));
    })
    .catch((why: unknown) => {
      // Cleared, or the tab is stuck on one failed fetch for the rest of its life.
      weights = null;
      throw why;
    });
  await weights;
}

/** `crate::planes::Layout`. */
type PlanesLayout = {
  width: number;
  height: number;
  bits: 10 | 12;
  subsampled: boolean;
  planes: { offset: number; stride: number }[];
};

async function decodedPlanes(avif: Uint8Array<ArrayBuffer>): Promise<{ samples: Uint8Array; layout: PlanesLayout } | null> {
  if (WebCodecs == null) return null;
  const decoder = new WebCodecs({ data: avif, type: 'image/avif' });
  try {
    // A file this browser will not decode is one the server can still prepare.
    const decoded = await decoder.decode().catch(() => null);
    if (decoded == null) return null;
    const { image } = decoded;
    try {
      const layout = planarLayout(image);
      if (layout == null) return null;
      const samples = new Uint8Array(image.allocationSize());
      const planes = await image.copyTo(samples);
      return {
        samples,
        layout: {
          width: image.displayWidth,
          height: image.displayHeight,
          bits: layout.depth === 4 ? 12 : 10,
          subsampled: layout.chroma < 1,
          planes: planes.slice(0, 3).map(({ offset, stride }) => ({ offset, stride })),
        },
      };
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}
