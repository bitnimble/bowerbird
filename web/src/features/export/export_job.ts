import { computed, observable } from 'mobx';
import type { ExportOptions } from '../../../../src/schemas/export';
import type { QueuedPhoto } from '../../../../src/schemas/exports';
import type { ExportSink } from './export_sink';

/**
 * One export the reader has asked for: what it was asked for, and how far through it is.
 *
 * Its `id` is the run the history files it under, so the render knows it before the first file
 * exists (§10.5.2). The sink is carried because it was chosen inside the click that queued the
 * job, which is minutes before the job may start.
 *
 * A file of its own, not `export_store.ts`: bun hands two decorated classes in one module the
 * same decorator metadata, and the first of them comes out with no observables at all.
 */
export class ExportJob {
  constructor(
    readonly id: string,
    /** Resolved before the run is queued, so what is waiting can be listed rather than counted. */
    readonly photoIds: string[],
    readonly options: ExportOptions,
    readonly sink: ExportSink,
  ) {}

  /**
   * What each of those photographs is, for the queue to read as the history does.
   *
   * Empty until the describe lands, and after one that failed: a run whose rows could not be
   * fetched still exports, and says how far it has got with no rows under it.
   */
  @observable.ref accessor photos: QueuedPhoto[] = [];
  @observable accessor done = 0;
  @observable accessor failed = 0;
  /**
   * How far into the photograph in flight the server's render is, 0 to 1.
   *
   * Announced on the event stream while the request that will answer with the file is still
   * open, and zeroed as each file settles: without it a run of one sits at nothing for minutes.
   */
  @observable accessor fraction = 0;
  @observable accessor running = false;
  /** Set by the reader stopping a run; the loop finishes the file it is on. */
  @observable accessor stopping = false;

  get total(): number {
    return this.photoIds.length;
  }

  @computed get settled(): number {
    return this.done + this.failed;
  }

  /** What a bar is drawn from: the files behind it, plus how far into the one in flight. */
  @computed get written(): number {
    return this.settled + this.fraction;
  }
}
