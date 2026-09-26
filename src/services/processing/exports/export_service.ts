import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import { EXPORT_FORMATS, exportFilename, honoured, type ExportOptions } from '../../../schemas/export';
import { soleInputOf } from '../../../schemas/recipes';
import { deleteScratchDirectory } from '../../../utils/deletions';
import type { Originals } from '../../blobs/originals';
import type { CompositesService } from '../../composites/composites_service';
import type { PhotoRenditionService } from '../../photos/renditions/photo_rendition_service';
import type { SettingsRepository } from '../../settings/settings_repository';
import type { ProcessingService } from '../pipeline/processing_service';
import { encoderQuality } from '../analysis/quality';
import { exportStill, transcodeJpeg, watchingJobProgress, writeGainMap } from '../rawshim/rawshim_job';

// Perceived quality for a share, which nobody is offered a dialog for: the picture is going to
// a message rather than to a library, and the export dialog is where a reader who wants to
// choose goes.
const SHARE_QUALITY = 90;

// What is left of a photograph's export once its renders are done: the transcode, or the two
// arms written as one file. Small beside a render, and never nothing - a bar that reaches the
// end and then waits reads as a hung export.
const ENCODE_SHARE = 0.1;
const log = new Logger('export');

// One photograph, rendered to the reader's own settings rather than the viewer's (§10.5).
//
// **An export is not a rendition.** A rendition is a working copy the app decides the shape of
// and caches on disk; an export is a question the reader answered eight times in a dialog and
// wants once. So nothing here is stored: the frame is written to a scratch directory, read
// back, and the directory removed.

/** What a finished export is, before it becomes an HTTP response. */
export interface ExportedFile {
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
  /**
   * The same picture at a list tile's size, AVIF, asked for by the caller that keeps a history
   * of exports (§10.5.2). Null when none was asked for.
   */
  thumbnail: Uint8Array | null;
}

export class ExportService {
  constructor(
    private readonly photoRenditions: PhotoRenditionService,
    private readonly processing: ProcessingService,
    /** The way to a photograph's bytes, which may be on a backup rather than here (§14.4). */
    private readonly originals: Originals,
    private readonly settings: SettingsRepository,
    /**
     * Which panorama a photograph is a frame of, where the catalogue knows about panoramas at
     * all. Optional so the tests that are about formats and quality build one of these without
     * one, as they did before a panorama could be exported.
     */
    private readonly panoramas?: CompositesService,
  ) {}

  /**
   * Renders one photograph and hands back its bytes.
   *
   * The scratch directory is removed on every path, including a failed render: an export that
   * throws half way through has still written a partial file, and nothing sweeps `tmp` for us.
   */
  async exportOne(
    photoId: string,
    requested: ExportOptions,
    withThumbnail = false,
    /**
     * How far through this photograph the export is, 0 to 1, called as it moves.
     *
     * The render is one blocking call in a worker, so what moves this is the count the job keeps
     * for the thread that is not inside it (`jobProgress`).
     */
    onProgress?: (fraction: number) => void,
  ): Promise<ExportedFile> {
    const options = honoured(requested);
    const started = performance.now();
    log.info('export started', {
      photo: photoId, format: options.format, longEdge: options.longEdge, quality: options.quality,
      hdr: options.exportHdr, gainMap: options.gainMap, edits: options.includeEdits,
      halfSize: options.halfSize, thumbnail: withThumbnail,
    });
    try {
      const exported = await this.render(photoId, options, withThumbnail, onProgress);
      log.info('export finished', { photo: photoId, format: options.format, bytes: exported.bytes.byteLength, ms: Math.round(performance.now() - started) });
      return exported;
    } catch (err) {
      log.error('export failed', { photo: photoId, format: options.format, ms: Math.round(performance.now() - started), err });
      throw err;
    }
  }

  private async render(
    photoId: string,
    options: ExportOptions,
    withThumbnail: boolean,
    onProgress?: (fraction: number) => void,
  ): Promise<ExportedFile> {
    const format = EXPORT_FORMATS[options.format];
    // Refused before the render rather than after it: the dialog only offers what this build
    // writes, so reaching here means a request that did not come from it.
    if (!format.encoder) {
      throw new AppError('VALIDATION_ERROR', `this build cannot write ${options.format} yet`);
    }
    const { photo, library } = this.photoRenditions.locate(photoId);
    // Fetched back from a backup where this device has given its copy up (§14.4). Before the
    // panorama below as well as for the ordinary arm: what `renderable` answers is whether the
    // frames are on this disk, and an export is worth the wait for them.
    log.info('export opening originals', { photo: photoId });
    await this.originals.openAll(library, photo);
    const original = this.originals.here(library, photo);
    // A panorama exports the picture it composes, framed as its row is: the crop the align found
    // is on that row's document, so it reaches this the way a reader's own crop does. Named
    // through a renderer rather than a branch below, so the gain map's second arm and the scratch
    // directory's rules are written once for both.
    //
    // Asked of the row itself, so a *frame* of a panorama exports the frame - which is what asking
    // for it means, the composite being a row of its own to ask for.
    const panorama = this.panoramas?.renderable(photoId) ?? null;
    const render = (outputPath: string, settings: ExportOptions, tile?: string): Promise<void> => {
      log.info('export rendering', { photo: photoId, source: panorama == null ? 'original' : 'composite', hdr: settings.exportHdr, longEdge: settings.longEdge });
      if (panorama != null) {
        return this.processing.renderCompositeExport(
          photoId,
          panorama.sources,
          panorama.recipe,
          library,
          outputPath,
          settings,
          tile,
        );
      }
      // Neither a file nor a recipe this build can compose, which is a row from a peer running a
      // later one. There is nothing to render, and saying so beats decoding a path that is not.
      if (original == null) throw new AppError('VALIDATION_ERROR', `nothing here can render ${photoId}`);
      return this.processing.renderExport(original, photoId, library, outputPath, settings, tile);
    };
    // The file's own name where there is one, so an export lands beside the frame it came from;
    // the id otherwise, a composite having no filename of its own to be named after.
    const named = panorama != null ? `panorama-${photoId}` : (soleInputOf(photo.recipe) ?? photo.id);

    const scratch = await mkdtemp(path.join(tmpdir(), 'bowerbird-export-'));
    try {
      // Every format starts from an AVIF, because that is what the render pipeline writes.
      // The ones that are not AVIF are a transcode of it, which costs a decode of a file that
      // is already the right pixels rather than a second render.
      const rendered = path.join(scratch, 'render.avif');
      // The tile rides with the export rather than following it: one decode, one upload, one
      // more dispatch. It is written whatever the export's own format is, being an AVIF the app
      // serves rather than a file the reader keeps.
      const tile = withThumbnail ? path.join(scratch, 'thumbnail.avif') : undefined;
      // A gain map is two renders of the same photograph, so the first of them is half the wait
      // rather than the whole of it.
      const share = (1 - ENCODE_SHARE) / (options.gainMap ? 2 : 1);
      await this.watched(0, share, onProgress, () => render(rendered, options, tile));
      if (!options.gainMap) log.info('export encoding', { photo: photoId, format: options.format, gainMap: false });
      const bytes = options.gainMap
        ? await this.withGainMap(
            scratch,
            rendered,
            (outputPath, settings) => this.watched(share, share, onProgress, () => render(outputPath, settings)),
            options,
            photoId,
          )
        : await this.encode(rendered, options);
      return {
        bytes,
        mediaType: format.mediaType,
        filename: exportFilename(named, options.format),
        thumbnail: tile == null ? null : new Uint8Array(await Bun.file(tile).arrayBuffer()),
      };
    } finally {
      await deleteScratchDirectory(scratch);
    }
  }

  /**
   * The rendition on screen, as a JPEG whatever the reader sends it to can open (§10.5).
   *
   * **The rendition is the picture, and it is not rendered again.** An HDR one is a PQ AVIF that
   * most applications show as a dark, flat mess or refuse outright, so it goes over as a JPEG
   * with a gain map: an ordinary eight-bit picture for everything, and the range beside it for
   * Apple's Photos, Android 15 and anything else that reads either spelling. The base is the
   * same frame rolled to SDR (`renderSdrRoll`), which costs a dispatch over pixels that are
   * already decoded rather than the decode, the fit and the demosaic a render pays.
   *
   * Nothing here is stored: the roll is written to a scratch directory, read back into the file
   * that is handed over, and the directory removed. The JPEG exists for the length of one share.
   */
  async shareable(photoId: string, renditionPath: string, hdr: boolean): Promise<Uint8Array> {
    const quality = encoderQuality('jpeg', SHARE_QUALITY);
    if (!hdr) return new Uint8Array(transcodeJpeg(renditionPath, 0, quality));

    const scratch = await mkdtemp(path.join(tmpdir(), 'bowerbird-share-'));
    try {
      const base = path.join(scratch, 'base.avif');
      await this.processing.renderSdrRoll(renditionPath, photoId, scratch, base, SHARE_QUALITY);
      return new Uint8Array(writeGainMap(base, renditionPath, 'jpeg', quality, 0));
    } finally {
      await deleteScratchDirectory(scratch);
    }
  }

  /**
   * The same photograph twice, written as one file with the map between them.
   *
   * **The SDR arm is a second render rather than a tone map of the first.** It is the same
   * grade with its peak at diffuse white, which is what `job::peak_nits` does for every SDR
   * rendition - so the base a reader without gain map support sees is the picture this app
   * would have given them anyway, rather than something derived here to a different rule.
   *
   * It costs one more dispatch and one more encode, not a second decode: the two targets are
   * the same size, so `job::run` uploads the frame once and pays a dispatch for the second.
   */
  private async withGainMap(
    scratch: string,
    alternate: string,
    render: (outputPath: string, settings: ExportOptions) => Promise<void>,
    options: ExportOptions,
    photoId: string,
  ): Promise<Uint8Array> {
    const base = path.join(scratch, 'base.avif');
    await render(base, { ...options, exportHdr: false });
    if (options.format !== 'avif' && options.format !== 'jpeg') {
      throw new AppError('VALIDATION_ERROR', `a gain map in ${options.format} is not built yet`);
    }
    const quality = encoderQuality(options.format === 'avif' ? 'avif-sdr' : 'jpeg', options.quality);
    log.info('export encoding', { photo: photoId, format: options.format, gainMap: true });
    const speed = options.format === 'avif' ? this.settings.get().avif_speed : 0;
    return new Uint8Array(writeGainMap(base, alternate, options.format, quality, speed));
  }

  /**
   * Runs one render, telling whoever is watching how far into it the native side is.
   *
   * The work is a blocking call in a worker, so nothing inside it can report: what moves is a
   * counter in the library, which this thread reads on a timer. A render whose counter never
   * appears still reports its own share as it ends.
   */
  private async watched<T>(
    before: number,
    share: number,
    report: ((fraction: number) => void) | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (report == null) return await run();
    return await watchingJobProgress(before, share, report, run);
  }

  private async encode(rendered: string, options: ExportOptions): Promise<Uint8Array> {
    switch (options.format) {
      case 'avif':
        return new Uint8Array(await Bun.file(rendered).arrayBuffer());
      case 'jpeg':
        // 0 keeps the size the render already landed on: the fit happened during the render,
        // where it belongs, so asking for it again here would resample a resampled frame.
        return new Uint8Array(transcodeJpeg(rendered, 0, encoderQuality('jpeg', options.quality)));
      case 'png':
        return new Uint8Array(exportStill(rendered, options.exportHdr ? 'png-hdr' : 'png'));
      case 'jxl':
        return new Uint8Array(
          exportStill(rendered, options.exportHdr ? 'jxl-hdr' : 'jxl', encoderQuality('jxl', options.quality)),
        );
      case 'tiff':
        return new Uint8Array(exportStill(rendered, 'tiff'));
      default:
        throw new AppError('VALIDATION_ERROR', `no encoder for ${options.format} yet`);
    }
  }
}
