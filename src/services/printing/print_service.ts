import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../errors';
import {
  PrinterCapabilitiesSchema,
  PrinterIccSchema,
  PrintersSchema,
  PrintJobIdSchema,
  PrintJobStateSchema,
  transportOf,
  type Printer,
  type PrinterCapabilities,
  type PrintJobState,
  type PrintRequest,
  type PrintSheetRequest,
  type ProfileRef,
} from '../../schemas/printing';
import { deleteScratchDirectory } from '../../utils/deletions';
import { listPrinterProfiles } from '../../utils/paths';
import type { PrintRenderer, PrintRenderTarget } from '../processing/exports/print_renderer';
import type { PrintshimRun } from './printshim';

const ASK_MS = 15_000;
const SUBMIT_MS = 120_000;

export class PrintService {
  constructor(
    private readonly run: PrintshimRun,
    private readonly profilesDir: string,
    private readonly render: PrintRenderer['renderPrint'],
  ) {}

  async printers(): Promise<Printer[]> {
    return PrintersSchema.parse(await this.run({ kind: 'list' }, ASK_MS)).printers;
  }

  async capabilities(printer: string): Promise<PrinterCapabilities> {
    return PrinterCapabilitiesSchema.parse(
      await this.run({ kind: 'capabilities', printer }, ASK_MS),
    );
  }

  async printerProfile(printer: string, name: string): Promise<Uint8Array> {
    const { icc } = PrinterIccSchema.parse(
      await this.run({ kind: 'profile', printer, name }, ASK_MS),
    );
    return Buffer.from(icc, 'base64');
  }

  async submit(request: PrintRequest): Promise<number> {
    const { colour, job, printer } = request;
    const icc = colour.kind === 'profile' ? await this.icc(printer, colour.profile) : null;
    const transport = transportOf(colour);
    return this.rendered(
      request.photoId,
      {
        space: transport.space,
        bits: transport.bits,
        intent: request.intent === 'perceptual' ? 'perceptual' : 'relative',
        blackPointCompensation: true,
        icc,
        width: job.place.width,
        height: job.place.height,
        quarterTurns: request.quarterTurns,
      },
      async (image) =>
        PrintJobIdSchema.parse(
          await this.run({ kind: 'submit', printer, image, job: { ...job, transport } }, SUBMIT_MS),
        ).jobId,
    );
  }

  async job(printer: string, jobId: number): Promise<PrintJobState> {
    return PrintJobStateSchema.parse(await this.run({ kind: 'job', printer, jobId }, ASK_MS));
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
      await deleteScratchDirectory(dir).catch(() => undefined);
    }
  }

  private async icc(printer: string, profile: ProfileRef): Promise<Uint8Array> {
    if (profile.from === 'printer') return this.printerProfile(printer, profile.name);
    if (!(await listPrinterProfiles(this.profilesDir)).includes(profile.name))
      throw new AppError('NOT_FOUND', `no printer profile named ${profile.name}`);
    return readFile(path.join(this.profilesDir, profile.name));
  }
}
