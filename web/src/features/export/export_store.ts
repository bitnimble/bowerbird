import { computed, observable } from 'mobx';
import { ExportOptionsSchema, honoured, type ExportOptions } from '../../../../src/schemas/export';
import type { PhotoTarget } from '../../../../src/schemas/photos';
import { estimateExportBytes } from '../../../../src/services/processing/exports/export_estimate';
import type { ExportJob } from './export_job';

/**
 * The export dialog's own state (§10.5), and the runs it has started.
 *
 * **A target rather than a list of photographs**, so the bulk bar's export is this dialog
 * opened over a selection - which may name more photographs than the grid has ever held rows
 * for (§18.3.3). Nothing here knows how many it was given until the run resolves them.
 */
export class ExportStore {
  /**
   * The run in flight first, then what is waiting, which is the order the page lists.
   *
   * The dialog closes on the click that fills this, so a run reports itself from the sidebar and
   * the Exports page rather than from a modal the reader is held behind for minutes.
   */
  @observable.ref accessor queue: ExportJob[] = [];
  @observable accessor open = false;
  /** What is being exported. Null while the dialog is closed. */
  @observable.ref accessor target: PhotoTarget | null = null;
  /**
   * How many photographs the dialog says it is about.
   *
   * The caller's count, so the title and the estimate can be drawn before anything is
   * resolved. A selection reaching rows this client never held counts those one apiece, so it
   * is a floor there in the same way the bulk bar's own count is.
   */
  @observable accessor count = 0;
  @observable.ref accessor options: ExportOptions = ExportOptionsSchema.parse({});
  /** The frame each export starts from, for the estimate. Null until the detail lands. */
  @observable.ref accessor source: { width: number; height: number } | null = null;
  /** What went wrong before a run could be queued, which is the only failure the dialog holds. */
  @observable accessor error: string | null = null;

  @computed get active(): ExportJob | null {
    return this.queue[0] ?? null;
  }

  /** Photographs still to write, across every queued run: what the sidebar counts. */
  @computed get queued(): number {
    return this.queue.reduce((total, job) => total + job.total, 0);
  }

  @computed get written(): number {
    return this.queue.reduce((total, job) => total + job.written, 0);
  }

  /**
   * The options as the picked format can honour them, which is what the controls render from.
   *
   * Reading this rather than `options` is what keeps a greyed-out switch and the file that
   * comes back from ever disagreeing: both sides ask the same function.
   */
  @computed get effective(): ExportOptions {
    return honoured(this.options);
  }

  /** Rough bytes for the whole selection, or null where the format has no model. */
  @computed get estimateBytes(): number | null {
    const each = estimateExportBytes(this.effective, this.source);
    return each == null ? null : each * Math.max(this.count, 1);
  }

  /** Whether HDR is off because the format cannot carry it rather than because it is unset. */
  @computed get hdrUnavailable(): boolean {
    return this.options.exportHdr && !this.effective.exportHdr;
  }
}
