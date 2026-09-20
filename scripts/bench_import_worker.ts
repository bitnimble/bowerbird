import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readCaptureOffset } from '../src/services/processing/analysis/exif_zone';
import { readPhotoAnalysis, writePhotoAnalysis } from '../src/services/processing/analysis/photo_analysis_store';
import { runJob } from '../src/services/processing/rawshim/rawshim_job';
import { wallClockIso } from '../src/services/processing/rawshim/raw_decoder';
import type { FileMetadata } from '../src/services/processing/analysis/metadata';
import type { Job } from '../src/schemas/jobs';

// The fused arm of `bench_import.ts`: one worker doing what a scan worker and a rendition
// worker each do to the same file, over a single open.
//
// **Everything both prod passes do, minus the second open.** The `stat`, the capture offset's
// own 256KB read, the output directories, the analysis sidecar either side of the job, and the
// same `runJob` the rendition worker calls - only with `header: true`, so the catalogue's fields
// come back off the source the tile is already lifted from rather than from a second walk of
// the same tags.

export interface FusedRequest {
  absPath: string;
  photoId: string;
  dataPath: string;
  job: Omit<Job, 'rawFilePath'> & { header: true };
}

export type FusedReply = { metadata: FileMetadata; descriptor?: number[] } | { error: string };

declare const self: {
  onmessage: ((event: MessageEvent<FusedRequest>) => void) | null;
  postMessage: (message: FusedReply) => void;
};

self.onmessage = async (event) => {
  const { absPath, photoId, dataPath, job } = event.data;
  try {
    for (const dir of new Set(job.targets.map((target) => path.dirname(target.outputPath)))) {
      await mkdir(dir, { recursive: true });
    }
    const stats = await stat(absPath);
    const outcome = runJob({
      ...job,
      rawFilePath: absPath,
      photoAnalysis: readPhotoAnalysis(dataPath, photoId),
    });
    if (outcome.photoAnalysis != null) writePhotoAnalysis(dataPath, photoId, outcome.photoAnalysis);
    const header = outcome.header;
    if (header == null) throw new Error(`${absPath} produced no header`);
    // The one field the header does not carry, read the way `extractMetadata` reads it - a
    // second open either way, so it is not what this arm is measuring.
    const dateTakenOffset = await readCaptureOffset(absPath);

    self.postMessage({
      metadata: {
        width: header.width,
        height: header.height,
        colorSpace: 'sRGB',
        orientation: header.orientation,
        dateTaken: header.timestamp == null ? null : wallClockIso(header.timestamp),
        dateTakenOffset,
        latitude: header.latitude,
        longitude: header.longitude,
        iso: header.iso,
        shutterSpeed: header.shutterSpeed,
        aperture: header.aperture,
        focalLength: header.focalLength,
        cameraMake: header.cameraMake,
        cameraModel: header.cameraModel,
        lensModel: header.lensModel,
        mtime: stats.mtime.toISOString(),
        fileSize: stats.size,
      },
      descriptor: outcome.descriptor == null ? undefined : [...outcome.descriptor],
    });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
