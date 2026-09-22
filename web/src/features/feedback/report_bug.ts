import { adapterName } from '../../adapter_name';
import { type Attached, REQUEST_CEILING } from './photo_attachments';

export interface BugReport {
  message: string;
  /** Empty where the reader would rather not be replied to. */
  email: string;
  /** What this build calls itself, as the server reports it. */
  version: string | undefined;
  /** The photograph's own files, where the reader asked for them (`photo_attachments.ts`). */
  attachments: Attached[];
}

class BugReporter {
  private started = false;

  /** A build with no DSN has nowhere to send a report, so it does not offer the form. */
  canSend(): boolean {
    return this.dsn() !== '';
  }

  /** Sends what the reader wrote, and resolves once Sentry has taken it. */
  async send(report: BugReport): Promise<void> {
    const address = this.dsn();
    if (address === '') throw new Error('this build has no Sentry DSN');

    // Imported here rather than at the top of the file: a session nobody files a report in
    // loads no SDK and runs no line of it, and a static import is how that quietly becomes
    // error tracking.
    const sentry = await import('@sentry/browser');

    if (!this.started) {
      sentry.init({
        dsn: address,
        // `integrations: []` on its own leaves the defaults in place, and those are the
        // global error handler, the breadcrumbs and a session ping: everything this is not.
        defaultIntegrations: false,
        integrations: [],
        // Without this the SDK posts its own discard counts as the page unloads, from a
        // session that sent nothing.
        sendClientReports: false,
      });
      this.started = true;
    }

    // Refused here rather than by the ingest, which answers a request over its ceiling with a
    // 413 and no event at all - so a report with one file too many would simply not arrive.
    const carried = report.attachments.reduce((total, part) => total + part.data.byteLength, 0);
    if (carried > REQUEST_CEILING) throw new Error('this report is larger than Sentry will take');

    sentry.setContext('bowerbird', await this.diagnostics());
    await sentry.sendFeedback(
      {
        message: report.message,
        email: report.email === '' ? undefined : report.email,
        url: window.location.href,
        source: 'report-bug-dialog',
        tags: { version: report.version ?? 'unknown' },
      },
      { attachments: report.attachments },
    );
  }

  // Read on each call rather than once as the module loads, so it is the environment the
  // caller is in and not whichever import pulled this file in first.
  private dsn(): string {
    return import.meta.env.VITE_SENTRY_DSN ?? '';
  }

  private async diagnostics(): Promise<Record<string, string>> {
    return {
      display: `${window.screen.width}x${window.screen.height} at ${window.devicePixelRatio}x`,
      browser: window.navigator.userAgent,
      adapter: await this.adapter(),
    };
  }

  private async adapter(): Promise<string> {
    if (navigator.gpu == null) return 'no WebGPU';
    try {
      const found = await navigator.gpu.requestAdapter();
      return found == null ? 'no adapter' : adapterName(found);
    } catch {
      return 'no adapter';
    }
  }
}

export const bugReporter = new BugReporter();
