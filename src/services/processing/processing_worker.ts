import sharp from 'sharp';
import { decodeRaw, readEmbeddedJpeg } from './raw_decoder';
import type { ProcessingJob, ProcessingResult, ThumbnailSource } from './processing_types';

// Bun worker thread (DESIGN §10.3). Produces both WebP thumbnails from either the
// camera's embedded JPEG or a full RAW render. On any failure it removes
// partial/stale output so the image endpoints stay consistent (§10.2).
declare const self: {
  onmessage: ((event: MessageEvent<ProcessingJob>) => void) | null;
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

self.onmessage = async (event) => {
  const job = event.data;
  try {
    const { make, source } = pipeline(job);

    await make()
      .resize({ width: job.smallSize, height: job.smallSize, fit: 'inside' })
      .webp({ quality: job.smallQuality })
      .toFile(job.smallOutputPath);

    await make()
      .resize({ width: job.fullSize, height: job.fullSize, fit: 'inside' })
      .webp({ quality: job.fullQuality })
      .toFile(job.fullOutputPath);

    self.postMessage({ photoId: job.photoId, success: true, source });
  } catch (err) {
    await Bun.file(job.smallOutputPath).delete().catch(() => {});
    await Bun.file(job.fullOutputPath).delete().catch(() => {});
    self.postMessage({ photoId: job.photoId, success: false, error: (err as Error).message });
  }
};
