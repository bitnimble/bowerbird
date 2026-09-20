import { action, reaction } from 'mobx';
import type { SidebarStore } from '../../app/sidebar_store';
import { exportsApi } from '../../api/exports';
import { photosApi } from '../../api/photos';
import { describe } from '../../errors';
import type { ExportOptions } from '../../../../src/schemas/export';
import type { ExportProgress, QueuedPhoto } from '../../../../src/schemas/exports';
import { newId } from '../../../../src/schemas/id';
import type { PhotoTarget } from '../../../../src/schemas/photos';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { ExportJob } from './export_job';
import type { ExportStore } from './export_store';
import { chooseSink, type ExportSink } from './export_sink';
import { ExportStrings } from './export.strings';
import { ExportsPageStrings } from '../exports/exports_page.strings';

export class ExportPresenter {
  constructor(
    private readonly store: ExportStore,
    private readonly sidebar: SidebarStore,
    private readonly toasts: ToastsPresenter,
    /** The seam a test replaces, so a run can be watched without a folder to write into. */
    private readonly sink: (count: number) => Promise<ExportSink | null> = chooseSink,
  ) {
    reaction(() => [this.sidebar.open, this.store.queued, this.store.written], this.syncToast);
  }

  private toast: number | null = null;

  /**
   * Opens over one photograph or a selection.
   *
   * `source` is the frame the estimate is scaled against. A caller that does not have it yet
   * passes null and the dialog says nothing about size rather than guessing.
   */
  @action.bound
  openFor(target: PhotoTarget, count: number, source: { width: number; height: number } | null): void {
    this.store.target = target;
    this.store.count = count;
    this.store.source = source;
    this.store.error = null;
    this.store.open = true;
  }

  /**
   * Stops the run in flight after the photograph it is on, or drops one that has not begun.
   *
   * Nothing already written is unwound: the files are the reader's, on their own disk.
   */
  @action.bound
  stop(id: string): void {
    const job = this.store.queue.find((each) => each.id === id);
    if (job == null) return;
    if (job.running) job.stopping = true;
    else this.store.queue = this.store.queue.filter((each) => each !== job);
  }

  /**
   * How far into one photograph the server's render is (§10.5).
   *
   * Ignored for a run that is not the one in flight: an announcement can only arrive late, and a
   * run that has moved on is drawn from its own count of files.
   */
  @action.bound
  progressed({ run_id, fraction }: ExportProgress): void {
    const job = this.store.active;
    if (job?.id !== run_id) return;
    job.fraction = Math.min(Math.max(fraction, 0), 1);
  }

  @action.bound
  close(): void {
    this.store.open = false;
    this.store.target = null;
    this.store.error = null;
  }

  /**
   * One setter for every control, because they all do the same thing to one frozen object.
   *
   * The options are held as a `ref` and replaced rather than mutated, so a component reading
   * `effective` re-derives on any change without every field needing to be observable.
   */
  @action.bound
  set<K extends keyof ExportOptions>(key: K, value: ExportOptions[K]): void {
    this.store.options = { ...this.store.options, [key]: value };
  }

  /**
   * Queues what the dialog was filled in with, and closes it.
   *
   * **The sink is chosen before anything is awaited**, because `showDirectoryPicker` needs the
   * click that started this to still be the transient activation - one `await` in front of it
   * and the browser drops the picker on the floor. The dialog stays up until the picker has
   * been answered, so dismissing it leaves the reader with the settings they chose.
   */
  @action.bound
  async run(): Promise<void> {
    const target = this.store.target;
    if (target == null) return;
    const chosen = this.sink(this.store.count);
    const options = this.store.effective;
    let job: ExportJob;
    try {
      const sink = await chosen;
      // The reader dismissed the picker, which is not a failure to report at them.
      if (sink == null) return;
      // Resolved here rather than at the head of the run, so what is waiting in the queue can
      // be listed photograph by photograph rather than only counted.
      const photoIds = 'photo_ids' in target ? target.photo_ids : (await photosApi.ids(target)).photo_ids;
      // One run, however many photographs are in it, which is what the history lists as an
      // export of several rather than as several exports.
      job = new ExportJob(newId(), photoIds, options, sink);
    } catch {
      this.failed(ExportStrings.couldNotStart());
      return;
    }
    this.queued(job);
    this.close();
    void this.describe(job);
    await this.pump();
  }

  /**
   * What the queue lists each waiting photograph as, which is the row the history will hold.
   *
   * Best effort: the files are what the reader asked for, so a run whose rows could not be
   * fetched exports anyway and shows its progress with nothing under it.
   */
  private async describe(job: ExportJob): Promise<void> {
    try {
      const photos = await exportsApi.queued({ photo_ids: job.photoIds, include_edits: job.options.includeEdits });
      this.described(job, photos);
    } catch {
      // Nothing to say: the run itself is unaffected and the queue still counts it down.
    }
  }

  private pumping = false;

  /**
   * One run at a time, in the order they were asked for.
   *
   * A second call while this is going returns rather than starting a loop of its own: both
   * read the same queue, so the run the second picked up would be the one already in flight.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let job = this.store.active; job != null; job = this.store.active) {
        await this.work(job);
        this.dequeue(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Renders each photograph in turn and hands it to the sink the reader picked. */
  private async work(job: ExportJob): Promise<void> {
    this.beginning(job);
    let reason: string | null = null;
    for (const photoId of job.photoIds) {
      if (job.stopping) break;
      try {
        const output = await job.sink.save(photoId, job.options, job.id);
        await this.remember(job.id, photoId, output);
        this.counted(job, null);
      } catch (err) {
        // Kept going: one unreadable RAW in a hundred should not decide that the other
        // ninety-nine stay where they are.
        reason = describe(err);
        this.counted(job, reason);
      }
    }
    this.settle(job, reason);
  }

  private async remember(run: string, photoId: string, output: string): Promise<void> {
    await exportsApi
      .record({ run_id: run, photo_id: photoId, output_path: output })
      // The file is already on the reader's disk, so a history that could not be finished is
      // not a failed export: reported as one, it sends them to do again what has been done.
      // The row the render wrote goes unlisted and is swept, rather than lying about a
      // destination nobody confirmed.
      .catch(() => undefined);
  }

  @action.bound
  private queued(job: ExportJob): void {
    this.store.queue = [...this.store.queue, job];
    // Held but not showing means the reader dismissed it; a new run brings it back.
    if (this.toast != null && !this.toasts.isShowing(this.toast)) this.toast = null;
  }

  @action.bound
  private syncToast(): void {
    const { queued } = this.store;
    if (this.sidebar.open || queued === 0) {
      if (this.toast != null) this.toasts.dismiss(this.toast);
      this.toast = null;
      return;
    }
    const message = ExportsPageStrings.exporting(queued);
    const progress = this.store.written / queued;
    if (this.toast == null) this.toast = this.toasts.showProgress(message, progress);
    else this.toasts.progressed(this.toast, message, progress);
  }

  @action.bound
  private dequeue(job: ExportJob): void {
    this.store.queue = this.store.queue.filter((each) => each !== job);
  }

  @action.bound
  private beginning(job: ExportJob): void {
    job.running = true;
  }

  @action.bound
  private described(job: ExportJob, photos: QueuedPhoto[]): void {
    job.photos = photos;
  }

  @action.bound
  private counted(job: ExportJob, failure: string | null): void {
    if (failure == null) job.done += 1;
    else job.failed += 1;
    // The file it belonged to is counted now, and the next one has not been started.
    job.fraction = 0;
  }

  @action.bound
  private failed(error: string): void {
    this.store.error = error;
  }

  /**
   * What the reader is told a finished run did, the dialog it was started from being long
   * closed. A run stopped before anything landed says nothing: they know, they stopped it.
   */
  @action.bound
  private settle(job: ExportJob, reason: string | null): void {
    const { done, failed } = job;
    if (failed > 0) return this.toasts.show(ExportStrings.someFailed(failed, done, reason));
    if (done > 0) this.toasts.show(ExportStrings.done(done));
  }
}
