import { beforeEach, describe, expect, test } from 'bun:test';
import type { PrintingSource } from '../../../api/printing';
import { ApiError } from '../../../api/request';
import type {
  Printer,
  PrinterCapabilities,
  PrintJobState,
  PrintPreviewRequest,
  PrintRequest,
} from '../../../../../src/schemas/printing';
import { PrintDialogPresenter, type PrintShell } from '../print_dialog_presenter';
import { PrintDialogStore, type PrintPhoto } from '../print_dialog_store';

const PRO_200: Printer = {
  id: 'cups:Canon_PRO_200S',
  name: 'Canon PRO-200S',
  isDefault: true,
  location: null,
  model: 'Canon PRO-200S',
  connection: 'usb',
};

const OFFICE: Printer = {
  id: 'cups:Office',
  name: 'Office laser',
  isDefault: false,
  location: 'Hall',
  model: null,
  connection: 'network',
};

const A4 = {
  key: 'iso_a4_210x297mm',
  name: 'A4',
  widthMm: 210,
  heightMm: 297,
  margins: { top: 3.4, right: 3.4, bottom: 3.4, left: 3.4 },
  borderless: true,
};

const LETTER = {
  key: 'na_letter_8.5x11in',
  name: null,
  widthMm: 215.9,
  heightMm: 279.4,
  margins: { top: 5, right: 5, bottom: 5, left: 5 },
  borderless: false,
};

const PRO_200_OPTIONS: PrinterCapabilities = {
  media: [LETTER, A4],
  defaultMedia: A4.key,
  mediaTypes: [
    { key: 'stationery', name: 'Plain paper' },
    { key: 'photographic-glossy', name: 'Photo paper pro luster' },
  ],
  defaultMediaType: 'photographic-glossy',
  resolutionsDpi: [300, 600],
  copiesMax: 5,
  colour: {
    transports: [
      { space: 'device', bits: 16 },
      { space: 'adobe-rgb', bits: 8 },
      { space: 'srgb', bits: 8 },
    ],
    profiles: [{ name: 'PRO-200 Luster', source: 'printer' }],
  },
};

const OFFICE_OPTIONS: PrinterCapabilities = {
  media: [LETTER],
  defaultMedia: null,
  mediaTypes: [],
  defaultMediaType: null,
  resolutionsDpi: [600],
  copiesMax: 99,
  colour: { transports: [{ space: 'srgb', bits: 8 }], profiles: [] },
};

const PHOTO: PrintPhoto = { id: 'photo-1', name: 'DSC0001.ARW', width: 6000, height: 4000 };

type Pending<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

class FakePrinting implements PrintingSource {
  printersAsked: Pending<Printer[]>[] = [];
  capabilitiesAsked: { id: string; pending: Pending<PrinterCapabilities> }[] = [];
  submitted: PrintRequest[] = [];
  submitFails: Error | null = null;
  submitGate: Promise<void> = Promise.resolve();
  jobId: number | null = 7;
  jobsAsked = 0;
  jobStates: PrintJobState[] = [];
  sheets: { photoId: string; width: number; height: number }[] = [];

  printers = (): Promise<Printer[]> =>
    new Promise((resolve, reject) => this.printersAsked.push({ resolve, reject }));
  capabilities = (id: string): Promise<PrinterCapabilities> =>
    new Promise((resolve, reject) =>
      this.capabilitiesAsked.push({ id, pending: { resolve, reject } }),
    );
  profile = (): Promise<Uint8Array<ArrayBuffer>> => Promise.resolve(new Uint8Array());
  submit = async (request: PrintRequest): Promise<number | null> => {
    this.submitted.push(request);
    await this.submitGate;
    if (this.submitFails != null) throw this.submitFails;
    return this.jobId;
  };
  job = (): Promise<PrintJobState> => {
    this.jobsAsked += 1;
    return Promise.resolve(this.jobStates.shift() ?? { state: 'processing', reasons: [] });
  };
  previews: PrintPreviewRequest[] = [];
  preview = (asked: PrintPreviewRequest): Promise<Blob> => {
    this.previews.push(asked);
    return Promise.resolve(new Blob([new Uint8Array(4)], { type: 'image/png' }));
  };
  sheetGate: Promise<void> = Promise.resolve();
  sheet = async (sheet: { photoId: string; width: number; height: number }): Promise<Blob> => {
    this.sheets.push(sheet);
    await this.sheetGate;
    return new Blob([new Uint8Array(4)], { type: 'image/png' });
  };

  describe(id: string, options: PrinterCapabilities): void {
    const asked = this.capabilitiesAsked.filter((each) => each.id === id).at(-1);
    asked?.pending.resolve(options);
  }
}

class FakeToasts {
  shown: string[] = [];
  errors: { message: string; detail?: string }[] = [];
  show = (message: string): void => void this.shown.push(message);
  showError = (message: string, detail?: string): void =>
    void this.errors.push({ message, detail });
}

let store: PrintDialogStore;
let api: FakePrinting;
let toasts: FakeToasts;
let printed: string[];
let systemDialog: boolean;
let presenter: PrintDialogPresenter;
let files: Promise<string[]>;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  files = Promise.resolve(['Hahnemuhle Photo Rag.icc']);
  store = new PrintDialogStore();
  api = new FakePrinting();
  toasts = new FakeToasts();
  printed = [];
  systemDialog = false;
  const shell: PrintShell = {
    systemDialog: () => systemDialog,
    openSettings: () => Promise.resolve(),
    printPage: (name) => {
      printed.push(name);
      return Promise.resolve();
    },
  };
  presenter = new PrintDialogPresenter(store, toasts, api, { list: () => files }, shell, () =>
    Promise.resolve(),
  );
});

async function openOnPro200(): Promise<void> {
  presenter.openFor(PHOTO);
  api.printersAsked[0]?.resolve([OFFICE, PRO_200]);
  await settle();
  api.describe(PRO_200.id, PRO_200_OPTIONS);
  await settle();
}

const previewSettled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

describe('the preview', () => {
  test('shows the photo as this printer is sent it, and asks again only when that changes', async () => {
    await openOnPro200();
    await previewSettled();
    expect(api.previews).toEqual([
      {
        photoId: 'photo-1',
        printer: PRO_200.id,
        colour: {
          kind: 'profile',
          bits: 16,
          profile: { from: 'printer', name: 'PRO-200 Luster' },
        },
        intent: 'perceptual',
        width: 900,
        height: 600,
      },
    ]);
    expect(store.previewState).toBe('ready');
    const first = store.previewUrl;
    expect(first).not.toBeNull();

    presenter.set('media', LETTER.key);
    presenter.set('fit', 'fill');
    await previewSettled();
    expect(api.previews).toHaveLength(1);

    presenter.set('intent', 'relativeColorimetric');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.previewUrl).toBe(first);
    await previewSettled();
    expect(api.previews.at(-1)?.intent).toBe('relativeColorimetric');
    expect(store.previewUrl).not.toBe(first);
  });

  test('notes only a colour that falls short of 16-bit Adobe RGB', async () => {
    await openOnPro200();
    expect(store.colourShortfall).toBeNull();
    const taking = (bits: 8 | 16): PrinterCapabilities => ({
      ...OFFICE_OPTIONS,
      colour: { transports: [{ space: 'adobe-rgb', bits }], profiles: [] },
    });
    for (const [options, shortfall] of [
      [taking(16), null],
      [taking(8), 'eight-bit'],
      [OFFICE_OPTIONS, 'srgb'],
    ] as const) {
      presenter.choosePrinter(OFFICE.id);
      api.describe(OFFICE.id, options);
      await settle();
      expect(store.colourShortfall).toBe(shortfall);
    }
  });
});

describe('the printer settings', () => {
  test('coming back from them reads the printer again and takes up its new defaults', async () => {
    await openOnPro200();
    presenter.set('media', LETTER.key);
    presenter.set('mediaType', 'stationery');
    await presenter.openPrinterSettings();
    api.describe(PRO_200.id, {
      ...PRO_200_OPTIONS,
      defaultMedia: A4.key,
      defaultMediaType: 'photographic-glossy',
    });
    await settle();
    expect(store.settings).toMatchObject({ media: A4.key, mediaType: 'photographic-glossy' });
  });

  test('a window regaining focus with no settings opened reads nothing', async () => {
    await openOnPro200();
    const asked = api.capabilitiesAsked.length;
    presenter.windowFocused();
    expect(api.capabilitiesAsked).toHaveLength(asked);
  });
});

describe('PrintDialogPresenter', () => {
  test('opening loads the printers, chooses the default, and fills its defaults', async () => {
    presenter.openFor(PHOTO);
    expect(store.open).toBe(true);
    expect(store.printers).toEqual({ kind: 'loading' });

    api.printersAsked[0]?.resolve([OFFICE, PRO_200]);
    await settle();
    expect(store.printerId).toBe(PRO_200.id);
    expect(store.capabilities).toEqual({ kind: 'loading' });

    api.describe(PRO_200.id, PRO_200_OPTIONS);
    await settle();
    expect(store.settings).toEqual({
      media: 'iso_a4_210x297mm',
      mediaType: 'photographic-glossy',
      margin: 'minimum',
      fit: 'fit',
      copies: 1,
      intent: 'perceptual',
      profile: { from: 'printer', name: 'PRO-200 Luster' },
    });
    expect(store.profiles).toEqual([
      { from: 'printer', name: 'PRO-200 Luster' },
      { from: 'file', name: 'Hahnemuhle Photo Rag.icc' },
    ]);
    expect(store.request).toEqual({
      photoId: 'photo-1',
      printer: PRO_200.id,
      colour: { kind: 'profile', bits: 16, profile: { from: 'printer', name: 'PRO-200 Luster' } },
      intent: 'perceptual',
      quarterTurns: 1,
      job: {
        name: 'DSC0001.ARW',
        media: 'iso_a4_210x297mm',
        mediaType: 'photographic-glossy',
        borderless: false,
        copies: 1,
        resolutionDpi: 300,
        page: { widthPx: 2480, heightPx: 3508 },
        place: { x: 98, y: 41, width: 2284, height: 3426 },
      },
    });
  });

  test('a printer described after another was chosen does not replace it', async () => {
    await openOnPro200();
    presenter.choosePrinter(OFFICE.id);
    presenter.choosePrinter(PRO_200.id);
    api.describe(PRO_200.id, PRO_200_OPTIONS);
    const office = api.capabilitiesAsked.find((each) => each.id === OFFICE.id);
    office?.pending.resolve(OFFICE_OPTIONS);
    await settle();
    expect(store.printerId).toBe(PRO_200.id);
    expect(store.described?.copiesMax).toBe(5);
  });

  test('a printer with only sRGB takes no profile and drops what its paper cannot do', async () => {
    await openOnPro200();
    presenter.set('margin', 'borderless');
    presenter.set('copies', 3);
    presenter.choosePrinter(OFFICE.id);
    api.describe(OFFICE.id, OFFICE_OPTIONS);
    await settle();
    expect(store.settings).toMatchObject({
      media: 'na_letter_8.5x11in',
      mediaType: null,
      margin: 'minimum',
      copies: 3,
      profile: null,
    });
    expect(store.colour).toEqual({ kind: 'srgb', bits: 8 });
  });

  test('copies stay within what the printer takes, and the field shows the count kept', async () => {
    await openOnPro200();
    presenter.typeCopies('40');
    expect(store.request?.job.copies).toBe(5);
    expect(store.copiesTyped).toBe('5');
    presenter.typeCopies('40');
    expect(store.copiesTyped).toBe('5');
  });

  test('a printer taking fewer copies lowers the count and the field with it', async () => {
    await openOnPro200();
    presenter.choosePrinter(OFFICE.id);
    api.describe(OFFICE.id, OFFICE_OPTIONS);
    await settle();
    presenter.typeCopies('40');
    presenter.choosePrinter(PRO_200.id);
    api.describe(PRO_200.id, PRO_200_OPTIONS);
    await settle();
    expect(store.settings.copies).toBe(5);
    expect(store.copiesTyped).toBe('5');
  });

  test('profile files that arrive after the printer was described fill the profile', async () => {
    let listed: (names: string[]) => void = () => {};
    files = new Promise((resolve) => {
      listed = resolve;
    });
    presenter.openFor(PHOTO);
    api.printersAsked[0]?.resolve([PRO_200]);
    await settle();
    api.describe(PRO_200.id, {
      ...PRO_200_OPTIONS,
      colour: { ...PRO_200_OPTIONS.colour, profiles: [] },
    });
    await settle();
    expect(store.settings.profile).toBeNull();
    listed(['Hahnemuhle Photo Rag.icc']);
    await settle();
    expect(store.settings.profile).toEqual({ from: 'file', name: 'Hahnemuhle Photo Rag.icc' });
  });

  test('clearing copies to retype them keeps the last count until a new one is typed', async () => {
    await openOnPro200();
    presenter.typeCopies('3');
    presenter.typeCopies('');
    expect(store.copiesTyped).toBe('');
    expect(store.request?.job.copies).toBe(3);
    presenter.typeCopies('2');
    expect(store.request?.job.copies).toBe(2);
  });

  test('a listing that fails says so for the printer field alone', async () => {
    presenter.openFor(PHOTO);
    api.printersAsked[0]?.reject(new Error('cups is down'));
    await settle();
    expect(store.printers).toEqual({ kind: 'failed' });
    expect(store.request).toBeNull();
  });

  test('printing sends the request, closes, and reports how the job went', async () => {
    await openOnPro200();
    api.jobStates = [
      { state: 'pending', reasons: [] },
      { state: 'completed', reasons: [] },
    ];
    await presenter.print();
    expect(api.submitted).toHaveLength(1);
    expect(store.open).toBe(false);
    expect(toasts.shown).toEqual(['Sent to Canon PRO-200S.', 'Printed on Canon PRO-200S.']);
  });

  test('a stopped job is reported with what the printer said, in words', async () => {
    await openOnPro200();
    api.jobStates = [
      {
        state: 'stopped',
        reasons: ['media-empty-error', 'media-needed', 'job-hold-until-specified'],
      },
    ];
    await presenter.print();
    expect(toasts.errors).toEqual([
      { message: 'Canon PRO-200S stopped printing.', detail: 'Out of paper' },
    ]);
  });

  test('a stopped job with no reason a reader can act on says only that it stopped', async () => {
    await openOnPro200();
    api.jobStates = [{ state: 'aborted', reasons: ['job-canceled-at-device'] }];
    await presenter.print();
    expect(toasts.errors).toEqual([
      { message: 'Canon PRO-200S stopped printing.', detail: undefined },
    ]);
  });

  test('a print sent without a job number is reported sent and not watched', async () => {
    await openOnPro200();
    api.jobId = null;
    await presenter.print();
    expect(store.open).toBe(false);
    expect(toasts.shown).toEqual(['Sent to Canon PRO-200S.']);
    expect(api.jobsAsked).toBe(0);
  });

  test('a submit that fails keeps the dialog open and says the photo did not arrive', async () => {
    await openOnPro200();
    api.submitFails = new Error('offline');
    await presenter.print();
    expect(store.open).toBe(true);
    expect(store.submitting).toBe(false);
    expect(store.error).toBe("The photo didn't reach the printer.");
  });

  test('a submit the printer never confirmed says the print may still arrive', async () => {
    await openOnPro200();
    api.submitFails = new ApiError('UNAVAILABLE', 'no answer', 503, [{ printUnconfirmed: true }]);
    await presenter.print();
    expect(store.error).toBe('We lost track of the print. It may still print.');
  });

  test('a print still sending leaves a dialog reopened for another photo open', async () => {
    await openOnPro200();
    let release: () => void = () => {};
    api.submitGate = new Promise((resolve) => {
      release = resolve;
    });
    const printing = presenter.print();
    presenter.close();
    presenter.openFor({ ...PHOTO, id: 'photo-2', name: 'DSC0002.ARW' });
    release();
    await printing;
    expect(store.open).toBe(true);
    expect(store.photo?.id).toBe('photo-2');
    expect(toasts.shown[0]).toBe('Sent to Canon PRO-200S.');
  });

  test('on Android the photo goes to the system dialog as a sheet, printed once it loads', async () => {
    systemDialog = true;
    presenter.openFor(PHOTO);
    await settle();
    expect(store.open).toBe(false);
    expect(api.sheets).toEqual([{ photoId: 'photo-1', width: 3600, height: 2400 }]);
    expect(store.sheet?.name).toBe('DSC0001.ARW');
    expect(printed).toEqual([]);
    await presenter.sheetLoaded(store.sheet?.url ?? '');
    expect(printed).toEqual(['DSC0001.ARW']);
    await presenter.sheetLoaded(store.sheet?.url ?? '');
    expect(printed).toEqual(['DSC0001.ARW']);
  });

  test('on Android a second tap while the sheet is being prepared is ignored', async () => {
    systemDialog = true;
    let release: () => void = () => {};
    api.sheetGate = new Promise((resolve) => {
      release = resolve;
    });
    presenter.openFor(PHOTO);
    presenter.openFor({ ...PHOTO, id: 'photo-2' });
    release();
    await settle();
    expect(api.sheets.map((sheet) => sheet.photoId)).toEqual(['photo-1']);
    await presenter.sheetLoaded('blob:stale');
    expect(printed).toEqual([]);
  });
});
