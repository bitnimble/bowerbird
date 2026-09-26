import { AppError } from '../../../errors';
import { CompositionSchema, canvasLongEdgeFor } from '../../../schemas/composition';
import type { ExportOptions } from '../../../schemas/export';
import { renditionPathFor } from '../../../utils/paths';
import type { SettingsRepository } from '../../settings/settings_repository';
import { encoderQuality } from '../analysis/quality';
import { PANORAMA_TILE_SCALE, type Rendition } from '../renditions/renditions';
import type { HdrGrade, RenditionSource, RenditionTarget } from '../workers/processing_types';

const EXPORT_THUMBNAIL_EDGE = 400;
const EXPORT_THUMBNAIL_QUALITY = 60;

export class RenderTargets {
  constructor(private readonly settings: SettingsRepository) {}



  /**
   * A composite's target, sized so the rendition names the crop the reader is shown.
   *
   * A recipe this cannot parse takes the canvas-sized target rather than failing the render: a
   * picture at the wrong size is a worse rendition than the reader asked for, and no rendition at
   * all is a photograph that never opens.
   */
  composedTarget(
    dataPath: string,
    photoId: string,
    recipe: unknown,
    kind: 'panorama' | 'assembly',
    rendition: Rendition,
    hdr: boolean,
    source: RenditionSource,
  ): RenditionTarget {
    const target = this.target(dataPath, photoId, rendition, hdr, source, kind === 'panorama');
    const parsed = CompositionSchema.safeParse(recipe);
    if (kind !== 'assembly' || !parsed.success || target.size === 0) return target;
    return { ...target, size: canvasLongEdgeFor(parsed.data, target.size) };
  }



  exportTargets(outputPath: string, options: ExportOptions, thumbnailPath?: string): RenditionTarget[] {
    const settings = this.settings.get();
    return [
      {
        rendition: 'max',
        hdr: options.exportHdr,
        source: 'render',
        outputPath,
        size: options.longEdge,
        sdrQuantizer: encoderQuality('avif-sdr', options.quality),
        hdrQuantizer: encoderQuality('avif-hdr', options.quality),
        preset: settings.avif_speed,
        stillFullChroma: true,
        sdrFullChroma: true,
        intent: options.renderingIntent,
      },
      // Named `max` like the export it rides with, and second: `runOneOff` stamps by the
      // first target of a name, so the photograph's own rendition stamps read the export's
      // settings rather than a tile's. SDR and 4:2:0, being a tile in a list.
      ...(thumbnailPath == null ?
        []
      : [
          {
            rendition: 'max' as const,
            hdr: false,
            source: 'render' as const,
            outputPath: thumbnailPath,
            size: EXPORT_THUMBNAIL_EDGE,
            sdrQuantizer: encoderQuality('avif-sdr', EXPORT_THUMBNAIL_QUALITY),
            hdrQuantizer: encoderQuality('avif-hdr', EXPORT_THUMBNAIL_QUALITY),
            preset: settings.avif_speed,
            stillFullChroma: false,
            sdrFullChroma: false,
            intent: options.renderingIntent,
          },
        ]),
    ];
  }



  // Size, quality and encoder settings for one rendition. The grid and the
  // full-size view share the rendition settings; the max-resolution one is native
  // size at the tighter lossless quality, because it exists to be pixel-peeped.
  target(
    dataPath: string,
    photoId: string,
    rendition: Rendition,
    hdr: boolean,
    source: RenditionSource,
    /**
     * Whether the row these are cut from is a *wide* canvas - a panorama (§19.4) - rather than a
     * photograph, which wants no more room than one frame's own tile gives it.
     *
     * An assembly is not wide: its crop is about one frame's worth of picture however far apart its
     * canvas's corners are, and `composedTarget` is what turns a size for the picture into the
     * canvas that holds it.
     */
    wide = false,
  ): RenditionTarget {
    const settings = this.settings.get();
    const sizes: Record<Rendition, number> = {
      grid: wide ? settings.grid_rendition_size * PANORAMA_TILE_SCALE : settings.grid_rendition_size,
      full: wide ? settings.panorama_full_rendition_size : settings.full_rendition_size,
      max: 0,
      // A photograph's camera view is the JPEG inside it, at whatever size that is, and nothing
      // ever builds one. A canvas has no file to lift one out of, so it is composited - and it is
      // what a library serving the cameras' pictures opens a canvas at, so it takes the size that
      // canvas's viewer copy takes rather than the native resolution of the frames behind it.
      // `max` is where native resolution is asked for.
      embedded: wide ? settings.panorama_full_rendition_size : settings.full_rendition_size,
    };
    const quality: Record<Rendition, number> = {
      grid: settings.grid_rendition_quality,
      full: settings.full_rendition_quality,
      max: settings.max_rendition_quality,
      embedded: settings.max_rendition_quality,
    };

    const gridTile = rendition === 'grid';

    // **A grid tile is never HDR, and asking for one is a caller's bug rather than
    // something to quietly correct.** A wall of HDR tiles is punishing to look at,
    // and it would put a linear decode and two encoder passes on every photo in an
    // import (§10.1). `renditionVariant` also refuses to give an HDR grid path, so a
    // request honoured here would encode HDR and file it as SDR - which is a
    // rendition that decodes wrong, not a rendition that is merely large.
    //
    // Thrown rather than coerced because the coercion has no way to reach whoever
    // wrote it. There is one caller today whose `hdr` this would catch:
    // `PhotoRenditionService.buildRendition` takes it from the library for any rendition,
    // and is kept off the grid only by its route refusing that path.
    if (gridTile && hdr) {
      throw new AppError('VALIDATION_ERROR', 'the grid tile is always SDR; asked for an HDR one');
    }
    // The same refusal for the same reason: `renditionVariant` gives no HDR path for the
    // cameras' own view of a canvas, so an HDR encode here would be filed as SDR.
    if (rendition === 'embedded' && hdr) {
      throw new AppError('VALIDATION_ERROR', 'the composited camera view is always SDR; asked for an HDR one');
    }

    return {
      rendition,
      hdr,
      source,
      outputPath: renditionPathFor(dataPath, photoId, rendition, hdr),
      size: sizes[rendition],
      // One quality per rendition, and the two encoder numbers it means. Only one of
      // them is read - `hdr` picks which - but both are carried so the job stays a
      // description of the work rather than of the caller's branch.
      sdrQuantizer: encoderQuality('avif-sdr', quality[rendition]),
      hdrQuantizer: encoderQuality('avif-hdr', quality[rendition]),
      preset: settings.avif_speed,
      stillFullChroma: settings.hdr_still_full_chroma,
      // Not the same shape of decision as the one above, and not a coercion either:
      // chroma is a setting this reads rather than something a caller asks for, so
      // there is no bad request to reject - only a policy about which renditions the
      // setting covers. It does not cover the grid. A tile is 800px in a wall of
      // other tiles and its usual source is the camera's embedded JPEG, already
      // subsampled (`yuvj422p` on the corpus), so 4:4:4 would store chroma at a
      // resolution the source never had - measured at 0.0003 SSIM (§10.1). True of
      // the render fallback too: what makes it pointless is the size and the wall,
      // not where the pixels came from.
      sdrFullChroma: gridTile ? false : settings.sdr_full_chroma,
    };
  }



  // What the render itself gets, before any rendition is cut from it (§10.9).
  //
  // The denoise and the sharpen are not here: they belong to the photograph rather than to the
  // library, since a frame at 12800 and one at base ISO want different answers and a single
  // setting could only be right for one of them. They ride with the rest of the document,
  // through `developed`.
  render(): { defringe: number } {
    return { defringe: this.settings.get().raw_defringe };
  }



  grade(): HdrGrade {
    const settings = this.settings.get();
    return {
      peakNits: settings.hdr_peak_nits,
      referenceWhiteNits: settings.hdr_reference_white_nits,
      whiteQuantile: settings.hdr_white_quantile,
    };
  }
}
