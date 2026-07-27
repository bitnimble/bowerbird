import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { encodeHdr } from './hdr_media';
import { applyMatchProfile, fitMatchProfile, type MatchProfile } from './jpeg_match';
import { decodeRaw, readEmbeddedJpeg } from './raw_decoder';
import type {
  HdrJob,
  ProcessingResult,
  RenditionJob,
  RenditionTarget,
  ThumbnailSource,
  WorkerJob,
} from './processing_types';

// Bun worker thread (DESIGN §10.3). Writes renditions of one photo - the grid
// tile, the full-size view, the max-resolution export - in AVIF, plus the
// one-frame AV1 twin an HDR rendition needs for Firefox. On any failure it
// removes partial output so the image endpoints stay consistent (§10.2).
declare const self: {
  onmessage: ((event: MessageEvent<WorkerJob>) => void) | null;
  postMessage: (message: ProcessingResult) => void;
};

// 4:4:4, because these are photographs: 4:2:0 keeps luma at full resolution but
// drops chroma to a quarter of the samples, smearing the saturated edges a photo
// is judged on. sharp's AVIF is 8-bit whatever the input depth, which is why the
// HDR path below cannot go through sharp at all (§10.2).
function fit(image: sharp.Sharp, target: RenditionTarget): sharp.Sharp {
  return target.size === 0 ? image : image.resize({ width: target.size, height: target.size, fit: 'inside' });
}

function toAvif(image: sharp.Sharp, target: RenditionTarget): sharp.Sharp {
  return fit(image, target).avif({ quality: target.quality, effort: target.effort, chromaSubsampling: '4:4:4' });
}

// The match transform after the resize rather than before it. The distortion model
// is in radii normalised to the half-diagonal, so it is resolution-independent, and
// the colour transform is a per-pixel lookup - which makes this the same picture
// either way, for a fraction of the work. Warping the full 60MP decode when the
// output is an 800px tile costs seconds per rendition, and the worker builds
// several from one photo.
async function toMatchedAvif(image: sharp.Sharp, target: RenditionTarget, profile: MatchProfile): Promise<void> {
  const sized = await fit(image, target).raw().toBuffer({ resolveWithObject: true });
  const matched = await applyMatchProfile(
    { width: sized.info.width, height: sized.info.height, channels: 3, depth: 8, data: sized.data },
    profile,
  );
  const raw = { raw: { width: matched.width, height: matched.height, channels: matched.channels } };
  await sharp(matched.data, raw)
    .avif({ quality: target.quality, effort: target.effort, chromaSubsampling: '4:4:4' })
    .toFile(target.outputPath);
}

// The embedded JPEG carries its own EXIF orientation, so it needs rotating; a
// render is already baked upright by the decoder (§11.1). Returns the source that
// was actually used: a body that embeds a bitmap preview, or none at all, is a
// property of the file rather than an error, so it falls back to a render.
async function writeSdr(
  job: RenditionJob,
  target: RenditionTarget,
  profile: MatchProfile | null,
): Promise<ThumbnailSource> {
  if (target.source === 'embedded') {
    const jpeg = readEmbeddedJpeg(job.rawFilePath);
    if (jpeg != null) {
      await toAvif(sharp(jpeg).rotate(), target).toFile(target.outputPath);
      return 'embedded';
    }
  }
  // An 8-bit decode deliberately: sharp's AVIF output is 8-bit whatever goes in,
  // and asking for 16 would reintroduce the trap that `raw.depth` is ignored on a
  // Buffer, so the samples get read as 8-bit anyway and the picture is wrong.
  const image = decodeRaw(job.rawFilePath, 8);
  const raw = { raw: { width: image.width, height: image.height, channels: image.channels } };
  if (profile == null) await toAvif(sharp(image.data, raw), target).toFile(target.outputPath);
  else await toMatchedAvif(sharp(image.data, raw), target, profile);
  return 'render';
}

// Scene-linear and wide-gamut rather than display-referred: the transfer is
// applied by the encoder after the grade, and auto-brightening would flatten away
// the highlight headroom that carries the HDR (§10.7).
async function writeHdr(job: RenditionJob, target: RenditionTarget): Promise<void> {
  const image = decodeRaw(job.rawFilePath, 16, 'rec2020-linear');
  const common = {
    ...job.grade,
    crf: target.quantizer,
    preset: target.preset,
    // The still is never fitted past what was asked for; the video is, because
    // the encoder caps height at 8704 and a max-resolution frame exceeds it.
    maxEdge: target.size === 0 ? Number.POSITIVE_INFINITY : target.size,
  } as const;
  await encodeHdr(image, { ...common, variant: 'pq', medium: 'still', outputPath: target.outputPath });
  if (target.videoOutputPath == null) return;
  await encodeHdr(image, { ...common, variant: 'pq', medium: 'video', outputPath: target.videoOutputPath });
}

// One HDR rendition for the check page: an AVIF still for Chrome, or a one-frame
// video for Firefox, which applies a PQ transfer to nothing else (§10.7).
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

function outputsOf(job: WorkerJob): string[] {
  if (job.kind === 'hdr') return [job.outputPath];
  return job.targets.flatMap((t) => (t.videoOutputPath == null ? [t.outputPath] : [t.outputPath, t.videoOutputPath]));
}

// Every writer here fails on a missing directory rather than creating one, and
// ffmpeg fails the whole job rather than the one output, so this runs before any
// of them. Here rather than at the call site because the outputs are the job's,
// and each new rendition otherwise adds a directory somebody has to remember.
async function ensureOutputDirs(job: WorkerJob): Promise<void> {
  for (const dir of new Set(outputsOf(job).map((output) => path.dirname(output)))) {
    await mkdir(dir, { recursive: true });
  }
}

async function renditions(job: RenditionJob): Promise<ThumbnailSource | undefined> {
  let used: ThumbnailSource | undefined;
  // Fitted once for the whole job, before anything is written: every SDR rendition
  // of one photo has to get the same transform or the grid tile and the full view
  // will not match each other. Null when the setting is off, when nothing in the
  // job renders, or when the fit found no match worth applying - and in every one
  // of those cases the renders below are simply untransformed.
  const rendersSdr = job.targets.some((target) => !target.hdr);
  const profile = job.matchEmbeddedJpeg && rendersSdr ? await fitMatchProfile(job.rawFilePath) : null;

  for (const target of job.targets) {
    if (target.hdr) {
      await writeHdr(job, target);
      continue;
    }
    const source = await writeSdr(job, target, profile);
    // Only the grid is ever built from the embedded JPEG, so it is the only
    // target whose fallback the row needs to hear about.
    if (job.reportSource && target.rendition === 'grid') used = source;
  }
  return used;
}

self.onmessage = async (event) => {
  const job = event.data;
  try {
    await ensureOutputDirs(job);
    if (job.kind === 'hdr') {
      await hdr(job);
      self.postMessage({ photoId: job.photoId, success: true });
      return;
    }
    self.postMessage({ photoId: job.photoId, success: true, source: await renditions(job) });
  } catch (err) {
    for (const output of outputsOf(job)) await Bun.file(output).delete().catch(() => {});
    self.postMessage({ photoId: job.photoId, success: false, error: (err as Error).message });
  }
};
