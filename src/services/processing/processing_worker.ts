import sharp from 'sharp';
import { decodeRaw } from './raw_decoder';
import type { ProcessingJob, ProcessingResult } from './processing_types';

// Bun worker thread (DESIGN §10.3). Decodes a RAW to an upright RGB buffer, then
// encodes both WebP thumbnails. On any failure it removes partial/stale output so
// the image endpoints stay consistent (§10.2), then reports the error.
declare const self: {
  onmessage: ((event: MessageEvent<ProcessingJob>) => void) | null;
  postMessage: (message: ProcessingResult) => void;
};

self.onmessage = async (event) => {
  const job = event.data;
  try {
    const image = decodeRaw(job.rawFilePath);
    const input = { raw: { width: image.width, height: image.height, channels: image.channels } };

    await sharp(image.data, input)
      .resize({ width: job.smallSize, height: job.smallSize, fit: 'inside' })
      .webp({ quality: job.smallQuality })
      .toFile(job.smallOutputPath);

    await sharp(image.data, input)
      .resize({ width: job.fullSize, height: job.fullSize, fit: 'inside' })
      .webp({ quality: job.fullQuality })
      .toFile(job.fullOutputPath);

    self.postMessage({ photoId: job.photoId, success: true });
  } catch (err) {
    await Bun.file(job.smallOutputPath).delete().catch(() => {});
    await Bun.file(job.fullOutputPath).delete().catch(() => {});
    self.postMessage({ photoId: job.photoId, success: false, error: (err as Error).message });
  }
};
