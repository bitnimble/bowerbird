import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { encodeHdr } from './hdr_media';
import { decodeRaw, readEmbeddedJpeg } from './raw_decoder';
import type {
  HdrJob,
  LosslessJob,
  PreviewJob,
  ProcessingJob,
  ProcessingResult,
  ThumbnailSource,
  WorkerJob,
} from './processing_types';

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

// 4:4:4, because these are photographs: 4:2:0 keeps luma at full resolution but
// drops chroma to a quarter of the samples, smearing the saturated edges a photo
// is judged on. sharp's AVIF is 8-bit whatever the input depth, which is why the
// HDR path below cannot go through sharp at all (§10.2).
function toAvif(image: sharp.Sharp, size: number, quality: number, effort: number): sharp.Sharp {
  return image.resize({ width: size, height: size, fit: 'inside' }).avif({ quality, effort, chromaSubsampling: '4:4:4' });
}

// No fallback, unlike `pipeline`: the output is cached under the source that was
// asked for, so quietly substituting a render would leave a render on disk
// labelled as the camera's own JPEG and never corrected.
async function preview(job: PreviewJob): Promise<void> {
  if (job.source === 'embedded') {
    const jpeg = readEmbeddedJpeg(job.rawFilePath);
    if (jpeg == null) throw new Error('this file has no embedded JPEG preview');
    await toAvif(sharp(jpeg).rotate(), job.size, job.quality, job.effort).toFile(job.outputPath);
    return;
  }
  // HDR is a property of the render, so it can only apply to this branch: an
  // embedded JPEG is 8-bit SDR and has no headroom to carry.
  if (job.hdr) {
    const image = decodeRaw(job.rawFilePath, 16, 'rec2020-linear');
    const common = { ...job.grade, crf: job.crf, preset: job.preset, maxEdge: job.size } as const;
    await encodeHdr(image, { ...common, variant: 'pq', medium: 'still', outputPath: job.outputPath });
    // The chosen rendition obeys the library setting exactly as an imported one
    // does, or picking "From RAW" in Firefox would show the dark still.
    if (job.hdrVideo) {
      await encodeHdr(image, { ...common, variant: 'pq', medium: 'video', outputPath: job.videoOutputPath });
    }
    return;
  }
  const image = decodeRaw(job.rawFilePath);
  const raw = { raw: { width: image.width, height: image.height, channels: image.channels } };
  await toAvif(sharp(image.data, raw), job.size, job.quality, job.effort).toFile(job.outputPath);
}

async function thumbnails(job: ProcessingJob): Promise<{ source: ThumbnailSource; hdr: boolean }> {
  const { make, source } = pipeline(job);

  await toAvif(make(), job.smallSize, job.smallQuality, job.effort).toFile(job.smallOutputPath);

  // Only the full-size rendition goes HDR; the grid stays SDR. A wall of HDR
  // thumbnails is punishing to look at, and it would put a LibRaw linear decode
  // and two encoder passes on every photo in an import rather than one sharp
  // call (§10.2).
  if (job.hdr && source === 'render') {
    const image = decodeRaw(job.rawFilePath, 16, 'rec2020-linear');
    const common = { ...job.grade, crf: job.crf, preset: job.preset, maxEdge: job.fullSize } as const;
    await encodeHdr(image, { ...common, variant: 'pq', medium: 'still', outputPath: job.fullOutputPath });
    // And again as a video, off the same decode, when the library asks for it.
    // Opt-in because it is a second encode per photo for a file only Firefox
    // reads, and most installs never serve one (§10.7).
    if (job.hdrVideo) {
      await encodeHdr(image, { ...common, variant: 'pq', medium: 'video', outputPath: job.videoOutputPath });
    }
    return { source, hdr: true };
  }

  await toAvif(make(), job.fullSize, job.fullQuality, job.effort).toFile(job.fullOutputPath);
  return { source, hdr: false };
}

// Full-resolution AVIF at the tightest quality that stays under the size budget,
// native everywhere with no polyfill (§10.5). It was JPEG XL, which keeps 16
// bits where this keeps 10; the 10 bits won because no browser decodes JXL
// without a 1.6MB wasm module and a PNG transcode that cost more than the whole
// encode. Full resolution, never fitted: this is the view that gets pixel-peeped.
async function lossless(job: LosslessJob): Promise<void> {
  if (job.hdr) {
    const image = decodeRaw(job.rawFilePath, 16, 'rec2020-linear');
    const common = { ...job.grade, crf: job.quantizer, preset: job.preset, maxEdge: Number.POSITIVE_INFINITY } as const;
    await encodeHdr(image, { ...common, variant: 'pq', medium: 'still', outputPath: job.outputPath });
    // The same view for Firefox. Unlike the still it cannot stay at native size:
    // the encoder caps height at 8704, so a tall frame is fitted to it.
    if (job.hdrVideo) {
      await encodeHdr(image, { ...common, variant: 'pq', medium: 'video', outputPath: job.videoOutputPath });
    }
    return;
  }
  // An 8-bit decode deliberately: sharp's AVIF output is 8-bit whatever goes in,
  // and asking for 16 would reintroduce the trap that `raw.depth` is ignored on
  // a Buffer, so the samples get read as 8-bit anyway and the picture is wrong.
  const image = decodeRaw(job.rawFilePath, 8);
  const raw = { raw: { width: image.width, height: image.height, channels: image.channels } };
  await sharp(image.data, raw).avif({ quality: job.quality, effort: job.effort, chromaSubsampling: '4:4:4' }).toFile(job.outputPath);
}

// The decode is scene-linear and wide-gamut rather than display-referred: the
// transfer is applied by the encoder, and auto-brightening would flatten away
// the highlight headroom that carries the HDR (DESIGN §10.7).
async function hdr(job: HdrJob): Promise<void> {
  const image = decodeRaw(job.rawFilePath, 16, 'rec2020-linear');
  await encodeHdr(image, {
    variant: job.variant,
    medium: job.medium,
    outputPath: job.outputPath,
    ...job.grade,
    crf: job.crf,
    preset: job.preset,
    maxEdge: job.maxEdge,
  });
}

// Every writer here fails on a missing directory rather than creating one, and
// ffmpeg fails the whole job rather than the one output, so this runs before any
// of them. Here rather than at the call site because the outputs are the job's,
// and each new rendition otherwise adds a directory somebody has to remember.
async function ensureOutputDirs(job: WorkerJob): Promise<void> {
  const outputs = job.kind === 'thumbnails' ? [job.smallOutputPath, job.fullOutputPath] : [job.outputPath];
  if (job.kind !== 'hdr' && job.hdrVideo) outputs.push(job.videoOutputPath);
  for (const dir of new Set(outputs.map((output) => path.dirname(output)))) {
    await mkdir(dir, { recursive: true });
  }
}

self.onmessage = async (event) => {
  const job = event.data;
  try {
    await ensureOutputDirs(job);
    if (job.kind === 'lossless') {
      await lossless(job);
      self.postMessage({ photoId: job.photoId, success: true, source: 'render', hdr: job.hdr });
      return;
    }
    if (job.kind === 'hdr') {
      await hdr(job);
      self.postMessage({ photoId: job.photoId, success: true, source: 'render', hdr: true });
      return;
    }
    if (job.kind === 'preview') {
      await preview(job);
      self.postMessage({ photoId: job.photoId, success: true, source: job.source, hdr: job.hdr });
      return;
    }
    self.postMessage({ photoId: job.photoId, success: true, ...(await thumbnails(job)) });
  } catch (err) {
    const outputs = job.kind === 'thumbnails' ? [job.smallOutputPath, job.fullOutputPath] : [job.outputPath];
    for (const output of outputs) await Bun.file(output).delete().catch(() => {});
    self.postMessage({ photoId: job.photoId, success: false, error: (err as Error).message });
  }
};
