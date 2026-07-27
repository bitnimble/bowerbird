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

// Full-resolution 16-bit JPEG XL at libjxl's "visually lossless" distance.
// Measured on a 20MP frame: 1.4 MB, against 111 MB for the equivalent 16-bit PNG
// and 8.4 MB for AVIF at comparable quality, and it is the only candidate that
// keeps more than 12 bits. No browser decodes it natively yet, so the client
// carries a wasm decoder (DESIGN §10.5).
//
// sharp/libvips has no JXL encoder, and cjxl will not read stdin, so the pixels
// go via a 16-bit PPM: a header plus the samples, with no compression pass to
// pay for on the way.
async function lossless(job: LosslessJob): Promise<void> {
  const image = decodeRaw(job.rawFilePath, 16);
  const ppmPath = `${job.outputPath}.ppm`;
  try {
    // PPM samples are big-endian; LibRaw gave us native order. swap16 is in
    // place on a buffer we own, so this costs no copy of the ~115 MB.
    image.data.swap16();
    await Bun.write(ppmPath, new Blob([`P6\n${image.width} ${image.height}\n65535\n`, image.data]));

    const result = Bun.spawnSync(['cjxl', ppmPath, job.outputPath, '-d', String(job.distance), '-e', String(job.effort)]);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(`cjxl failed (${result.exitCode}): ${stderr.split('\n').slice(-1)[0] ?? 'no output'}`);
    }
  } finally {
    await Bun.file(ppmPath).delete().catch(() => {});
  }
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
