import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../errors';
import {
  MediaSchema,
  PrinterCapabilitiesSchema,
  PrinterIccSchema,
  PrintersSchema,
  PrintJobIdSchema,
  PrintJobStateSchema,
  transportOf,
  type Printer,
  type PrinterCapabilities,
  type PrintJobState,
  type PrintPreviewRequest,
  type PrintRequest,
  type PrintSheetRequest,
  type ProfileRef,
} from '../../schemas/printing';
import { deleteScratchDirectory } from '../../utils/deletions';
import { listPrinterProfiles } from '../../utils/paths';
import type { PrintRenderer, PrintRenderTarget } from '../processing/exports/print_renderer';
import { unreadable, type PrintCommand, type PrintshimRun } from './printshim';

const ASK_MS = 15_000;
const SUBMIT_MS = 15 * 60_000;
const PENDING_ASKS_PER_PRINTER = 2;
const DELETE_RETRY_MS = 10 * 60_000;

const CapabilitiesReplySchema = PrinterCapabilitiesSchema.extend({
  media: z.array(z.unknown()).transform((entries) =>
    entries.flatMap((entry) => {
      const media = MediaSchema.safeParse(entry);
      return media.success ? [media.data] : [];
    }),
  ),
});

type Ask = Exclude<PrintCommand, { kind: 'submit' }>;

export class PrintService {
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly run: PrintshimRun,
    private readonly profilesDir: string,
    private readonly render: PrintRenderer['renderPrint'],
  ) {}

  async printers(): Promise<Printer[]> {
    return replyOf(PrintersSchema, await this.ask({ kind: 'list' })).printers;
  }

  async capabilities(printer: string): Promise<PrinterCapabilities> {
    return replyOf(CapabilitiesReplySchema, await this.ask({ kind: 'capabilities', printer }));
  }

  async printerProfile(printer: string, name: string): Promise<Uint8Array> {
    const { icc } = replyOf(PrinterIccSchema, await this.ask({ kind: 'profile', printer, name }));
    return Buffer.from(icc, 'base64');
  }

  async submit(request: PrintRequest): Promise<number | null> {
    const { colour, job, printer } = request;
    return this.rendered(
      request.photoId,
      {
        ...(await this.coded(request)),
        width: job.place.width,
        height: job.place.height,
        quarterTurns: request.quarterTurns,
      },
      async (image) =>
        replyOf(
          PrintJobIdSchema,
          await this.run(
            { kind: 'submit', printer, image, job: { ...job, transport: transportOf(colour) } },
            SUBMIT_MS,
          ),
        ).jobId,
    );
  }

  /** The photo coded as its print would be, at eight bits, which shows the same colours. */
  async preview(request: PrintPreviewRequest): Promise<Uint8Array> {
    return this.rendered(
      request.photoId,
      {
        ...(await this.coded(request)),
        bits: 8,
        width: request.width,
        height: request.height,
        quarterTurns: 0,
      },
      (image) => readFile(image),
    );
  }

  async job(printer: string, jobId: number): Promise<PrintJobState> {
    return replyOf(PrintJobStateSchema, await this.ask({ kind: 'job', printer, jobId }));
  }

  /** The photo as an 8-bit sRGB PNG, for a system print dialog that does its own layout. */
  sheet({ photoId, width, height }: PrintSheetRequest): Promise<Uint8Array> {
    return this.rendered(
      photoId,
      {
        space: 'srgb',
        bits: 8,
        intent: 'perceptual',
        blackPointCompensation: true,
        icc: null,
        width,
        height,
        quarterTurns: 0,
      },
      (image) => readFile(image),
    );
  }

  private async ask(command: Ask): Promise<unknown> {
    const key = command.kind === 'list' ? '' : command.printer;
    const pending = this.pending.get(key) ?? 0;
    if (pending >= PENDING_ASKS_PER_PRINTER)
      throw new AppError('UNAVAILABLE', 'the printer has not answered the last questions yet');
    this.pending.set(key, pending + 1);
    try {
      return await this.run(command, ASK_MS);
    } finally {
      const left = (this.pending.get(key) ?? 1) - 1;
      if (left === 0) this.pending.delete(key);
      else this.pending.set(key, left);
    }
  }

  private async rendered<T>(
    photoId: string,
    target: PrintRenderTarget,
    use: (image: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'bowerbird-print-'));
    const image = path.join(dir, 'print.png');
    try {
      await this.render(photoId, target, image);
      return await use(image);
    } finally {
      // A spooler still reading it, after a timeout, holds it open on Windows.
      await deleteScratchDirectory(dir).catch(() => {
        setTimeout(
          () => void deleteScratchDirectory(dir).catch(() => undefined),
          DELETE_RETRY_MS,
        ).unref();
      });
    }
  }

  private async coded({
    printer,
    colour,
    intent,
  }: Pick<PrintRequest, 'printer' | 'colour' | 'intent'>): Promise<
    Omit<PrintRenderTarget, 'width' | 'height' | 'quarterTurns'>
  > {
    const { space, bits } = transportOf(colour);
    return {
      space,
      bits,
      intent: intent === 'perceptual' ? 'perceptual' : 'relative',
      blackPointCompensation: true,
      icc: colour.kind === 'profile' ? await this.icc(printer, colour.profile) : null,
    };
  }

  private async icc(printer: string, profile: ProfileRef): Promise<Uint8Array> {
    if (profile.from === 'printer') return this.printerProfile(printer, profile.name);
    if (!(await listPrinterProfiles(this.profilesDir)).includes(profile.name))
      throw new AppError('NOT_FOUND', `no printer profile named ${profile.name}`);
    return readFile(path.join(this.profilesDir, profile.name));
  }
}

function replyOf<S extends z.ZodType>(schema: S, reply: unknown): z.output<S> {
  const parsed = schema.safeParse(reply);
  if (!parsed.success) throw unreadable();
  return parsed.data;
}
