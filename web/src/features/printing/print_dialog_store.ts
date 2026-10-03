import { comparer, computed, observable } from 'mobx';
import type { RenderingIntent } from '../../../../src/schemas/rendering_intent';
import {
  marginChoices,
  printLayout,
  printResolution,
  type Fit,
  type Margin,
  type PrintLayout,
} from '../../../../src/schemas/print_layout';
import {
  colourPath,
  type ColourPath,
  type Media,
  type Printer,
  type PrinterCapabilities,
  type PrintPreviewRequest,
  type PrintRequest,
  type ProfileRef,
} from '../../../../src/schemas/printing';

export type Fetched<T> = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; value: T };

/** The photo as it is displayed: cropped, straightened and turned. */
export type PrintPhoto = { id: string; name: string; width: number; height: number };

export type PrintSettings = {
  media: string | null;
  mediaType: string | null;
  margin: Margin;
  fit: Fit;
  copies: number;
  intent: RenderingIntent;
  profile: ProfileRef | null;
};

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  media: null,
  mediaType: null,
  margin: 'minimum',
  fit: 'fit',
  copies: 1,
  intent: 'perceptual',
  profile: null,
};

export type PrintSheet = { url: string; name: string };

const PREVIEW_LONG_EDGE = 900;

export class PrintDialogStore {
  @observable accessor open = false;
  @observable.ref accessor photo: PrintPhoto | null = null;
  @observable.ref accessor printers: Fetched<Printer[]> = { kind: 'loading' };
  @observable accessor printerId: string | null = null;
  @observable.ref accessor capabilities: Fetched<PrinterCapabilities> = { kind: 'loading' };
  @observable.ref accessor fileProfiles: string[] = [];
  @observable.ref accessor settings: PrintSettings = DEFAULT_PRINT_SETTINGS;
  @observable accessor copiesTyped = String(DEFAULT_PRINT_SETTINGS.copies);
  @observable accessor submitting = false;
  @observable accessor error: string | null = null;
  /** The rendered photo the system print dialog lays out, where that dialog is ours to use. */
  @observable.ref accessor sheet: PrintSheet | null = null;
  /** An object URL of the last preview to arrive, kept on screen while the next is fetched. */
  @observable accessor previewUrl: string | null = null;
  @observable accessor previewState: 'loading' | 'ready' | 'failed' = 'loading';

  /** What the preview should show now: the photo as the chosen printer would be sent it. */
  @computed({ equals: comparer.structural }) get previewAsked(): PrintPreviewRequest | null {
    const { photo, printer, colour } = this;
    if (photo == null || printer == null || colour == null) return null;
    const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(photo.width, photo.height));
    return {
      photoId: photo.id,
      printer: printer.id,
      colour,
      intent: this.settings.intent,
      width: Math.max(1, Math.round(photo.width * scale)),
      height: Math.max(1, Math.round(photo.height * scale)),
    };
  }

  /** The note under the preview, where the colour falls short of the best this printer could do. */
  @computed get colourShortfall(): 'srgb' | 'eight-bit' | null {
    const colour = this.colour;
    if (colour?.kind === 'srgb') return 'srgb';
    if (colour?.kind === 'adobe-rgb' && colour.bits === 8) return 'eight-bit';
    return null;
  }

  @computed get printer(): Printer | null {
    if (this.printers.kind !== 'ready') return null;
    return this.printers.value.find((printer) => printer.id === this.printerId) ?? null;
  }

  @computed get described(): PrinterCapabilities | null {
    return this.capabilities.kind === 'ready' ? this.capabilities.value : null;
  }

  @computed get media(): Media | null {
    return this.described?.media.find((media) => media.key === this.settings.media) ?? null;
  }

  @computed get margins(): Margin[] {
    return this.media == null ? [] : marginChoices(this.media);
  }

  /** Empty where the printer takes no device RGB, so no profile can apply. */
  @computed get profiles(): ProfileRef[] {
    const colour = this.described?.colour;
    if (colour == null || !colour.transports.some((each) => each.space === 'device')) return [];
    return [
      ...colour.profiles.map(({ name }) => ({ from: 'printer' as const, name })),
      ...this.fileProfiles.map((name) => ({ from: 'file' as const, name })),
    ];
  }

  @computed get colour(): ColourPath | null {
    const colour = this.described?.colour;
    return colour == null ? null : colourPath(colour, this.settings.profile);
  }

  @computed get dpi(): number | null {
    const described = this.described;
    return described == null ? null : printResolution(described.resolutionsDpi);
  }

  @computed get layout(): PrintLayout | null {
    if (this.media == null || this.photo == null || this.dpi == null) return null;
    return printLayout({
      media: this.media,
      margin: this.settings.margin,
      fit: this.settings.fit,
      dpi: this.dpi,
      photo: this.photo,
    });
  }

  /** What the Print button sends, or null until every field it needs has arrived. */
  @computed get request(): PrintRequest | null {
    const { photo, printer, colour, layout, media, dpi, settings, described } = this;
    if (photo == null || printer == null || colour == null || layout == null) return null;
    if (media == null || dpi == null || described == null) return null;
    return {
      photoId: photo.id,
      printer: printer.id,
      colour,
      intent: settings.intent,
      quarterTurns: layout.quarterTurns,
      job: {
        name: photo.name,
        media: media.key,
        mediaType: settings.mediaType,
        borderless: settings.margin === 'borderless',
        copies: settings.copies,
        resolutionDpi: dpi,
        page: layout.page,
        place: layout.place,
      },
    };
  }
}
