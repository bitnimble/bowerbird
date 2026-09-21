import type { ExportOptions } from '../../../schemas/export';
import type { Library } from '../../../schemas/libraries';
import { getDataPath } from '../../../utils/paths';
import type { SettingsRepository } from '../../settings/settings_repository';
import { encoderQuality } from '../analysis/quality';
import type { CompositeJobSource } from '../workers/processing_types';
import { developed } from './developed';
import type { CompositeRenderer } from './composite_renderer';
import type { RenderTargets } from './render_targets';
import type { SinglePhotoRenderer } from './single_photo_renderer';

export class ExportRenderer {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly editsFor: (photoId: string) => { doc: string; stamp: string | null } | null,
    private readonly targets: RenderTargets,
    private readonly singlePhoto: SinglePhotoRenderer,
    private readonly composites: CompositeRenderer,
  ) {}



  /**
   * One photograph rendered to a reader's export settings, written at `outputPath` (§10.5).
   *
   * **Every setting here comes from the request, not from the library.** A rendition is a
   * working copy this app decides the shape of; an export is what the reader asked for, so
   * the size, the quality, the dynamic range and whether the edits apply are all theirs. The
   * grade is still the library's, because that is what the photograph *looks* like rather
   * than how it is written.
   *
   * `max` as the rendition kind, which is only about chroma: it is the one that does not
   * subsample, and an export a reader chose a quality for should not quietly quarter its
   * colour resolution.
   */
  async renderExport(
    rawFilePath: string,
    photoId: string,
    library: Library,
    outputPath: string,
    options: ExportOptions,
    /**
     * A second size off the same decode, for the history's tile (§10.5.2).
     *
     * A target rather than a downscale of the finished export: an HDR export is a PQ frame,
     * and reading one back as if it were sRGB is a flat, dark picture. The renderer already
     * writes several sizes from one decode - it is how the grid tile and the full rendition
     * are built together - so this costs a dispatch and a small encode, not a second decode.
     */
    thumbnailPath?: string,
  ): Promise<void> {
    const settings = this.settings.get();
    const edits = options.includeEdits ? this.editsFor(photoId) : null;
    return this.singlePhoto.runOneOff(
      {
        kind: 'rendition',
        photoId,
        rawFilePath,
        dataPath: getDataPath(library),
        // Somebody is sitting in front of this one: it is the render behind the bar the export
        // dialog left them with, which without a count from inside the job sits at nothing until
        // the file lands.
        reportProgress: true,
        targets: this.targets.exportTargets(outputPath, options, thumbnailPath),
        grade: this.targets.grade(),
        remeasure: false,
        cameraMatch: settings.match_embedded_jpeg ? 'lensAndColour' : 'none',
        halfSize: options.halfSize,
        ...developed(edits?.doc ?? null),
        ...this.targets.render(),
      },
      edits?.stamp ?? null,
    );
  }



  /**
   * A picture this app has already rendered, rolled down to SDR and written beside it.
   *
   * **Not a second render of the photograph.** The input is a rendition rather than a RAW, so
   * the decode reads it back as a finished picture and the pipeline starts at the grade: no
   * demosaic, no denoise on the mosaic, no fit. What is left is the roll-off, which is the whole
   * point - an SDR target is the same grade with its peak at diffuse white, so this is the
   * picture the app would have served an SDR library, and that is what a gain map's base has to
   * be rather than a tone map invented here.
   *
   * `scratch` stands in for the library's data directory: what a job measures is written back
   * under its photo id, and levels read off somebody's finished render must never become the
   * answers every later render of that photograph starts from.
   */
  async renderSdrRoll(rendered: string, photoId: string, scratch: string, outputPath: string, quality: number): Promise<void> {
    const settings = this.settings.get();
    await this.singlePhoto.runDetached({
      kind: 'rendition',
      photoId,
      rawFilePath: rendered,
      dataPath: scratch,
      targets: [
        {
          rendition: 'max',
          hdr: false,
          source: 'render',
          outputPath,
          size: 0,
          sdrQuantizer: encoderQuality('avif-sdr', quality),
          hdrQuantizer: encoderQuality('avif-hdr', quality),
          preset: settings.hdr_preset,
          // Full chroma whatever the library stores its renditions at: this file is read
          // straight back into the encoder that builds the map, and the JPEG it ends up in
          // does not subsample either (`jpeg::encode`, `F_1_1`), so subsampling here would
          // throw colour away on the way between two things that were going to keep it.
          stillFullChroma: true,
          sdrFullChroma: true,
        },
      ],
      grade: this.targets.grade(),
      remeasure: true,
      cameraMatch: 'none',
      preserveSourceOrientation: true,
      ...developed(null),
      // The picture being read has been sharpened and denoised once already, and a base whose
      // detail differs from the alternate beside it is a gain map with haloes along every edge.
      denoiseLuminance: 0,
      denoiseColour: 0,
      sharpen: 0,
      ...this.targets.render(),
    });
  }



  /**
   * The same, for a panorama: the composite rendered to the reader's export settings.
   *
   * The recipe's own sources rather than a photograph, and the canvas whole: the crop the align
   * worked out is what a *rendition* is framed by, where an export exists to hand another tool
   * everything there is, wedges included (§19.4).
   */
  async renderCompositeExport(
    photoId: string,
    sources: CompositeJobSource[],
    recipe: unknown,
    library: Library,
    outputPath: string,
    options: ExportOptions,
    /** A second size off the same composite, for the history's tile - `renderExport`'s reason. */
    thumbnailPath?: string,
  ): Promise<void> {
    const edits = options.includeEdits ? this.editsFor(photoId) : null;
    await this.composites.runComposite({
      kind: 'composite',
      cameraMatch: this.settings.get().match_embedded_jpeg ? 'lensAndColour' : 'none',
      want: 'render',
      photoId,
      sources,
      recipe,
      dataPath: getDataPath(library),
      reportProgress: true,
      targets: this.targets.exportTargets(outputPath, options, thumbnailPath),
      grade: this.targets.grade(),
      // The canvas's own document, which holds the framing the align found: an export of a
      // panorama is the picture, wedges of nothing trimmed, rather than the canvas behind it.
      ...developed(edits?.doc ?? null),
      ...this.targets.render(),
    });
  }
}
