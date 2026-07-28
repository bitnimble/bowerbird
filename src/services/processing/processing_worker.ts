import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encodeHdr } from './hdr_media';
import { fitHdrMatch, type HdrMatch } from './hdr_match';
import { fitMatchProfile, type MatchProfile } from './jpeg_match';
import { diffuseWhite } from './tone_map';
import { decodeRaw, readEmbeddedJpeg, type DecodedImage } from './raw_decoder';
import {
  decodeImage,
  decodeRawImage,
  freeImage,
  renderImage,
  saveAvif,
  type ImageHandle,
} from './rawshim_ops';
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

// 8-bit output whatever the input depth, which is why `writeHdr` below cannot go
// through this at all and has its own encoder (§10.2). Chroma subsampling is the
// encoder's own business; see `vips.rs` for why it is off.
function toAvif(image: ImageHandle, target: RenditionTarget): void {
  saveAvif(image, target.size, target.quality, target.effort, target.outputPath);
}

/** 0 (native) beats any bounded size, since it is the whole frame. */
function largestSdrSize(targets: readonly RenditionTarget[]): number {
  const sdr = targets.filter((target) => !target.hdr);
  return sdr.some((target) => target.size === 0) ? 0 : Math.max(...sdr.map((target) => target.size));
}

// The embedded JPEG carries its own EXIF orientation, so it needs rotating; a
// render is already baked upright by the decoder (§11.1). Returns the source that
// was actually used: a body that embeds a bitmap preview, or none at all, is a
// property of the file rather than an error, so it falls back to a render.
function writeSdr(job: RenditionJob, target: RenditionTarget, base: () => ImageHandle): ThumbnailSource {
  if (target.source === 'embedded') {
    const jpeg = readEmbeddedJpeg(job.rawFilePath);
    if (jpeg != null) {
      const decoded = decodeImage(jpeg);
      try {
        toAvif(decoded, target);
        return 'embedded';
      } finally {
        freeImage(decoded);
      }
    }
  }
  // The base already carries the match, if there is one.
  toAvif(base(), target);
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
  const open: ImageHandle[] = [];

  // One decode for the whole job, shared by the fit and by every SDR rendition.
  // A 60MP frame takes about two seconds to demosaic, and a `render` import builds
  // both the grid tile and the full view from the identical pixels, so decoding per
  // rendition paid for the same work twice - and asking the fit to decode as well
  // made it three times. Lazy because an embedded-source job may never need one.
  //
  // 8-bit deliberately: AVIF output is 8-bit whatever goes in, so a 16-bit decode
  // would be twice the memory for samples the encoder discards.
  // Telling the decoder the largest SDR size this job needs lets it halve the
  // decode on a sensor big enough to spare it (§10.8). A native-resolution target
  // reports 0 and gets the whole frame.
  let decoded: ImageHandle | null = null;
  const decode = (): ImageHandle => {
    if (decoded == null) {
      decoded = decodeRawImage(job.rawFilePath, 8, 'srgb', largestSdrSize(job.targets));
      open.push(decoded);
    }
    return decoded;
  };

  // The scene-linear decode, shared the same way. An HDR job builds a still and
  // its video twin from one of these, and the colour fit needs the same pixels
  // again. Copied into JS rather than kept as a handle, because its consumer is
  // ffmpeg (§10.7) rather than anything on this side of the FFI.
  let decodedLinear: DecodedImage | null = null;
  const linear = (): DecodedImage => (decodedLinear ??= decodeRaw(job.rawFilePath, 16, 'rec2020-linear'));

  try {
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
    // rest by the encoder. Every smaller rendition is a resize of this rather than
    // its own warp and re-grade of the same picture: a `render` import builds an
    // 800px tile and a 3840px view, and transforming each separately did the
    // 9.8M-pixel work twice. Legitimate because the order does not change the
    // result - the distortion model is in normalised radii and the colour transform
    // is a per-pixel lookup - and going 3840 to 800 is also a cheaper resize than
    // 9504 to 800.
    //
    // Lazy for the same reason the decode is: a job whose only SDR target comes
    // from the embedded JPEG never demosaics at all.
    let base: ImageHandle | null = null;
    const sdrBase = (): ImageHandle => {
      if (base == null) {
        const size = largestSdrSize(job.targets);
        const source = decode();
        // A native-resolution target with no match asks for neither a resize nor
        // a grade, and `renderImage` would answer with a 190MB copy of the frame.
        const shrinks = size > 0 && Math.max(source.width, source.height) > size;
        base = profile == null && !shrinks ? source : renderImage(source, profile, size);
        if (base !== source) open.push(base);
      }
      return base;
    };

    for (const target of job.targets) {
      if (target.hdr) {
        await writeHdr(job, target, linear, hdrMatch);
        continue;
      }
      const source = writeSdr(job, target, sdrBase);
      // Only the grid is ever built from the embedded JPEG, so it is the only
      // target whose fallback the row needs to hear about.
      if (job.reportSource && target.rendition === 'grid') used = source;
    }
    return used;
  } finally {
    // A 60MP decode and its graded copy are ~380MB between them, held by Rust
    // rather than by the JS heap, so nothing collects them if this is skipped.
    for (const image of open) freeImage(image);
  }
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
