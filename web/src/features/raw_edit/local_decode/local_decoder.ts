import { z } from 'zod';
import { type Repair, RepairSchema } from '../../../../../src/schemas/photo_edits';
import {
  type Job as RenditionCommand,
} from '../../../../../src/schemas/jobs';
import type { EditAdjust, EditGeometry, Region, SoftProof } from '../edits';
import type { PrintScene } from '../print/print_scene';
import {
  AnswerSchema,
  AskSchema,
  BlobSchema,
  BytesSchema,
  crossing,
  JsonSchema,
  NothingSchema,
  PointsSchema,
  RectSchema,
  ShownSchema,
  TileKeepSchema,
  type Job,
  type LocalOpen,
  type LocalPrepare,
  type LocalTileRequest,
  type TileKeep,
} from './local_open';

/**
 * The wasm module, on a thread of its own.
 *
 * **Every call here is seconds of unyielding wasm**, so none of it may run where the editor draws:
 * a 61MP open measured eight seconds in one task, which froze the page from the moment the panel
 * mounted until the frame arrived. The module has no seam to yield through and the frame is copied
 * out of its memory anyway, so it lives behind a worker and the results are transferred.
 *
 * The RAW is `hold`-ed once rather than passed per call: it is tens of megabytes, and a tile that
 * carried it would copy all of it across the boundary for every position the loupe stops at.
 */
export class LocalDecoder {
  private readonly worker = new Worker(new URL('./local_open_worker.ts', import.meta.url), {
    type: 'module',
  });
  private readonly waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private asked = 0;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<unknown>) => {
      const answer = AnswerSchema.parse(event.data);
      const waiter = this.waiting.get(answer.id);
      if (waiter == null) return;
      this.waiting.delete(answer.id);
      if (answer.ok) waiter.resolve(answer.value);
      else waiter.reject(new Error(answer.error));
    };
    this.worker.onerror = (event) => this.refuse(new Error(event.message));
  }

  /** The bytes every later call reads, transferred: the page has no use for them afterwards. */
  hold(raw: Uint8Array<ArrayBuffer>): Promise<void> {
    return this.nothing({ kind: 'hold', raw }, [raw.buffer]);
  }

  /**
   * One rendition of this RAW, rendered here from the server's job and gzipped for it to encode
   * (`job::render_bytes`). The RAW is transferred.
   */
  render(raw: Uint8Array<ArrayBuffer>, job: RenditionCommand): Promise<Uint8Array<ArrayBuffer>> {
    return this.ask(BytesSchema, { kind: 'render', raw, job: JSON.stringify(job) }, [raw.buffer]);
  }

  /**
   * The editor's open at these mosaic settings, as `edit::PreparedHeader` JSON.
   *
   * Handed back rather than parsed here, so one reader takes it apart whichever host prepared it.
   *
   * **Cheap to call again at another setting.** The worker holds the photograph at its mosaic, so
   * only these stages and what follows them run a second time - the read, the levels, the
   * conditioning and the particle detection, which are most of an open, were settled above.
   */
  prepare(request: LocalOpen, mosaic: LocalPrepare): Promise<string> {
    return this.ask(JsonSchema, { kind: 'prepare', request: JSON.stringify(request), mosaic: crossing(mosaic) });
  }

  /**
   * The same open, from a picture the server prepared: the framed reply, transferred.
   *
   * Answers the same header `prepare` does, because it is the same struct - so everything above
   * this point reads one description of a photograph whichever device coded it.
   *
   * Transferred, like `hold`: the frame is tens of megabytes and the page has no use for it once
   * the module has uploaded it to the device.
   */
  holdPicture(framed: Uint8Array<ArrayBuffer>, request: LocalOpen): Promise<string> {
    return this.ask(JsonSchema, { kind: 'holdPicture', framed, request: JSON.stringify(request) }, [
      framed.buffer,
    ]);
  }

  /**
   * Another picture of the same photograph, on the stage this open already has.
   *
   * What a reader zooming into a canvas is served: a finer window of it. Not a second
   * {@link holdPicture}, because the canvas was transferred once and cannot be again.
   */
  takePicture(framed: Uint8Array<ArrayBuffer>): Promise<string> {
    return this.ask(JsonSchema, { kind: 'takePicture', framed }, [framed.buffer]);
  }

  /**
   * Keeps a prepared rectangle as the tiles it covers, and answers its header.
   *
   * The header is the *reply's*, which is what says the level and canvas the tiles now belong to.
   */
  takeTiles(
    framed: Uint8Array<ArrayBuffer>,
    asked: [number, number, number, number][],
  ): Promise<string> {
    return this.ask(JsonSchema, { kind: 'takeTiles', framed, asked: JSON.stringify(asked) }, [framed.buffer]);
  }

  /**
   * What the module is short of to draw `rect` of `level`, and what it draws once it is not.
   *
   * `missing` is the rectangle to fetch and hand back through {@link takeTiles}, or null having
   * assembled the frame a tick will draw. `rect` is the viewport already dilated by however far
   * ahead we want to load: the tiles a reader is approaching are just a larger rectangle.
   */
  showTiles(
    level: [number, number],
    rect: [number, number, number, number],
  ): Promise<{ missing: [number, number, number, number][] | null }> {
    return this.ask(ShownSchema, {
      kind: 'showTiles',
      level: JSON.stringify(level),
      rect: JSON.stringify(rect),
    });
  }

  /**
   * What part of the picture a region of the output reads from, as fractions `[x, y, w, h]`.
   *
   * The reader's geometry stands between the two, and the module is what already maps one to the
   * other for every pixel it draws - so this asks rather than working it out here.
   */
  picturePart(region: Region): Promise<[number, number, number, number]> {
    return this.ask(RectSchema, { kind: 'picturePart', region: JSON.stringify(region) });
  }

  /**
   * Hands a canvas to the worker, which draws on it from there.
   *
   * **Transferred, not shared.** `transferControlToOffscreen` moves the backing store for good -
   * the element can never take a context on this thread again, and transferring the same element
   * twice throws - so the presenter transfers each canvas once and remembers that it did.
   */
  attach(
    which: 'stage' | 'loupe',
    canvas: OffscreenCanvas,
    width: number,
    height: number,
  ): Promise<void> {
    return this.nothing({ kind: 'attach', which, canvas, width, height }, [canvas]);
  }

  releaseLoupe(): Promise<void> {
    return this.nothing({ kind: 'releaseLoupe' });
  }

  /** One rendition tile, built and kept for the glass to draw instead of the editor's frame. */
  holdTile(request: LocalTileRequest): Promise<TileKeep> {
    return this.ask(TileKeepSchema, { kind: 'holdTile', request: JSON.stringify(request) });
  }

  releaseTile(): Promise<void> {
    return this.nothing({ kind: 'releaseTile' });
  }

  /**
   * One strip of a re-prepare, written into the frame the module is already drawing.
   *
   * Nothing comes back: the strip is copied buffer to buffer on the device, so a Detail drag
   * moves no pixels across the boundary at all.
   *
   * **The strips are final, not previews.** Each is bit-for-bit the pixels the whole frame would
   * have produced (`a_band_of_a_held_mosaic_is_the_frame_it_was_cut_from`), because everything a
   * band could measure differently - the levels, the noise fit, the camera match - was settled at
   * the open and is handed to it. So a reader watches the picture arrive rather than watching it
   * be corrected.
   *
   * **`rows` has to be even except on the band that ends the frame**, which is what lets the copy
   * begin on a word: see `HeldRaw::band_into`.
   */
  bandInto(mosaic: LocalPrepare, top: number, rows: number, frame: [number, number]): Promise<void> {
    return this.nothing({ kind: 'bandInto', mosaic: crossing(mosaic), top, rows, frame });
  }

  /** The frame that is up drawn with `repairs` instead, for a change that touched nothing else. */
  redrawRepairs(repairs: Repair[]): Promise<void> {
    return this.nothing({ kind: 'redrawRepairs', repairs: JSON.stringify(repairs) });
  }

  /** The presence sliders' blur, rebuilt once the last band has landed. */
  refreshDetail(): Promise<void> {
    return this.nothing({ kind: 'refreshDetail' });
  }

  /**
   * The repairs a reader is offered for a loop drawn on the `STORED_LONG` grid, cheapest seam
   * first, none reading its fill from under one of `others`.
   *
   * Searched on the frame the module is drawing, so what is offered is what the pass will draw.
   * `grow` lets each seam grow past the loop to hide itself; without it every seam is the loop.
   * `without` is a repair the stage is showing at the loop, which the search reads from under while
   * the stage goes on showing it. `donor` is where the reader put the fill, and the one repair
   * answered is filled from there.
   */
  solveRepair(
    drawn: [number, number][],
    others: Repair[],
    grow: boolean,
    without: Repair | null,
    donor: [number, number] | null,
  ): Promise<Repair[]> {
    return this.ask(z.array(RepairSchema), {
      kind: 'solveRepair',
      drawn: JSON.stringify(drawn),
      others: JSON.stringify(others),
      grow,
      without: without == null ? null : JSON.stringify(without),
      donor: donor == null ? null : JSON.stringify(donor),
    });
  }

  /**
   * The repairs drawn over a picture prepared elsewhere, which arrives without them: answers as
   * {@link showTiles} does, for whatever the stage last asked it for.
   */
  setRepairs(repairs: Repair[]): Promise<{ missing: [number, number, number, number][] | null }> {
    return this.ask(ShownSchema, { kind: 'setRepairs', repairs: JSON.stringify(repairs) });
  }

  /** Every tile let go, for a picture about to be prepared again at other settings. */
  dropTiles(): Promise<void> {
    return this.nothing({ kind: 'dropTiles' });
  }

  /**
   * A loop about to be solved, or null once it has been: a picture prepared elsewhere holds all its
   * search reads as well as the stage, and where the reader put its fill, if they did. Answers as
   * {@link setRepairs}.
   */
  setSearched(
    drawn: [number, number][] | null,
    donor: [number, number] | null,
  ): Promise<{ missing: [number, number, number, number][] | null }> {
    return this.ask(ShownSchema, {
      kind: 'setSearched',
      drawn: JSON.stringify(drawn),
      donor: donor == null ? null : JSON.stringify(donor),
    });
  }

  /**
   * Points of the output under `geometry`, as fractions of it, where they fall in the picture, as
   * fractions of that - asked for {@link picturePart}'s reason.
   */
  pictureOfOutput(geometry: EditGeometry, points: [number, number][]): Promise<[number, number][]> {
    return this.ask(PointsSchema, {
      kind: 'pictureOfOutput',
      geometry: JSON.stringify(geometry),
      points: JSON.stringify(points),
    });
  }

  /** {@link pictureOfOutput} backwards. */
  outputOfPicture(geometry: EditGeometry, points: [number, number][]): Promise<[number, number][]> {
    return this.ask(PointsSchema, {
      kind: 'outputOfPicture',
      geometry: JSON.stringify(geometry),
      points: JSON.stringify(points),
    });
  }

  /**
   * `region` of the output from under `repair`, every other repair as drawn, as a PNG `side`
   * pixels square: what the repair removed.
   */
  repairThumbnail(side: number, ev: number, region: Region, repair: Repair): Promise<Blob> {
    return this.ask(BlobSchema, {
      kind: 'repairThumbnail',
      side,
      ev,
      region: JSON.stringify(region),
      repair: JSON.stringify(repair),
    });
  }

  /**
   * `region` of the output with `option` drawn in place of `showing`, the fill the frame is drawn
   * with at the loop, as `repairThumbnail` draws: what choosing `option` would show.
   */
  optionThumbnail(side: number, ev: number, region: Region, showing: Repair | null, option: Repair): Promise<Blob> {
    return this.ask(BlobSchema, {
      kind: 'optionThumbnail',
      side,
      ev,
      region: JSON.stringify(region),
      showing: showing == null ? null : JSON.stringify(showing),
      option: JSON.stringify(option),
    });
  }

  /**
   * One tick, drawn where the frame already is.
   *
   * Resolves once the worker has recorded the draw, which is what the presenter's pump waits on
   * before asking for the next: the same one-at-a-time gate the page kept when it drew for itself,
   * with the swapchain's backpressure now on that side of the boundary rather than on the thread
   * handling the pointer.
   */
  tick(tick: {
    ev: number;
    drawStage: boolean;
    region: Region | null;
    loupe: Region | null;
    adjust: EditAdjust | null;
    geometry: EditGeometry | null;
    proof: SoftProof | null;
    print: PrintScene | null;
    stage: { width: number; height: number } | null;
  }): Promise<void> {
    return this.nothing({
      kind: 'tick',
      ev: tick.ev,
      drawStage: tick.drawStage,
      region: tick.region == null ? null : JSON.stringify(tick.region),
      loupe: tick.loupe == null ? null : JSON.stringify(tick.loupe),
      adjust: tick.adjust == null ? null : JSON.stringify(tick.adjust),
      geometry: tick.geometry == null ? null : JSON.stringify(tick.geometry),
      proof: tick.proof,
      print: tick.print,
      stage: tick.stage,
    });
  }

  /**
   * What the worker has had measured about this photograph, for the page to hand on.
   *
   * **Because a band carries no header.** An open answers with one and the page keeps what it says;
   * a re-prepare answers in strips, so anything the worker had to measure for it - the particles,
   * where the reader has just switched dust on - would otherwise stay behind the boundary, and the
   * loupe would keep asking for tiles corrected differently from the stage under them.
   *
   * Null before the first prepare, which is the only time there is nothing to say.
   */
  analysis(): Promise<number[] | null> {
    return this.ask(z.array(z.number()).nullable(), { kind: 'analysis' });
  }

  /**
   * Terminated rather than left to be collected: the thread holds the RAW, the module's heap and
   * the device it opened, and a decode in flight for an editor nobody is looking at any more still
   * runs to the end of the file.
   */
  close(): void {
    this.refuse(new Error('this decoder was closed'));
    this.worker.terminate();
  }

  private async nothing(job: Job, transfer: Transferable[] = []): Promise<void> {
    await this.ask(NothingSchema, job, transfer);
  }

  private ask<S extends z.ZodType>(schema: S, job: Job, transfer: Transferable[] = []): Promise<z.output<S>> {
    const id = ++this.asked;
    return new Promise<z.output<S>>((resolve, reject) => {
      this.waiting.set(id, {
        resolve: (value) => {
          const parsed = schema.safeParse(value);
          if (parsed.success) resolve(parsed.data);
          else reject(parsed.error);
        },
        reject,
      });
      this.worker.postMessage(AskSchema.parse({ ...job, id }), transfer);
    });
  }

  private refuse(error: Error): void {
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }
}
