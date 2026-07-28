import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { encodeHdr } from './hdr_media';
import { fitHdrMatch, type HdrMatch } from './hdr_match';
import { applyMatchProfile, fitMatchProfile, type MatchProfile } from './jpeg_match';
import { diffuseWhite } from './tone_map';
import { decodeRaw, readEmbeddedJpeg, type DecodedImage } from './raw_decoder';
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
function fitTo(image: sharp.Sharp, size: number): sharp.Sharp {
  return size === 0 ? image : image.resize({ width: size, height: size, fit: 'inside' });
}

function toAvif(image: sharp.Sharp, target: RenditionTarget): sharp.Sharp {
  return fitTo(image, target.size).avif({
    quality: target.quality,
    effort: target.effort,
    chromaSubsampling: '4:4:4',
  });
}

interface Plane {
  width: number;
  height: number;
  data: Buffer;
}

function planeSource(plane: Plane): sharp.Sharp {
  return sharp(plane.data, { raw: { width: plane.width, height: plane.height, channels: 3 } });
}

/** 0 (native) beats any bounded size, since it is the whole frame. */
function largestSdrSize(targets: readonly RenditionTarget[]): number {
  const sdr = targets.filter((target) => !target.hdr);
  return sdr.some((target) => target.size === 0) ? 0 : Math.max(...sdr.map((target) => target.size));
}

/**
 * The render with the match applied, once, at the largest SDR size the job needs.
 *
 * Every smaller rendition is then a resize of this rather than its own warp and
 * re-grade of the same picture: a `render` import builds an 800px tile and a
 * 3840px view, and transforming each separately did the 9.8M-pixel work twice.
 * Legitimate because the order does not change the result - the distortion model
 * is in normalised radii and the colour transform is a per-pixel lookup - and
 * going 3840 to 800 is also a cheaper resize than 9504 to 800.
 */
async function matchedBase(image: DecodedImage, size: number, profile: MatchProfile | null): Promise<Plane> {
  const raw = { raw: { width: image.width, height: image.height, channels: image.channels } };
  const sized = await fitTo(sharp(image.data, raw), size).raw().toBuffer({ resolveWithObject: true });
  const plane: Plane = { width: sized.info.width, height: sized.info.height, data: sized.data };
  if (profile == null) return plane;
  const matched = await applyMatchProfile({ ...plane, channels: 3, depth: 8 }, profile);
  return { width: matched.width, height: matched.height, data: matched.data };
}

// The embedded JPEG carries its own EXIF orientation, so it needs rotating; a
// render is already baked upright by the decoder (§11.1). Returns the source that
// was actually used: a body that embeds a bitmap preview, or none at all, is a
// property of the file rather than an error, so it falls back to a render.
async function writeSdr(
  job: RenditionJob,
  target: RenditionTarget,
  base: () => Promise<Plane>,
): Promise<ThumbnailSource> {
  if (target.source === 'embedded') {
    const jpeg = readEmbeddedJpeg(job.rawFilePath);
    if (jpeg != null) {
      await toAvif(sharp(jpeg).rotate(), target).toFile(target.outputPath);
      return 'embedded';
    }
  }
  // The base already carries the match, if there is one.
  await toAvif(planeSource(await base()), target).toFile(target.outputPath);
  return 'render';
}

// Scene-linear and wide-gamut rather than display-referred: the transfer is
// applied by the encoder after the grade, and auto-brightening would flatten away
// the highlight headroom that carries the HDR (§10.7).
async function writeHdr(
  job: RenditionJob,
  target: RenditionTarget,
  linear: () => DecodedImage,
  match: HdrMatch | null,
): Promise<void> {
  const image = linear();
  const common = {
    ...job.grade,
    match,
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
    // The check page renders the neutral grade on purpose: it exists to judge
    // the tone mapping, and the camera's colour on top would be one more
    // variable in the comparison.
    match: null,
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

  // One decode for the whole job, shared by the fit and by every SDR rendition.
  // A 60MP frame takes about two seconds to demosaic, and a `render` import builds
  // both the grid tile and the full view from the identical pixels, so decoding per
  // rendition paid for the same work twice - and asking the fit to decode as well
  // made it three times. Lazy because an embedded-source job may never need one.
  //
  // 8-bit deliberately: sharp's AVIF output is 8-bit whatever goes in, and asking
  // for 16 would reintroduce the trap that `raw.depth` is ignored on a Buffer, so
  // the samples get read as 8-bit anyway and the picture is silently wrong.
  let decoded: DecodedImage | null = null;
  const decode = (): DecodedImage => (decoded ??= decodeRaw(job.rawFilePath, 8));

  // The scene-linear decode, shared the same way. An HDR job builds a still and
  // its video twin from one of these, and the colour fit needs the same pixels
  // again.
  let decodedLinear: DecodedImage | null = null;
  const linear = (): DecodedImage => (decodedLinear ??= decodeRaw(job.rawFilePath, 16, 'rec2020-linear'));

  // Fitted once, before anything is written: every rendition of one photo has to
  // get the same transform or the grid tile and the full view will not match each
  // other. Null when the setting is off, when nothing in the job renders, or when
  // the fit found no match worth applying - in each case the renders below are
  // simply untransformed.
  // Gated on a target that actually demosaics: an embedded-source grid already has
  // the camera's look, so fitting for it would decode a 60MP frame to transform
  // nothing. A file with no embedded JPEG needs no gate here - there is then also
  // nothing to match against, so the fit declines on its own.
  const rendersSdr = job.targets.some((target) => !target.hdr && target.source === 'render');
  const rendersHdr = job.targets.some((target) => target.hdr);
  const profile =
    job.matchEmbeddedJpeg && (rendersSdr || rendersHdr) ? await fitMatchProfile(job.rawFilePath, decode()) : null;

  // The SDR profile's colour cannot be reused for HDR - its curves are 8-bit sRGB
  // and stop at display white, where the HDR grade needs a domain it can carry
  // past diffuse white (§10.8). The geometry is a property of the lens, so that
  // half *is* reused, and it is the expensive half.
  const jpegBytes = profile != null && rendersHdr ? readEmbeddedJpeg(job.rawFilePath) : null;
  const hdrMatch =
    profile != null && jpegBytes != null
      ? await fitHdrMatch(linear(), diffuseWhite(linear(), job.grade.whiteQuantile), jpegBytes, profile)
      : null;

  // Built once at the largest SDR size the job asks for, then resized down for the
  // rest. Lazy for the same reason the decode is: a job whose only SDR target comes
  // from the embedded JPEG never demosaics at all.
  let base: Plane | null = null;
  const sdrBase = async (): Promise<Plane> => (base ??= await matchedBase(decode(), largestSdrSize(job.targets), profile));

  for (const target of job.targets) {
    if (target.hdr) {
      await writeHdr(job, target, linear, hdrMatch);
      continue;
    }
    const source = await writeSdr(job, target, sdrBase);
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
