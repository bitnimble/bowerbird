import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runJob, writeRendered } from '../rawshim/rawshim_job';
import { writePhotoAnalysis } from '../analysis/photo_analysis_store';
import { toCommand, toCompositeCommand } from '../rawshim/worker_command';
import type { ProcessingMessage, WorkerJob } from './processing_types';

// Bun worker thread (DESIGN §10.3). Writes renditions of one photo - the grid
// tile, the full-size view, the max-resolution export - in AVIF, plus the
// one-frame AV1 twin an HDR rendition needs for Firefox. On any failure it
// removes partial output so the image endpoints stay consistent (§10.2).
//
// **The pixel work is one call.** Orchestrating it here - two lazy decodes, a fit, a
// shared base, a per-target loop and a `finally` freeing every handle opened - means
// the decode has to exist as a raw pointer held between calls, whose lifetime no
// compiler can check. That is `job.rs`'s, and what crosses is a command and a result,
// both JSON (§10.4).
//
// What is left here is what a worker is actually for: taking a message, making
// the directories, and cleaning up after a failure.
declare const self: {
  onmessage: ((event: MessageEvent<WorkerJob>) => void) | null;
  postMessage: (message: ProcessingMessage) => void;
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

self.onmessage = async (event) => {
  const job = event.data;
  try {
    await ensureOutputDirs(job);
    // Written here, in the worker that measured it, rather than sent back for the main thread to
    // store: it is a file, this side is already doing file work, and the main thread's one job
    // is to stay off the disk.
    //
    // **A composite's is worth as much as a photograph's and costs more to find**: its levels and
    // its colour are measured over every source stacked, so a panorama that filed nothing paid for
    // the whole set again on every render and every open of it.
    const command = job.kind === 'composite' ? toCompositeCommand(job) : toCommand(job, job.observe
      ? (analysisCache) => self.postMessage({ kind: 'started', photoId: job.photoId, analysisCache })
      : undefined);
    const { descriptor, photoAnalysis, composite } =
      job.kind === 'composite'
        ? runJob(command)
        : job.rendered != null
          ? writeRendered(command, job.rendered)
          : runJob(command);
    if (photoAnalysis != null) writePhotoAnalysis(job.dataPath, job.photoId, photoAnalysis);
    self.postMessage({ photoId: job.photoId, success: true, descriptor, composite });
  } catch (err) {
    for (const output of outputsOf(job)) await Bun.file(output).delete().catch(() => {});
    self.postMessage({ photoId: job.photoId, success: false, error: (err as Error).message });
  }
};
