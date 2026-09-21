/// <reference lib="webworker" />
import init, {
  type HeldRaw,
  type InitOutput,
  finishDraw,
  holdPicture,
  holdPmridWeights,
  holdRaw,
  renderRendition,
} from '../../../../../native/rawshim/pkg/rawshim';
import { pmridWeightsUrl } from '../../../../../native/rawshim/pkg/pmrid_weights';
import { z } from 'zod';
import { AnswerSchema, type Ask, AskSchema, type PrepareCrossing } from './local_open';
import { cachedRecipes, PipelineWarmth } from '../stage/pipeline_warmth';

/** The other half of `LocalDecoder`, which says why the module is over here. */

/** The RAW this decoder was given, kept so a tile costs neither a download nor a copy. */
let held: Uint8Array | null = null;
/**
 * The same photograph opened as far as the mosaic, which is what a Detail or dust slider re-runs
 * from - and what holds the particle detection, so only the first prepare that switches dust on
 * pays for looking.
 *
 * Freed and rebuilt when the open's other settings move, since everything above the mosaic was
 * decided with them.
 */
let open: { held: HeldRaw; request: string } | null = null;
let module: Promise<InitOutput> | null = null;
let weights: Promise<void> | null = null;

const worker = self as unknown as DedicatedWorkerGlobalScope;

if ('GPUAdapter' in worker) {
  new PipelineWarmth(cachedRecipes()).install(
    GPUAdapter.prototype,
    GPUDevice.prototype,
    GPUComputePassEncoder.prototype,
  );
}

const AskIdSchema = z.object({ id: z.number() });

worker.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
  const { id } = AskIdSchema.parse(event.data);
  try {
    const { value, transfer } = await answer(AskSchema.parse(event.data));
    worker.postMessage(AnswerSchema.parse({ id, ok: true, value }), transfer ?? []);
  } catch (error) {
    worker.postMessage(
      AnswerSchema.parse({ id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  }
};

async function answer(ask: Ask): Promise<{ value: unknown; transfer?: Transferable[] }> {
  module ??= init();
  await module;
  switch (ask.kind) {
    case 'hold':
      held = ask.raw;
      open?.held.free();
      open = null;
      return { value: null };
    case 'render': {
      // wasm-bindgen copies a returned Vec out into a fresh ArrayBuffer; its d.ts just does not say so.
      const framed = (await renderRendition(ask.raw, ask.job)) as Uint8Array<ArrayBuffer>;
      const zipped = new Blob([framed]).stream().pipeThrough(new CompressionStream('gzip'));
      const value = new Uint8Array(await new Response(zipped).arrayBuffer());
      return { value, transfer: [value.buffer] };
    }
    case 'prepare':
      return { value: await prepared_at(ask.request, ask.mosaic) };
    case 'holdPicture':
      return { value: await picture_at(ask.framed, ask.request) };
    case 'takePicture':
      // The same open, a different picture of it: the stage stays where it was transferred.
      return { value: drawing().takePicture(ask.framed) };
    case 'takeTiles':
      return { value: drawing().takeTiles(ask.framed, ask.asked) };
    case 'showTiles':
      return { value: JSON.parse(drawing().showTiles(ask.level, ask.rect)) };
    case 'picturePart':
      return { value: JSON.parse(drawing().picturePart(ask.region)) };
    case 'attach': {
      const editor = drawing();
      if (ask.which === 'stage') editor.attachStage(ask.canvas, ask.width, ask.height);
      else editor.attachLoupe(ask.canvas, ask.width, ask.height);
      return { value: null };
    }
    case 'releaseLoupe':
      drawing().releaseLoupe();
      return { value: null };
    case 'holdTile':
      return { value: JSON.parse(await drawing().holdTile(ask.request)) };
    case 'releaseTile':
      drawing().releaseTile();
      return { value: null };
    case 'analysis': {
      // Spread to plain numbers, as `LocalOpen.photoAnalysis` is: this goes back out inside a
      // request that crosses as JSON, and a `Uint8Array` stringifies to an object of numeric keys
      // that the far side rejects as malformed.
      const bytes = open?.held.analysis();
      return { value: bytes == null ? null : [...bytes] };
    }
    case 'bandInto': {
      await networkWeights(ask.mosaic.denoiser);
      const { enabled, sensitivity, intensity } = ask.mosaic.dust;
      await drawing().bandInto(
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
      drawing().redrawRepairs(ask.repairs);
      return { value: null };
    case 'refreshDetail':
      drawing().refreshDetail();
      return { value: null };
    case 'solveRepair':
      return {
        value: JSON.parse(
          await drawing().solveRepair(
            ask.drawn,
            ask.others,
            ask.grow,
            ask.without ?? undefined,
            ask.donor ?? undefined,
          ),
        ),
      };
    case 'setRepairs':
      return { value: JSON.parse(drawing().setRepairs(ask.repairs)) };
    case 'dropTiles':
      drawing().dropTiles();
      return { value: null };
    case 'setSearched':
      return { value: JSON.parse(drawing().setSearched(ask.drawn, ask.donor ?? undefined)) };
    case 'pictureOfOutput':
      return { value: JSON.parse(drawing().pictureOfOutput(ask.geometry, ask.points)) };
    case 'outputOfPicture':
      return { value: JSON.parse(drawing().outputOfPicture(ask.geometry, ask.points)) };
    case 'repairThumbnail': {
      const canvas = new OffscreenCanvas(ask.side, ask.side);
      drawing().drawThumbnail(canvas, ask.side, ask.ev, ask.region, ask.repair);
      return { value: await eightBitPng(canvas) };
    }
    case 'optionThumbnail': {
      const canvas = new OffscreenCanvas(ask.side, ask.side);
      drawing().drawOptionThumbnail(canvas, ask.side, ask.ev, ask.region, ask.showing ?? undefined, ask.option);
      return { value: await eightBitPng(canvas) };
    }
    case 'tick': {
      const editor = drawing();
      // The size first: the draw below reads the backing store this settles, and a stage sized
      // after it draws is a picture stretched across the shape it had before.
      if (ask.stage != null) editor.resizeStage(ask.stage.width, ask.stage.height);
      if (ask.adjust != null) editor.setAdjust(ask.adjust);
      if (ask.geometry != null) editor.setGeometry(ask.geometry);
      if (ask.proof != null) editor.setProof(ask.proof);
      editor.setPrint(ask.print == null ? undefined : JSON.stringify(ask.print));
      if (ask.drawStage) editor.tick(ask.ev, ask.region ?? undefined);
      if (ask.loupe != null) editor.tickLoupe(ask.ev, ask.loupe);
      await finishDraw();
      return { value: null };
    }
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

function raw(): Uint8Array {
  if (held == null) throw new Error('this decoder was given no RAW to read');
  return held;
}

/**
 * The open holding this photograph's frame, which is what the canvases draw from.
 *
 * A canvas or a tick arriving before the first prepare is a page asking for a picture of nothing,
 * so it says so rather than drawing an empty canvas.
 */
function drawing(): HeldRaw {
  if (open == null) throw new Error('no photograph is open to draw');
  return open.held;
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
async function prepared_at(request: string, mosaic: PrepareCrossing): Promise<string> {
  await networkWeights(mosaic.denoiser);
  if (open != null && open.request !== request) {
    open.held.free();
    open = null;
  }
  open ??= { held: await holdRaw(raw(), request), request };
  const { enabled, sensitivity, intensity } = mosaic.dust;
  return open.held.prepare(
    mosaic.luminance,
    mosaic.colour,
    mosaic.denoiser,
    mosaic.sharpen,
    enabled,
    sensitivity,
    intensity,
    mosaic.repairs,
  );
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

/**
 * The same open, from a picture that arrived coded.
 *
 * **Not keyed, because there is nothing to re-run.** A held mosaic exists so a Detail amount costs
 * a denoise rather than a decode; a picture prepared elsewhere has no mosaic here, so a new amount
 * is a new prepare on the far side and arrives as new bytes. Whatever was open is freed and this
 * replaces it.
 */
async function picture_at(framed: Uint8Array, request: string): Promise<string> {
  open?.held.free();
  open = { held: await holdPicture(framed, request), request };
  // The header the module answers `prepare` with, which this one already computed: what came back
  // with the samples, read on the side that knows the framing.
  return open.held.header();
}
