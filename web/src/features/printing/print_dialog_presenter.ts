import { action } from 'mobx';
import { printerProfilesApi } from '../../api/printer_profiles';
import { printingApi, type PrintingSource } from '../../api/printing';
import { openPrinterSettings, printPage, printsThroughSystemDialog } from '../../api/transport';
import { marginChoices } from '../../../../src/schemas/print_layout';
import type { Printer, PrinterCapabilities } from '../../../../src/schemas/printing';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { PrintDialogStrings as strings } from './print_dialog.strings';
import type { PrintDialogStore, PrintPhoto, PrintSettings } from './print_dialog_store';

export type PrintShell = {
  /** Whether Android's print dialog, laying out the page, takes the place of ours. */
  systemDialog: () => boolean;
  openSettings: (printer: Printer) => Promise<void>;
  printPage: (jobName: string) => Promise<void>;
};

const SHELL: PrintShell = {
  systemDialog: printsThroughSystemDialog,
  openSettings: openPrinterSettings,
  printPage,
};

const SHEET_LONG_EDGE = 3600;
const POLL_MS = 2000;
const POLLS = 15;

export class PrintDialogPresenter {
  private printersRequest: AbortController | null = null;
  private capabilitiesRequest: AbortController | null = null;

  constructor(
    private readonly store: PrintDialogStore,
    private readonly toasts: Pick<ToastsPresenter, 'show' | 'showError'>,
    private readonly api: PrintingSource = printingApi,
    private readonly files: { list(): Promise<string[]> } = printerProfilesApi,
    private readonly shell: PrintShell = SHELL,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  @action.bound
  openFor(photo: PrintPhoto): void {
    if (this.shell.systemDialog()) {
      void this.printThroughSystem(photo);
      return;
    }
    this.store.photo = photo;
    this.store.error = null;
    this.store.submitting = false;
    this.store.open = true;
    void this.listPrinters();
    void this.listFiles();
  }

  @action.bound
  close(): void {
    this.printersRequest?.abort();
    this.capabilitiesRequest?.abort();
    this.store.open = false;
  }

  @action.bound
  choosePrinter(id: string): void {
    this.store.printerId = id;
    this.store.capabilities = { kind: 'loading' };
    void this.describe(id);
  }

  @action.bound
  set<K extends keyof PrintSettings>(key: K, value: PrintSettings[K]): void {
    const described = this.store.described;
    const settings = { ...this.store.settings, [key]: value };
    this.store.settings = described == null ? settings : this.settled(settings, described);
  }

  @action.bound
  typeCopies(typed: string): void {
    this.store.copiesTyped = typed;
    const copies = Number(typed);
    if (Number.isInteger(copies) && copies >= 1) this.set('copies', copies);
  }

  @action.bound
  async openPrinterSettings(): Promise<void> {
    const printer = this.store.printer;
    if (printer == null) return;
    try {
      await this.shell.openSettings(printer);
    } catch {
      this.toasts.showError(strings.settingsDidNotOpen());
    }
  }

  @action.bound
  async print(): Promise<void> {
    const request = this.store.request;
    const printer = this.store.printer;
    if (request == null || printer == null || this.store.submitting) return;
    this.submitting(true);
    let jobId: number;
    try {
      jobId = await this.api.submit(request);
    } catch {
      this.failed(strings.didNotReachPrinter());
      return;
    }
    this.submitting(false);
    this.close();
    this.toasts.show(strings.sent(printer.name));
    await this.watch(printer, jobId);
  }

  /** Called by the sheet once its picture has loaded, which is when the page is worth printing. */
  sheetLoaded = async (): Promise<void> => {
    const sheet = this.store.sheet;
    if (sheet == null) return;
    try {
      await this.shell.printPage(sheet.name);
    } catch {
      this.toasts.showError(strings.didNotReachPrinter());
    }
  };

  private async listPrinters(): Promise<void> {
    this.printersRequest?.abort();
    const request = new AbortController();
    this.printersRequest = request;
    this.listing();
    try {
      const printers = await this.api.printers(request.signal);
      if (!request.signal.aborted) this.listed(printers);
    } catch {
      if (!request.signal.aborted) this.listFailed();
    }
  }

  private async listFiles(): Promise<void> {
    try {
      this.listedFiles(await this.files.list());
    } catch {
      this.listedFiles([]);
    }
  }

  private async describe(id: string): Promise<void> {
    this.capabilitiesRequest?.abort();
    const request = new AbortController();
    this.capabilitiesRequest = request;
    try {
      const described = await this.api.capabilities(id, request.signal);
      if (!request.signal.aborted) this.described(id, described);
    } catch {
      if (!request.signal.aborted) this.describeFailed(id);
    }
  }

  private async watch(printer: Printer, jobId: number): Promise<void> {
    for (let poll = 0; poll < POLLS; poll++) {
      await this.wait(POLL_MS);
      const job = await this.api.job(printer.id, jobId).catch(() => null);
      switch (job?.state) {
        case 'completed':
          this.toasts.show(strings.printed(printer.name));
          return;
        case 'held':
          this.toasts.show(strings.held(printer.name));
          return;
        case 'canceled':
          this.toasts.show(strings.cancelled());
          return;
        case 'stopped':
        case 'aborted':
          this.toasts.showError(strings.stopped(printer.name), job.reasons.join(', '));
          return;
      }
    }
  }

  private async printThroughSystem(photo: PrintPhoto): Promise<void> {
    const scale = Math.min(1, SHEET_LONG_EDGE / Math.max(photo.width, photo.height));
    try {
      const png = await this.api.sheet({
        photoId: photo.id,
        width: Math.max(1, Math.round(photo.width * scale)),
        height: Math.max(1, Math.round(photo.height * scale)),
      });
      this.showSheet(URL.createObjectURL(png), photo.name);
    } catch {
      this.toasts.showError(strings.couldNotPrepare());
    }
  }

  @action.bound
  private showSheet(url: string, name: string): void {
    if (this.store.sheet != null) URL.revokeObjectURL(this.store.sheet.url);
    this.store.sheet = { url, name };
  }

  @action.bound
  private listing(): void {
    this.store.printers = { kind: 'loading' };
  }

  @action.bound
  private listed(printers: Printer[]): void {
    this.store.printers = { kind: 'ready', value: printers };
    const kept = printers.find((printer) => printer.id === this.store.printerId);
    const chosen = kept ?? printers.find((printer) => printer.isDefault) ?? printers[0];
    if (chosen == null) {
      this.store.printerId = null;
      return;
    }
    this.choosePrinter(chosen.id);
  }

  @action.bound
  private listFailed(): void {
    this.store.printers = { kind: 'failed' };
  }

  @action.bound
  private listedFiles(names: string[]): void {
    this.store.fileProfiles = names;
  }

  @action.bound
  private described(id: string, described: PrinterCapabilities): void {
    if (this.store.printerId !== id) return;
    this.store.capabilities = { kind: 'ready', value: described };
    this.store.settings = this.settled(this.store.settings, described);
  }

  @action.bound
  private describeFailed(id: string): void {
    if (this.store.printerId === id) this.store.capabilities = { kind: 'failed' };
  }

  @action.bound
  private submitting(submitting: boolean): void {
    this.store.submitting = submitting;
    this.store.error = null;
  }

  @action.bound
  private failed(error: string): void {
    this.store.submitting = false;
    this.store.error = error;
  }

  /** The settings, with each choice this printer cannot take replaced by its nearest default. */
  private settled(settings: PrintSettings, described: PrinterCapabilities): PrintSettings {
    const media =
      described.media.find((each) => each.key === settings.media) ??
      described.media.find((each) => each.key === described.defaultMedia) ??
      described.media[0];
    const mediaType = described.mediaTypes.some((each) => each.key === settings.mediaType)
      ? settings.mediaType
      : (described.defaultMediaType ?? described.mediaTypes[0]?.key ?? null);
    const margin =
      media != null && marginChoices(media).includes(settings.margin) ? settings.margin : 'minimum';
    const wanted = settings.profile;
    const profiles = this.store.profiles;
    const profile =
      profiles.find((each) => each.from === wanted?.from && each.name === wanted.name) ??
      profiles.find((each) => each.from === 'printer') ??
      null;
    return {
      ...settings,
      media: media?.key ?? null,
      mediaType,
      margin,
      profile,
    };
  }
}
