import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runJob } from './rawshim_job';
import { readCameraMatch, writeCameraMatch } from './camera_match_store';
import type { ProcessingResult, RenditionJob, WorkerJob } from './processing_types';

// Bun worker thread (DESIGN §10.3). Writes renditions of one photo - the grid
// tile, the full-size view, the max-resolution export - in AVIF, plus the
// one-frame AV1 twin an HDR rendition needs for Firefox. On any failure it
// removes partial output so the image endpoints stay consistent (§10.2).
//
// **The pixel work is one call now.** This file used to orchestrate it: two lazy
// decodes, a fit, a shared base, a per-target loop and a `finally` that freed
// every handle it had opened. All of that is `job.rs`, and it moved for one
// reason - doing it from here meant the decode had to exist as a raw pointer held
// between calls, whose lifetime no compiler could check. What crosses now is a
// command and a result, both JSON (§10.4).
//
// What is left here is what a worker is actually for: taking a message, making
// the directories, and cleaning up after a failure.
declare const self: {
  onmessage: ((event: MessageEvent<WorkerJob>) => void) | null;
  postMessage: (message: ProcessingResult) => void;
};

function outputsOf(job: WorkerJob): string[] {
  return job.targets.map((t) => t.outputPath);
}

// Every writer fails on a missing directory rather than creating one, and ffmpeg
// fails the whole job rather than the one output, so this runs before any of
// them. Here rather than at the call site because the outputs are the job's, and
// each new rendition otherwise adds a directory somebody has to remember.
async function ensureOutputDirs(job: WorkerJob): Promise<void> {
  for (const dir of new Set(outputsOf(job).map((output) => path.dirname(output)))) {
    await mkdir(dir, { recursive: true });
  }
}

// The job as the native side reads it. Structurally what the worker already had,
// which is not a coincidence: the shape was always a description of the work, and
// only the handles made it look like a sequence of calls.
function toCommand(job: RenditionJob): Parameters<typeof runJob>[0] {
  return {
    rawFilePath: job.rawFilePath,
    matchEmbeddedJpeg: job.matchEmbeddedJpeg,
    // Read here rather than passed in, so the blob crosses to the worker as a file path's
    // worth of nothing rather than 5KB per job through `postMessage`.
    cameraMatch: readCameraMatch(job.dataPath, job.photoId),
    denoiseLuminance: job.denoiseLuminance,
    denoiseColour: job.denoiseColour,
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
    targets: job.targets.map((target) => ({
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
    })),
  };
}

self.onmessage = async (event) => {
  const job = event.data;
  try {
    await ensureOutputDirs(job);
    const { descriptor, cameraMatch } = runJob(toCommand(job));
    // Written here, in the worker that fitted it, rather than sent back for the main thread to
    // store: it is a file, this side is already doing file work, and the main thread's one job
    // is to stay off the disk.
    if (cameraMatch != null) writeCameraMatch(job.dataPath, job.photoId, cameraMatch);
    self.postMessage({ photoId: job.photoId, success: true, descriptor });
  } catch (err) {
    for (const output of outputsOf(job)) await Bun.file(output).delete().catch(() => {});
    self.postMessage({ photoId: job.photoId, success: false, error: (err as Error).message });
  }
};
