/// <reference lib="webworker" />
import init, {
  type HeldRaw,
  type KeptStage,
  buildEveryPipeline,
  finishDraw,
  holdBuffers,
  holdPicture,
  holdPixels,
  holdPlanes,
  holdPmridWeights,
  holdPrintEnvironment,
  holdRaw,
  pageDevice,
  releaseBuffers,
  renderRendition,
} from '../../../native/rawshim/pkg/rawshim';
import { pmridWeightsUrl } from '../../../native/rawshim/pkg/pmrid_weights';
import { printEnvironmentUrls } from '../../../native/rawshim/pkg/print_environments';
import type { Environment } from '../features/raw_edit/print/print_scene';
import { z } from 'zod';
import type { OpenAsk, PrepareCrossing } from '../features/raw_edit/local_decode/local_open';
import { PortedFiles } from '../app/local_setting';
import { PipelineWarmth, storedRecipes } from '../features/raw_edit/stage/pipeline_warmth';
import { planarLayout } from '../features/photos/viewer/planar_layout';
import { WebCodecs } from '../features/photos/viewer/image_decoder';
import { pipelinesFor, StagePainter } from '../features/photos/viewer/stage_gpu';
import {
  AnswerSchema,
  CompiledSchema,
  FilesMessageSchema,
  MessageSchema,
  ProgressSchema,
  type Message,
} from './gpu_protocol';
import { canDecodeAvifPlanes, decodeAvifPlanes, type PlanarPicture } from '../avif/avif_planes';
import { pageLog } from '../features/logs/page_log';
import { KeptStages } from './kept_stages';

pageLog.follow('worker');

/** The other half of `GpuThread`, which says why the module is over here. */

const worker = self as unknown as DedicatedWorkerGlobalScope;

const filesPort = Promise.withResolvers<MessagePort>();
const warmth = new PipelineWarmth(storedRecipes(new PortedFiles(filesPort.promise)));
warmth.install(worker);

const device: Promise<GPUDevice | null> = openDevice();
const painter: Promise<StagePainter> = device.then((opened) => new StagePainter(opened));
const opens = new Map<number, Open>();
/** An ask waiting out the warmth resumes after a close posted behind it, and would open it again. */
const closed = new Set<number>();
let weights: Promise<void> | null = null;
const environments = new Map<Environment, Promise<void>>();
let lost: string | null = null;
const stages = new KeptStages<KeptStage>(free);
void device.then((opened) =>
  opened?.lost.then((info) => {
    lost = info.message;
    // A closing open keeps no stage once the device is gone, so nothing would wake these.
    stages.abandon();
  }),
);

const IdSchema = z.object({ id: z.number() });

worker.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
  const { id } = IdSchema.parse(event.data);
  const files = FilesMessageSchema.safeParse(event.data);
  // Ahead of `answer`, which waits for the device, which waits for recipes read through this.
  if (files.success) {
    filesPort.resolve(files.data.port);
    return;
  }
  const report = (stage: string): void => worker.postMessage(ProgressSchema.parse({ id, stage }));
  const compiled = (done: number, of: number): void =>
    worker.postMessage(CompiledSchema.parse({ id, compiled: done, of }));
  try {
    const { value, transfer } = await answer(MessageSchema.parse(event.data), report, compiled);
    worker.postMessage(AnswerSchema.parse({ id, ok: true, value }), transfer ?? []);
  } catch (error) {
    worker.postMessage(
      AnswerSchema.parse({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
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

async function answer(
  message: Message,
  report: Report,
  compiled: (done: number, of: number) => void,
): Promise<{ value: unknown; transfer?: Transferable[] }> {
  const opened = await device;
  // wgpu unwraps what a lost device refuses, so past this point every call would panic as `unreachable`.
  if (lost != null && message.to !== 'close')
    throw new Error(`the GPU was reset (${lost}); reload the page`);
  switch (message.to) {
    case 'stage': {
      const value = await (await painter).answer(message.ask);
      if (value == null || typeof value === 'string') return { value };
      return { value, transfer: ['words' in value ? value.words.buffer : value.bitmap] };
    }
    case 'close': {
      const kept = opens.get(message.session)?.close();
      opens.delete(message.session);
      closed.add(message.session);
      if (kept != null) {
        if (message.keepStage == null) free(kept);
        else stages.keep(message.keepStage, kept);
      }
      return { value: null };
    }
    case 'keepSurface':
      holdBuffers();
      return { value: null };
    case 'dropSurface':
      stages.drop(message.key);
      releaseBuffers();
      return { value: null };
    case 'precompile': {
      if (opened == null) return { value: null };
      // Without its weights PMRID builds nothing, and compiles on its first denoise instead.
      await networkWeights('pmrid').catch(() => undefined);
      pipelinesFor(opened);
      await warmth.precompile(buildEveryPipeline, compiled);
      return { value: null };
    }
    case 'open': {
      // A draw reaching a pipeline still warming would compile it again, synchronously, and freeze
      // every page while it did. Never for a canvas, which draws nothing: queued behind the warmth,
      // a close posted after it lands first and the transferred canvas is lost with the session.
      if (message.ask.kind !== 'attach') await warmth.settled();
      if (closed.has(message.session)) throw new Error('this decoder was closed');
      let open = opens.get(message.session);
      if (open == null) {
        open = new Open();
        opens.set(message.session, open);
      }
      return open.answer(message.ask, report);
    }
  }
}

/** Freeing into a lost device panics like any other call; the reload reclaims it instead. */
function free(value: { free(): void }): void {
  if (lost == null) value.free();
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
  /** Asks still running, which may be suspended inside a `HeldRaw` method. */
  private asking = 0;
  /**
   * What was let go while an ask was running, freed once none is: an async method of a freed
   * `HeldRaw` throws when it next resumes, outside any ask, and takes the worker down with it.
   */
  private retired: HeldRaw[] = [];

  /** Frees everything but the stage, which is handed back for the next open to draw onto. */
  close(): KeptStage | null {
    this.closed = true;
    this.raw = null;
    const stage = lost == null ? (this.held?.held.takeStage() ?? null) : null;
    this.release();
    return stage;
  }

  async answer(
    ask: OpenAsk,
    report: Report,
  ): Promise<{ value: unknown; transfer?: Transferable[] }> {
    this.asking += 1;
    try {
      return await this.answered(ask, report);
    } finally {
      this.asking -= 1;
      this.sweep();
    }
  }

  private async answered(
    ask: OpenAsk,
    report: Report,
  ): Promise<{ value: unknown; transfer?: Transferable[] }> {
    switch (ask.kind) {
      case 'hold':
        this.raw = ask.raw;
        this.release();
        return { value: null };
      case 'render': {
        await networkWeights(ask.denoiser);
        // wasm-bindgen copies a returned Vec out into a fresh ArrayBuffer; its d.ts just does not say so.
        const framed = (await renderRendition(ask.raw, ask.job)) as Uint8Array<ArrayBuffer>;
        const zipped = new Blob([framed]).stream().pipeThrough(new CompressionStream('gzip'));
        const value = new Uint8Array(await new Response(zipped).arrayBuffer());
        return { value, transfer: [value.buffer] };
      }
      case 'prepare':
        return {
          value: await this.preparedAt(ask.request, ask.mosaic, ask.adoptStage, report),
        };
      case 'holdPicture':
        return { value: await this.pictureAt(ask.framed, ask.request, ask.adoptStage) };
      case 'holdRendition':
        return {
          value: await this.renditionAt(ask.file, ask.request, ask.adoptStage, report),
        };
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
        const canvas = ask.canvas ?? undefined;
        if (ask.which === 'stage') editor.attachStage(canvas, ask.width, ask.height);
        else editor.attachLoupe(canvas, ask.width, ask.height);
        return { value: null };
      }
      case 'releaseLoupe':
        this.drawing().releaseLoupe();
        return { value: null };
      case 'attachWheel':
        this.drawing().attachWheel(ask.canvas, ask.side);
        return { value: null };
      case 'drawWheel': {
        const editor = this.drawing();
        editor.drawWheel(ask.lightness);
        return {
          value: { chroma: editor.wheelChroma(), edge: [...editor.wheelEdge(ask.lightness)] },
        };
      }
      case 'probeWheel': {
        const value = (await this.drawing().probeWheel(
          new Float32Array(ask.places),
        )) as Float32Array<ArrayBuffer>;
        return { value, transfer: [value.buffer] };
      }
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
          ask.mosaic.highlightRecovery,
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
        this.drawing().drawOptionThumbnail(
          canvas,
          ask.side,
          ask.ev,
          ask.region,
          ask.showing ?? undefined,
          ask.option,
        );
        return { value: await eightBitPng(canvas) };
      }
      case 'tick': {
        const editor = this.drawing();
        // The size first: the draw below reads the backing store this settles, and a stage sized
        // after it draws is a picture stretched across the shape it had before.
        if (ask.stage != null) editor.resizeStage(ask.stage.width, ask.stage.height);
        if (ask.adjust != null) editor.setAdjust(ask.adjust);
        if (ask.geometry != null) editor.setGeometry(ask.geometry);
        if (ask.proof != null)
          editor.setProof(
            ask.proof.output,
            ask.proof.intent,
            ask.proof.displayPeakNits ?? undefined,
          );
        if (ask.printerProfile !== undefined)
          editor.setPrinterProfile(ask.printerProfile ?? undefined);
        if (ask.print != null) await printEnvironment(ask.print.environment);
        editor.setPrint(ask.print == null ? undefined : JSON.stringify(ask.print));
        if (ask.drawStage) editor.tick(ask.ev, ask.region ?? undefined);
        if (ask.loupe != null) editor.tickLoupe(ask.ev, ask.loupe);
        await finishDraw();
        // wasm-bindgen copies a returned Vec out into a fresh ArrayBuffer; its d.ts just does not say so.
        const stage = ask.drawStage
          ? ((await editor.heldStage()) as Uint8Array<ArrayBuffer> | undefined)
          : undefined;
        const loupe =
          ask.loupe != null
            ? ((await editor.heldLoupe()) as Uint8Array<ArrayBuffer> | undefined)
            : undefined;
        return {
          value: { stage: stage ?? null, loupe: loupe ?? null },
          transfer: [stage?.buffer, loupe?.buffer].filter((buffer) => buffer != null),
        };
      }
    }
  }

  private heldRaw(): Uint8Array {
    if (this.raw == null) throw new Error('this decoder was given no RAW to read');
    return this.raw;
  }

  private release(): void {
    if (this.held != null) this.retired.push(this.held.held);
    this.held = null;
    this.sweep();
  }

  private sweep(): void {
    if (this.asking > 0) return;
    for (const held of this.retired.splice(0)) free(held);
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
  private async keep(held: HeldRaw, request: string, adoptStage: number | null): Promise<HeldRaw> {
    const stage = adoptStage == null || this.closed ? null : await stages.take(adoptStage);
    if (this.closed) {
      if (stage != null && adoptStage != null) stages.keep(adoptStage, stage);
      free(held);
      throw new Error('this decoder was closed');
    }
    if (adoptStage != null) {
      if (stage == null) {
        free(held);
        throw new Error('the editor closed before this photo could be drawn');
      }
      held.adoptStage(stage);
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
  private async preparedAt(
    request: string,
    mosaic: PrepareCrossing,
    adoptStage: number | null,
    report: Report,
  ): Promise<string> {
    await networkWeights(mosaic.denoiser);
    if (this.held?.request !== request) this.release();
    const held =
      this.held?.held ??
      (await this.keep(await holdRaw(this.heldRaw(), request, report), request, adoptStage));
    const { enabled, sensitivity, intensity } = mosaic.dust;
    return held.prepare(
      mosaic.luminance,
      mosaic.colour,
      mosaic.denoiser,
      mosaic.highlightRecovery,
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
  private async pictureAt(
    framed: Uint8Array,
    request: string,
    adoptStage: number | null,
  ): Promise<string> {
    this.release();
    // The header the module answers `prepare` with, which this one already computed: what came back
    // with the samples, read on the side that knows the framing.
    return (await this.keep(await holdPicture(framed, request), request, adoptStage)).header();
  }

  /**
   * The same open, from a rendition's own file decoded in this tab. A JPEG is decoded by the
   * module; an HDR AVIF arrives as its planes, and an SDR one as the browser's own RGBA.
   */
  private async renditionAt(
    file: Uint8Array<ArrayBuffer>,
    request: string,
    adoptStage: number | null,
    report: Report,
  ): Promise<string> {
    report('decoding');
    const held = await heldRendition(file, request, report);
    this.release();
    return (await this.keep(held, request, adoptStage)).prepare(
      undefined,
      undefined,
      'galosh',
      100,
      0,
      false,
      0,
      0,
      '[]',
      report,
    );
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

/** A print environment's map, fetched once for the tab the first time a scene names it. */
async function printEnvironment(environment: Environment): Promise<void> {
  const fetching =
    environments.get(environment) ??
    fetch(printEnvironmentUrls[environment])
      .then(async (answer) => {
        if (!answer.ok) throw new Error(`${answer.status} ${answer.statusText}`);
        holdPrintEnvironment(environment, new Uint8Array(await answer.arrayBuffer()));
      })
      .catch((why: unknown) => {
        environments.delete(environment);
        throw why;
      });
  environments.set(environment, fetching);
  await fetching;
}

async function heldRendition(
  file: Uint8Array<ArrayBuffer>,
  request: string,
  report: Report,
): Promise<HeldRaw> {
  if (file[0] === 0xff && file[1] === 0xd8) return holdRaw(file, request, report);
  const planes =
    (await webCodecsPlanes(file)) ?? (canDecodeAvifPlanes() ? await decodeAvifPlanes(file) : null);
  if (planes != null)
    return holdPlanes(file, planes.samples, JSON.stringify(planes.layout), request);
  // Neither decoder hands over anything but PQ, and the module refuses an HDR file that got here.
  const { rgba, width, height } = await decodedPixels(file);
  return holdPixels(file, rgba, width, height, request);
}

async function decodedPixels(
  avif: Uint8Array<ArrayBuffer>,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([avif], { type: 'image/avif' }));
  try {
    const { width, height } = bitmap;
    const context = new OffscreenCanvas(width, height).getContext('2d');
    if (context == null)
      throw new Error('this worker would not open a 2D canvas to read an SDR rendition');
    context.drawImage(bitmap, 0, 0);
    return {
      rgba: new Uint8Array(context.getImageData(0, 0, width, height).data.buffer),
      width,
      height,
    };
  } finally {
    bitmap.close();
  }
}

async function webCodecsPlanes(avif: Uint8Array<ArrayBuffer>): Promise<PlanarPicture | null> {
  if (WebCodecs == null) return null;
  const decoder = new WebCodecs({ data: avif, type: 'image/avif' });
  try {
    // A file this browser will not decode is one rav1d can still take.
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
