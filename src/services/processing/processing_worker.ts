import sharp from 'sharp';
import { decodeRaw, readEmbeddedJpeg } from './raw_decoder';
import type { LosslessJob, ProcessingJob, ProcessingResult, ThumbnailSource, WorkerJob } from './processing_types';

// Bun worker thread (DESIGN §10.3). Produces both WebP thumbnails from either the
// camera's embedded JPEG or a full RAW render, or a one-off lossless export. On
// any failure it removes partial/stale output so the image endpoints stay
// consistent (§10.2).
declare const self: {
  onmessage: ((event: MessageEvent<WorkerJob>) => void) | null;
  postMessage: (message: ProcessingResult) => void;
};

// The embedded JPEG carries its own EXIF orientation, so it needs rotating;
// a render is already baked upright by the decoder (§11.1).
function pipeline(job: ProcessingJob): { make: () => sharp.Sharp; source: ThumbnailSource } {
  if (job.source === 'embedded') {
    const jpeg = readEmbeddedJpeg(job.rawFilePath);
    if (jpeg != null) return { make: () => sharp(jpeg).rotate(), source: 'embedded' };
    // Some bodies embed a bitmap preview or none at all. A missing preview is a
    // property of the file, not an error, so fall back rather than fail.
  }
  const image = decodeRaw(job.rawFilePath);
  const raw = { raw: { width: image.width, height: image.height, channels: image.channels } };
  return { make: () => sharp(image.data, raw), source: 'render' };
}

async function thumbnails(job: ProcessingJob): Promise<ThumbnailSource> {
  const { make, source } = pipeline(job);

  await make()
    .resize({ width: job.smallSize, height: job.smallSize, fit: 'inside' })
    .webp({ quality: job.smallQuality })
    .toFile(job.smallOutputPath);

  await make()
    .resize({ width: job.fullSize, height: job.fullSize, fit: 'inside' })
    .webp({ quality: job.fullQuality })
    .toFile(job.fullOutputPath);

  return source;
}

// 16-bit sRGB PNG: lossless, full resolution, and the only lossless format a
// browser will actually display (TIFF is not). PNG carries no profile here, and
// an unprofiled PNG is read as sRGB, which is what the decode targets.
async function lossless(job: LosslessJob): Promise<void> {
  const image = decodeRaw(job.rawFilePath, 16);
  await sharp(image.data, {
    // `depth` is missing from sharp's Raw typings but supported since 0.33;
    // without it the 16-bit buffer is read as twice as many 8-bit pixels.
    raw: { width: image.width, height: image.height, channels: image.channels, depth: 'ushort' },
  } as sharp.SharpOptions)
    // sharp downconverts to 8-bit on write unless the pipeline is explicitly in
    // a 16-bit space, which silently throws away the depth just decoded.
    .toColourspace('rgb16')
    // A full-resolution 16-bit PNG is enormous, and this runs while the user
    // waits, so trade compression ratio for time.
    .png({ compressionLevel: 6, effort: 1 })
    .toFile(job.outputPath);
}

self.onmessage = async (event) => {
  const job = event.data;
  try {
    if (job.kind === 'lossless') {
      await lossless(job);
      self.postMessage({ photoId: job.photoId, success: true, source: 'render' });
      return;
    }
    self.postMessage({ photoId: job.photoId, success: true, source: await thumbnails(job) });
  } catch (err) {
    const outputs = job.kind === 'lossless' ? [job.outputPath] : [job.smallOutputPath, job.fullOutputPath];
    for (const path of outputs) await Bun.file(path).delete().catch(() => {});
    self.postMessage({ photoId: job.photoId, success: false, error: (err as Error).message });
  }
};
