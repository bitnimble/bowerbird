import { action, comparer, reaction } from 'mobx';
import { printerProfilesApi } from '../../api/printer_profiles';
import { printingApi, type PrintingSource } from '../../api/printing';
import { ApiError } from '../../api/request';
import { openPrinterSettings, printPage, printsThroughSystemDialog } from '../../api/transport';
import { marginChoices } from '../../../../src/schemas/print_layout';
import {
  PRINT_COPIES_MAX,
  PrintUnconfirmedSchema,
  type Printer,
  type PrinterCapabilities,
  type PrintPreviewRequest,
} from '../../../../src/schemas/printing';
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
const PREVIEW_SETTLE_MS = 250;
const POLL_MS = 2000;
const POLLS = 15;

const JOB_REASONS: Record<string, () => string> = {
  'media-empty': strings.outOfPaper,
  'media-needed': strings.outOfPaper,
  'media-jam': strings.paperJam,
  'marker-supply-empty': strings.outOfInk,
  'cover-open': strings.coverOpen,
  'door-open': strings.coverOpen,
  offline: strings.printerOffline,
  shutdown: strings.printerOffline,
};

function reasonsOf(reasons: string[]): string | null {
  const known = new Set(
    reasons.flatMap((reason) => {
      const named = JOB_REASONS[reason.replace(/-(?:error|warning|report)$/, '')];
      return named == null ? [] : [named()];
    }),
  );
  return known.size === 0 ? null : [...known].join(', ');
}

function unconfirmed(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.details ?? []).some((detail) => PrintUnconfirmedSchema.safeParse(detail).success)
  );
}

type SheetPrint = 'idle' | 'preparing' | 'ready' | 'printing';

export class PrintDialogPresenter {
  private printersRequest: AbortController | null = null;
  private capabilitiesRequest: AbortController | null = null;
  private previewRequest: AbortController | null = null;
  private stopPreviewing: () => void = () => {};
  private settingsOpen = false;
  private opening = 0;
  private sheetPrint: SheetPrint = 'idle';

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
  openFor = (photo: PrintPhoto): void => {
    if (this.shell.systemDialog()) {
      void this.printThroughSystem(photo);
      return;
    }
    this.opening += 1;
    this.store.photo = photo;
    this.store.error = null;
    this.store.submitting = false;
    this.store.open = true;
    this.stopPreviewing();
    this.stopPreviewing = reaction(
      () => this.store.previewAsked,
      (asked) => void this.loadPreview(asked),
      { delay: PREVIEW_SETTLE_MS, equals: comparer.structural, fireImmediately: true },
    );
    void this.listPrinters();
    void this.listFiles();
  };

  @action.bound
  close = (): void => {
    this.printersRequest?.abort();
    this.capabilitiesRequest?.abort();
    this.stopPreviewing();
    this.previewRequest?.abort();
    this.showPreview(null);
    this.settingsOpen = false;
    this.store.open = false;
  };

  /** The app's window took the focus back, which is how a reader returns from the system's settings. */
  @action.bound
  windowFocused = (): void => {
    if (this.settingsOpen) this.rereadPrinter();
  };

  @action.bound
  choosePrinter = (id: string): void => {
    this.store.printerId = id;
    this.store.capabilities = { kind: 'loading' };
    void this.describe(id);
  };

  @action.bound
  set = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]): void => {
    const described = this.store.described;
    const settings = { ...this.store.settings, [key]: value };
    this.apply(described == null ? settings : this.settled(settings, described));
  };

  @action.bound
  typeCopies = (typed: string): void => {
    this.store.copiesTyped = typed;
    const copies = Number(typed);
    if (!Number.isInteger(copies) || copies < 1) return;
    this.set('copies', copies);
    if (this.store.settings.copies !== copies)
      this.store.copiesTyped = String(this.store.settings.copies);
  };

  @action.bound
  openPrinterSettings = async (): Promise<void> => {
    const printer = this.store.printer;
    if (printer == null) return;
    this.settingsOpen = true;
    try {
      await this.shell.openSettings(printer);
    } catch {
      this.settingsOpen = false;
      this.toasts.showError(strings.settingsDidNotOpen());
    }
  };

  @action.bound
  print = async (): Promise<void> => {
    const request = this.store.request;
    const printer = this.store.printer;
    if (request == null || printer == null || this.store.submitting) return;
    const opening = this.opening;
    this.submitting(true);
    let jobId: number | null;
    try {
      jobId = await this.api.submit(request);
    } catch (err) {
      this.failed(opening, unconfirmed(err) ? strings.lostTrack() : strings.didNotReachPrinter());
      return;
    }
    this.sent(opening);
    this.toasts.show(strings.sent(printer.name));
    if (jobId != null) await this.watch(printer, jobId);
  };

  /** Called by the sheet once its picture has loaded, which is when the page is worth printing. */
  sheetLoaded = async (url: string): Promise<void> => {
    const sheet = this.store.sheet;
    if (this.sheetPrint !== 'ready' || sheet?.url !== url) return;
    this.sheetPrint = 'printing';
    try {
      await this.shell.printPage(sheet.name);
    } catch {
      this.toasts.showError(strings.printDialogDidNotOpen());
    } finally {
      this.sheetPrint = 'idle';
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

  /** The printer's options again, taking up its defaults: the settings may have changed them. */
  private rereadPrinter(): void {
    this.settingsOpen = false;
    const id = this.store.printerId;
    if (id != null && this.store.open) void this.describe(id, true);
  }

  private async describe(id: string, adoptDefaults = false): Promise<void> {
    this.capabilitiesRequest?.abort();
    const request = new AbortController();
    this.capabilitiesRequest = request;
    try {
      const described = await this.api.capabilities(id, request.signal);
      if (!request.signal.aborted) this.described(id, described, adoptDefaults);
    } catch {
      if (!request.signal.aborted && !adoptDefaults) this.describeFailed(id);
    }
  }

  private async loadPreview(asked: PrintPreviewRequest | null): Promise<void> {
    this.previewRequest?.abort();
    if (asked == null) return;
    const request = new AbortController();
    this.previewRequest = request;
    try {
      const png = await this.api.preview(asked, request.signal);
      if (!request.signal.aborted) this.showPreview({ asked, url: URL.createObjectURL(png) });
    } catch {
      if (!request.signal.aborted) this.showPreview({ asked, url: null });
    }
  }

  @action.bound
  private showPreview = (preview: PrintDialogStore['preview']): void => {
    const shown = this.store.preview?.url;
    if (shown != null) URL.revokeObjectURL(shown);
    this.store.preview = preview;
  };

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
          this.toasts.showError(strings.stopped(printer.name), reasonsOf(job.reasons) ?? undefined);
          return;
      }
    }
  }

  private async printThroughSystem(photo: PrintPhoto): Promise<void> {
    if (this.sheetPrint === 'preparing' || this.sheetPrint === 'printing') return;
    this.sheetPrint = 'preparing';
    const scale = Math.min(1, SHEET_LONG_EDGE / Math.max(photo.width, photo.height));
    let png: Blob;
    try {
      png = await this.api.sheet({
        photoId: photo.id,
        width: Math.max(1, Math.round(photo.width * scale)),
        height: Math.max(1, Math.round(photo.height * scale)),
      });
    } catch {
      this.sheetPrint = 'idle';
      this.toasts.showError(strings.couldNotPrepare());
      return;
    }
    this.sheetPrint = 'ready';
    this.showSheet(URL.createObjectURL(png), photo.name);
  }

  @action.bound
  private showSheet = (url: string, name: string): void => {
    if (this.store.sheet != null) URL.revokeObjectURL(this.store.sheet.url);
    this.store.sheet = { url, name };
  };

  @action.bound
  private listing = (): void => {
    this.store.printers = { kind: 'loading' };
  };

  @action.bound
  private listed = (printers: Printer[]): void => {
    this.store.printers = { kind: 'ready', value: printers };
    const kept = printers.find((printer) => printer.id === this.store.printerId);
    const chosen = kept ?? printers.find((printer) => printer.isDefault) ?? printers[0];
    if (chosen == null) {
      this.store.printerId = null;
      return;
    }
    this.choosePrinter(chosen.id);
  };

  @action.bound
  private listFailed = (): void => {
    this.store.printers = { kind: 'failed' };
  };

  @action.bound
  private listedFiles = (names: string[]): void => {
    this.store.fileProfiles = names;
    const described = this.store.described;
    if (described != null) this.apply(this.settled(this.store.settings, described));
  };

  @action.bound
  private described = (
    id: string,
    described: PrinterCapabilities,
    adoptDefaults: boolean,
  ): void => {
    if (this.store.printerId !== id) return;
    const before = this.store.described;
    this.store.capabilities = { kind: 'ready', value: described };
    const { settings } = this.store;
    const changed = (now: string | null, was: string | null | undefined): string | null =>
      adoptDefaults && now !== was ? now : null;
    this.apply(
      this.settled(
        {
          ...settings,
          media: changed(described.defaultMedia, before?.defaultMedia) ?? settings.media,
          mediaType:
            changed(described.defaultMediaType, before?.defaultMediaType) ?? settings.mediaType,
        },
        described,
      ),
    );
  };

  @action.bound
  private describeFailed = (id: string): void => {
    if (this.store.printerId === id) this.store.capabilities = { kind: 'failed' };
  };

  @action.bound
  private submitting = (submitting: boolean): void => {
    this.store.submitting = submitting;
    this.store.error = null;
  };

  @action.bound
  private sent = (opening: number): void => {
    if (opening !== this.opening) return;
    this.store.submitting = false;
    this.close();
  };

  @action.bound
  private failed = (opening: number, error: string): void => {
    if (opening !== this.opening) {
      this.toasts.showError(error);
      return;
    }
    this.store.submitting = false;
    this.store.error = error;
  };

  private apply(settings: PrintSettings): void {
    if (settings.copies !== this.store.settings.copies)
      this.store.copiesTyped = String(settings.copies);
    this.store.settings = settings;
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
      profiles[0] ??
      null;
    return {
      ...settings,
      media: media?.key ?? null,
      mediaType,
      margin,
      copies: Math.min(settings.copies, described.copiesMax, PRINT_COPIES_MAX),
      profile,
    };
  }
}
