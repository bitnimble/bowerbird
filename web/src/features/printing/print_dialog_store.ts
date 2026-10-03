import { computed, observable } from 'mobx';
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

export class PrintDialogStore {
  @observable accessor open = false;
  @observable.ref accessor photo: PrintPhoto | null = null;
  @observable.ref accessor printers: Fetched<Printer[]> = { kind: 'loading' };
  @observable accessor printerId: string | null = null;
  @observable.ref accessor capabilities: Fetched<PrinterCapabilities> = { kind: 'loading' };
  @observable.ref accessor fileProfiles: string[] = [];
  @observable.ref accessor settings: PrintSettings = DEFAULT_PRINT_SETTINGS;
  @observable accessor submitting = false;
  @observable accessor error: string | null = null;
  /** The rendered photo the system print dialog lays out, where that dialog is ours to use. */
  @observable.ref accessor sheet: PrintSheet | null = null;

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
    const { photo, printer, colour, layout, media, dpi, settings } = this;
    if (photo == null || printer == null || colour == null || layout == null) return null;
    if (media == null || dpi == null) return null;
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
