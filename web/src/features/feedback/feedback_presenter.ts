import { action } from 'mobx';
import { photosApi } from '../../api/photos';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import type { FeedbackStore } from './feedback_store';
import { attachmentsFor, rawFits, ReportTooLarge, REQUEST_CEILING } from './photo_attachments';
import { bugReporter } from './report_bug';
import { ReportBugStrings } from './report_bug_dialog.strings';

/** What became of a report, which is the one thing the form has left to say. */
export type Sent = 'sent' | 'too-large' | 'failed';

export interface WrittenReport {
  message: string;
  email: string;
  version: string | undefined;
  /** False leaves the photograph out of it entirely, attachments and all. */
  includePhoto: boolean;
  raw: boolean;
  strip: boolean;
}

export class FeedbackPresenter {
  private wanted: string | null = null;

  constructor(
    private readonly store: FeedbackStore,
    private readonly toasts: ToastsPresenter,
  ) {}

  /** The form with nothing about a photograph in it, from the sidebar. */
  @action.bound
  open(): void {
    this.wanted = null;
    this.store.photo = null;
    this.store.open = true;
  }

  /**
   * The form over the photograph on screen, which is what earns it the attachment controls.
   *
   * The detail is read here rather than taken from whichever store had the row, because the
   * one field the controls turn on - the size of the original - is only on the detail, and a
   * viewer that never opened the panel has never asked for one.
   */
  @action.bound
  openFor(photoId: string): void {
    this.wanted = photoId;
    this.store.photo = null;
    this.store.open = true;
    void photosApi.get(photoId).then(
      action((photo) => {
        // A second open before this landed is a different photograph, or none.
        if (this.wanted === photoId) this.store.photo = photo;
      }),
      // A detail that will not load leaves the form usable and the photograph out of it.
      () => {},
    );
  }

  /**
   * Gathers whatever the reader ticked and hands it to Sentry, closing the form once it lands.
   *
   * Reports through the toasts like every other action that finishes off screen, and answers
   * the form with what to say where it did not.
   */
  async send(report: WrittenReport): Promise<Sent> {
    const photo = this.store.photo;
    try {
      const attachments =
        photo != null && report.includePhoto ?
          await attachmentsFor({ photo, raw: report.raw && rawFits(photo), strip: report.strip })
        : [];
      // The pictures alone, since `attachmentsFor` already weighed the original against them.
      const carried = attachments.reduce((total, part) => total + part.data.byteLength, 0);
      if (carried > REQUEST_CEILING) return 'too-large';

      await bugReporter.send({
        message: report.message,
        email: report.email,
        version: report.version,
        attachments,
      });
    } catch (err) {
      return err instanceof ReportTooLarge ? 'too-large' : 'failed';
    }
    this.close();
    this.toasts.show(ReportBugStrings.sent());
    return 'sent';
  }

  @action.bound
  close(): void {
    this.wanted = null;
    this.store.open = false;
    this.store.photo = null;
  }
}
