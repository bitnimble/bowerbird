import type {
  JobAdjust,
  JobGrade,
  JobLevels,
  NoiseFit,
} from '../../../../src/services/processing/rawshim_job';

export type LocalFrame = {
  width: number;
  height: number;
  halved: boolean;
  samples: Uint16Array<ArrayBuffer>;
};

/** `crate::edit::EditRequest`, which the module takes as JSON. */
export type LocalOpen = {
  /** Longest edge the decode is fitted to, which is the size every tick then grades. */
  longEdge: number;
  /**
   * This photograph's camera match, where one has been kept.
   *
   * Half a second of the open, and it depends on nothing but the file - so an open that has been
   * through this before skips the fit entirely.
   *
   * Bytes as numbers because this whole struct crosses as JSON: a `Uint8Array` here stringifies to
   * an object of numeric keys, which the far side rejects as a malformed request.
   */
  cameraMatch?: number[];
  grade: JobGrade;
  strengths: { sharpen: number; defringe: number };
  /**
   * The Detail sliders, which the open denoises the mosaic at.
   *
   * On this side of the wire rather than in the tick because the denoise belongs on the mosaic,
   * where the noise is still one photosite's own - the same call a rendition makes, so the editor
   * and the export are one pipeline rather than two that have to be argued into agreeing.
   */
  denoiseLuminance: number;
  denoiseColour: number;
};

/** `crate::tile::TileRequest`, which the module takes as JSON. */
export type LocalTileRequest = {
  /** `[left, top, width, height]` in the photograph's own pixels, which is the frame's space. */
  tile: [number, number, number, number];
  /** The photograph the rectangle is a piece of, which only this side knows. */
  frame: [number, number];
  grade: JobGrade;
  strengths: { sharpen: number; defringe: number };
  denoiseLuminance: number;
  denoiseColour: number;
  /** Read for the presence three alone: how far past the tile the guided filter reaches. */
  adjust: JobAdjust;
  /** The photograph's, measured at the open - a crop's own describe where the reader is pointing. */
  levels: JobLevels | null;
  noiseFit: NoiseFit | null;
  cameraMatch?: number[];
};

/**
 * One tile's window, in the form the page's own grade reads.
 *
 * Not a picture: the samples are what `job::graded` uploads, so the tick's shaders grade a tile
 * exactly as they grade the frame under it.
 */
export type LocalTile = {
  /** The window, which is the rectangle asked for plus every stage's reach past it. */
  width: number;
  height: number;
  /** `[left, top, width, height]` of the rectangle asked for, inside that window. */
  keep: [number, number, number, number];
  /** `struct Edit`'s frame half, as `PreparedHeader.edits` carries the whole frame's. */
  edits: number[];
  /** The working texture `detail.wgsl` blurs on, at the photograph's own step. */
  detail: { width: number; height: number };
  samples: Uint16Array<ArrayBuffer>;
};

/** What `local_open_worker.ts` is asked for, and what it answers with. */
type Job =
  | { kind: 'hold'; raw: Uint8Array }
  | { kind: 'open'; atLeastLongEdge: number }
  | { kind: 'prepare'; request: string }
  | { kind: 'tile'; request: string }
  | { kind: 'gpu' };

export type Ask = Job & { id: number };

export type Answer =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

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
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >();
  private asked = 0;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<Answer>) => {
      const answer = event.data;
      const waiter = this.waiting.get(answer.id);
      if (waiter == null) return;
      this.waiting.delete(answer.id);
      if (answer.ok) waiter.resolve(answer.value as never);
      else waiter.reject(new Error(answer.error));
    };
    this.worker.onerror = (event) => this.refuse(new Error(event.message));
  }

  /** The bytes every later call reads, transferred: the page has no use for them afterwards. */
  hold(raw: Uint8Array<ArrayBuffer>): Promise<void> {
    return this.ask({ kind: 'hold', raw }, [raw.buffer]);
  }

  /** Whether the module opened a device, or fell through to the CPU's conditioning and PPG. */
  gpu(): Promise<boolean> {
    return this.ask({ kind: 'gpu' });
  }

  open(atLeastLongEdge: number): Promise<LocalFrame> {
    return this.ask({ kind: 'open', atLeastLongEdge });
  }

  /**
   * The editor's open, framed exactly as `/image/:id/prepared` frames it.
   *
   * Handed back rather than parsed here, so one reader takes it apart whichever host prepared it.
   */
  prepare(request: LocalOpen): Promise<Uint8Array> {
    return this.ask({ kind: 'prepare', request: JSON.stringify(request) });
  }

  /** One tile of the photograph at rendition quality, decoded here rather than fetched. */
  tile(request: LocalTileRequest): Promise<LocalTile> {
    return this.ask({ kind: 'tile', request: JSON.stringify(request) });
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

  private ask<T>(job: Job, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.asked;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: never) => void, reject });
      this.worker.postMessage({ ...job, id }, transfer);
    });
  }

  private refuse(error: Error): void {
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }
}
