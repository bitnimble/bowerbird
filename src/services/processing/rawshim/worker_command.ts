import { readPhotoAnalysis } from '../analysis/photo_analysis_store';
import type { CompositeWant, Job, JobTarget } from '../../../schemas/jobs';
import type { CompositeJob, RenditionJob, RenditionTarget } from '../workers/processing_types';

// The job as the native side reads it.
//
// In a module of its own because two workers build it now - the one that writes renditions and the
// one that prepares a picture for a client to grade - and the mapping is the place a field gets
// forgotten. Structurally what the worker already had, which is not a coincidence: the shape was
// always a description of the work, and only the handles made it look like a sequence of calls.
//
// The analysis blobs are read *here*, in the worker, rather than passed in: they are 5kB a
// photograph, and a path's worth of nothing crosses `postMessage` instead.

export function toCommand(job: RenditionJob): Job {
  return {
    rawFilePath: job.rawFilePath,
    matchEmbeddedJpeg: job.matchEmbeddedJpeg,
    preserveSourceOrientation: job.preserveSourceOrientation,
    photoAnalysis: job.remeasure ? undefined : readPhotoAnalysis(job.dataPath, job.photoId),
    denoiseLuminance: job.denoiseLuminance,
    denoiseColour: job.denoiseColour,
    denoiser: job.denoiser,
    halfSize: job.halfSize,
    measure: job.measure,
    reportProgress: job.reportProgress,
    dust: job.dust,
    repairs: job.repairs,
    sharpen: job.sharpen,
    defringe: job.defringe,
    exposure: job.exposure,
    adjust: job.adjust,
    geometry: job.geometry,
    grade: {
      peakNits: job.grade.peakNits,
      referenceWhiteNits: job.grade.referenceWhiteNits,
      whiteQuantile: job.grade.whiteQuantile,
    },
    targets: job.targets.map(toTarget),
  };
}

export function toTarget(target: RenditionTarget): JobTarget {
  return {
    rendition: target.rendition,
    // The two vocabularies for one decision. `hdr` is the library's - where the rendition
    // is stored and what the viewer asks for - and the render only wants to know which
    // transfer to leave the pixels in, since that is the whole of what its dynamic range
    // reaches (§10.3).
    output: target.hdr ? ('pq' as const) : ('srgb' as const),
    outputPath: target.outputPath,
    size: target.size,
    source: target.source,
    sdrQuantizer: target.sdrQuantizer,
    hdrQuantizer: target.hdrQuantizer,
    preset: target.preset,
    stillFullChroma: target.stillFullChroma,
    sdrFullChroma: target.sdrFullChroma,
  };
}

/**
 * A panorama's, which is a rendition job with the sources on it instead of one path.
 *
 * The settings that describe the picture - the denoise, the sharpen, the grade, the geometry the
 * align framed it with - are the stack's and travel unchanged; the analyses are read here, per
 * source, for `toCommand`'s reason.
 *
 * **And the composite's own, which is the expensive one.** A panorama's levels and colour are
 * measured over every source stacked, so a render or a prepare handed the last one's answer stacks
 * nothing: without this every open of a composite pays for the whole set again.
 */
export function toCompositeCommand(job: CompositeJob): Job {
  return {
    // The far side ignores it for a panorama and the struct wants a string.
    rawFilePath: job.sources[0]?.rawFilePath ?? '',
    matchEmbeddedJpeg: false,
    photoAnalysis: readPhotoAnalysis(job.dataPath, job.photoId),
    denoiseLuminance: job.denoiseLuminance,
    denoiseColour: job.denoiseColour,
    denoiser: job.denoiser,
    dust: job.dust,
    repairs: job.repairs,
    sharpen: job.sharpen,
    defringe: job.defringe,
    exposure: job.exposure,
    adjust: job.adjust,
    geometry: job.geometry,
    grade: job.grade,
    targets: job.targets.map(toTarget),
    reportProgress: job.reportProgress,
    composite: {
      ...wantOf(job),
      sources: job.sources.map((source) => ({
        photoId: source.photoId,
        rawFilePath: source.rawFilePath,
        previewPath: source.previewPath,
        photoAnalysis: [...(readPhotoAnalysis(job.dataPath, source.photoId) ?? [])],
      })),
    },
  };
}

function wantOf(job: CompositeJob): CompositeWant {
  switch (job.want) {
    case 'align':
      return { want: job.want };
    case 'analyse':
      return { want: job.want, volumePath: job.volumePath };
    case 'render':
      return { want: job.want, recipe: job.recipe };
    case 'seams':
      return { want: job.want, recipe: job.recipe, volumePath: job.volumePath, picks: job.picks };
  }
}
