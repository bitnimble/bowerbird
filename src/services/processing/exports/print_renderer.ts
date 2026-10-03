import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import { isComposite } from '../../../schemas/recipes';
import type { Originals } from '../../blobs/originals';
import type { PhotoRenditionService } from '../../photos/renditions/photo_rendition_service';
import type { ProcessingService } from '../pipeline/processing_service';

const log = new Logger('print');

/**
 * What a printer is sent: the best encoding it accepts, from its own device RGB through its
 * paper's profile, down to Adobe RGB and then sRGB. Bowerbird maps the gamut itself, so a print
 * is the picture the proof showed whichever rung it lands on.
 */
export interface PrintRenderTarget {
  space: 'srgb' | 'adobe-rgb' | 'device';
  bits: 8 | 16;
  intent: 'perceptual' | 'relative';
  blackPointCompensation: boolean;
  /** The printer's ICC output profile, which `device` needs and the others ignore. */
  icc: Uint8Array | null;
  /** The file's pixels, after `quarterTurns`. */
  width: number;
  height: number;
  /** Clockwise quarter turns of the finished picture. */
  quarterTurns: 0 | 1 | 2 | 3;
}

/**
 * One photograph rendered for a printer, with its saved edits exactly as an export has them,
 * written at `outputPath` as a PNG of exactly `target`'s pixels, tagged with the space it is in.
 */
export class PrintRenderer {
  constructor(
    private readonly photoRenditions: PhotoRenditionService,
    private readonly processing: ProcessingService,
    private readonly originals: Originals,
  ) {}

  async renderPrint(photoId: string, target: PrintRenderTarget, outputPath: string): Promise<void> {
    if (target.space === 'device' && target.icc == null) {
      throw new AppError('VALIDATION_ERROR', 'a device print needs the printer profile');
    }
    const { photo, library } = this.photoRenditions.locate(photoId);
    if (isComposite(photo.recipe))
      throw new AppError('VALIDATION_ERROR', "panoramas and other merges can't be printed yet");
    await this.originals.openAll(library, photo);
    const original = this.originals.here(library, photo);
    if (original == null)
      throw new AppError('VALIDATION_ERROR', `nothing here can render ${photoId}`);
    const started = performance.now();
    log.info('print rendering', {
      photo: photoId,
      space: target.space,
      bits: target.bits,
      size: `${target.width}x${target.height}`,
    });
    await this.processing.renderPrint(original, photoId, library, outputPath, {
      space: target.space,
      bits: target.bits,
      intent: target.intent === 'relative' ? 'relativeColorimetric' : 'perceptual',
      blackPointCompensation: target.blackPointCompensation,
      icc: target.space === 'device' ? target.icc : null,
      width: target.width,
      height: target.height,
      quarterTurns: target.quarterTurns,
    });
    log.info('print rendered', { photo: photoId, ms: Math.round(performance.now() - started) });
  }
}
