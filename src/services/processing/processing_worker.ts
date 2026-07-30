import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fitMatchProfile } from './jpeg_match';
import {
  decodeEmbedded,
  decodeRawImage,
  describeForStacking,
  encodeHdrRendition,
  fitHdrFromLinear,
  fitHdrMatch,
  freeHdrMatch,
  freeImage,
  renderImage,
  saveAvif,
  type HdrMatchHandle,
  type ImageHandle,
} from './rawshim_ops';
import type { ProcessingResult, RenditionJob, RenditionTarget, WorkerJob } from './processing_types';
import { AVIF_EFFORT } from './renditions';

// Bun worker thread (DESIGN §10.3). Writes renditions of one photo - the grid
// tile, the full-size view, the max-resolution export - in AVIF, plus the
// one-frame AV1 twin an HDR rendition needs for Firefox. On any failure it
// removes partial output so the image endpoints stay consistent (§10.2).
declare const self: {
  onmessage: ((event: MessageEvent<WorkerJob>) => void) | null;
  postMessage: (message: ProcessingResult) => void;
};

// 8-bit output whatever the input depth, which is why `writeHdr` below cannot go
// through this at all and has its own encoder (§10.2).
//
// `sdrFullChroma` is the library's setting for `full` and `max`, and always false
// for a grid tile - the service forces it rather than passing the setting through,
// since the tile's usual source is already chroma-subsampled (§10.1).
function toAvif(image: ImageHandle, target: RenditionTarget): void {
  saveAvif(image, target.size, target.sdrQuantizer, AVIF_EFFORT, target.sdrFullChroma, target.outputPath);
}

/**
 * The largest rendition of one dynamic range this job writes, or null when it writes
 * none. 0 (native) beats any bounded size, since it is the whole frame.
 */
function largestSize(targets: readonly RenditionTarget[], hdr: boolean): number | null {
  const wanted = targets.filter((target) => target.hdr === hdr);
  if (wanted.length === 0) return null;
  return wanted.some((target) => target.size === 0) ? 0 : Math.max(...wanted.map((target) => target.size));
}

// The embedded JPEG carries its own EXIF orientation, so it needs rotating; a
// render is already baked upright by the decoder (§11.1). A body that embeds a
// bitmap preview, or none at all, is a property of the file rather than an error,
// so it falls back to a render.
//
// **Every grid tile arrives here with `source: 'embedded'`**, whatever the library
// is set to - `processing_service.target` decides that, not the library's
// `rendition_source`, which governs the photo viewer alone (§10.1). So the branch
// below is the grid's normal path and `base()` is its fallback, reached only by a
// file with no usable JPEG preview. Reading this the other way round is an easy
// mistake and an expensive one: it makes the tile look like it costs a demosaic,
// when the whole job is ~76ms and never unpacks the sensor data at all.
function writeSdr(
  job: RenditionJob,
  target: RenditionTarget,
  base: () => ImageHandle,
  // Handed the pixels this rendition was actually written from, before they are
  // released. Which handle that is depends on the source, and the stacking
  // descriptor has to come from the same one the tile did (§19.3).
  wrote?: (image: ImageHandle) => void,
): void {
  if (target.source === 'embedded') {
    // Extracted, decoded and shrunk inside one call, so the preview - which is
    // full-resolution on a 61MP body, 5-14MB of JPEG - never reaches this side.
    // Asking for the target size lets it shrink during the decode (§10.4).
    const decoded = decodeEmbedded(job.rawFilePath, target.size);
    if (decoded != null) {
      try {
        toAvif(decoded, target);
        wrote?.(decoded);
        return;
      } finally {
        freeImage(decoded);
      }
    }
  }
  // The base already carries the match, if there is one. For a grid target this is
  // the no-preview fallback rather than the usual route, and it is the one thing
  // that makes a tile job demosaic.
  const image = base();
  toAvif(image, target);
  wrote?.(image);
}

// Scene-linear and wide-gamut rather than display-referred: the transfer is
// applied by the encoder after the grade, and auto-brightening would flatten away
// the highlight headroom that carries the HDR (§10.7).
//
// The decode and the fitted match are both passed in, so a still and its video twin
// share one of each - and so the ~115MB of graded samples never reach this side: the
// grade, the colour fit and both encoders are in `native/rawshim` (§10.7). The twin's
// path goes down with the still rather than into a second call, because the two share
// the grade as well (§10.7).
function writeHdr(
  job: RenditionJob,
  target: RenditionTarget,
  linear: () => ImageHandle,
  matched: HdrMatchHandle | null,
  releaseLinear: boolean,
): void {
  encodeHdrRendition(
    linear(),
    matched,
    {
      ...job.grade,
      medium: 'still',
      outputPath: target.outputPath,
      crf: target.hdrQuantizer,
      preset: target.preset,
      stillFullChroma: target.stillFullChroma,
      // One edge for both media. The video used to have an encoder ceiling on top of
      // it, which was SVT-AV1's own; libaom takes either orientation, so the twin is
      // exactly as large as the still and the two can share a grade (§10.7).
      maxEdge: target.size === 0 ? Number.POSITIVE_INFINITY : target.size,
    },
    target.videoOutputPath ?? '',
    releaseLinear,
  );
}

function outputsOf(job: WorkerJob): string[] {
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

async function renditions(job: RenditionJob): Promise<Uint8Array | undefined> {
  const open: ImageHandle[] = [];
  let descriptor: Uint8Array | undefined;

  // Frees a decode the moment the last thing that needed it is done, rather than at the
  // end of the job. The encode is the longest stage by far, so a decode held across it
  // is the peak: 366MB of a 61MP scene-linear frame, or 183MB of the 8-bit one, times
  // `processing_concurrency`. Dropped from `open` so the finally below does not double
  // free.
  const release = (image: ImageHandle): void => {
    const at = open.indexOf(image);
    if (at >= 0) open.splice(at, 1);
    freeImage(image);
  };

  // One decode for the whole job, shared by the fit and by every SDR rendition that
  // needs one. A 60MP frame takes about two seconds to demosaic, so decoding per
  // rendition paid for the same work twice and asking the fit to decode as well made
  // it three times.
  //
  // **Lazy, and a tile job never triggers it.** The grid tile comes off the embedded
  // JPEG (`writeSdr`), so an import's tile pass runs to completion without unpacking
  // sensor data at all - which is what makes it ~10x the throughput of the rendition
  // pass and worth staging separately (§10.3). This is only reached by a `full` or
  // `max` target, or by a grid tile whose file embeds no usable preview.
  //
  // 8-bit deliberately: AVIF output is 8-bit whatever goes in, so a 16-bit decode
  // would be twice the memory for samples the encoder discards.
  // Telling the decoder the largest SDR size this job needs lets it halve the
  // decode on a sensor big enough to spare it (§10.8). A native-resolution target
  // reports 0 and gets the whole frame. Only ever reached when this job writes an
  // SDR rendition, so the size is always there to ask for.
  let decoded: ImageHandle | null = null;
  // Released once the base is built, and a demand after that would silently demosaic a
  // 60MP frame a second time rather than fail - so it is made to fail. Nothing does:
  // the fit runs before the base, and every rendition is a resize of the base.
  let decodeSpent = false;
  const decode = (): ImageHandle => {
    if (decodeSpent) throw new Error('the 8-bit decode was released when the base was built');
    if (decoded == null) {
      decoded = decodeRawImage(job.rawFilePath, 8, 'srgb', largestSize(job.targets, false) ?? 0);
      open.push(decoded);
    }
    return decoded;
  };

  // The scene-linear decode, shared the same way: an HDR job builds a still and its
  // video twin from one of these, and the colour fit reads the same samples again.
  // Sized like the SDR one, and for the same reason: the grade box-resizes to the
  // largest edge asked for before it does anything else, so a full 61MP demosaic to
  // build a 3840px rendition threw away fifteen sixteenths of itself. A
  // max-resolution target reports 0 and is never halved, which is what it exists for.
  let decodedLinear: ImageHandle | null = null;
  const linear = (): ImageHandle => {
    if (decodedLinear == null) {
      decodedLinear = decodeRawImage(job.rawFilePath, 16, 'rec2020-linear', largestSize(job.targets, true) ?? 0);
      open.push(decodedLinear);
    }
    return decodedLinear;
  };

  // Released in the finally below, so it is declared out here with the handles.
  let hdrMatch: HdrMatchHandle | null = null;

  try {
    // Fitted once, before anything is written: every rendition of one photo has to
    // get the same transform, and the render has to match the camera's JPEG that the
    // grid tile is made of, or a photo changes appearance when it is opened. Null when the setting is off, when nothing in the job renders, or when
    // the fit found no match worth applying - in each case the renders below are
    // simply untransformed.
    // Gated on a target that actually demosaics: an embedded-source grid already has
    // the camera's look, so fitting for it would decode a 60MP frame to transform
    // nothing. A file with no embedded JPEG needs no gate here - there is then also
    // nothing to match against, so the fit declines on its own.
    const rendersSdr = job.targets.some((target) => !target.hdr && target.source === 'render');
    const rendersHdr = job.targets.some((target) => target.hdr);
    // The SDR renders need geometry *and* 8-bit colour, so they fit off their own
    // render. Nothing else does.
    const profile = job.matchEmbeddedJpeg && rendersSdr ? fitMatchProfile(job.rawFilePath, decode()) : null;

    // Built once at the largest SDR size the job asks for, then resized down for the
    // rest by the encoder. Every smaller rendition is a resize of this rather than
    // its own warp and re-grade of the same picture. Legitimate because the order
    // does not change the result - the distortion model is in normalised radii and
    // the colour transform is a per-pixel lookup - and going 3840 to 800 is a
    // cheaper resize than 9504 to 800.
    //
    // **No job actually carries two SDR targets today**, so nothing shares this and
    // `largestSize` always answers with the one target's own size. It used to: the
    // grid tile and the full view were built together, which is what the sharing was
    // for. They are two passes now (§10.3) and the tile takes the embedded JPEG, so
    // the only thing that reaches this closure is a single `full` or `max`, or a
    // grid tile whose file embeds no preview. Kept general because `targets` is a
    // list and the resize-from-the-base reasoning is what makes that safe - but do
    // not read it as evidence that a tile is rendered from a demosaic. It is not.
    //
    // Lazy for the same reason the decode is: a job whose only SDR target comes
    // from the embedded JPEG never demosaics at all.
    // Fitted once per photo, not once per rendition. It costs ~0.9s on a 61MP frame
    // and every rendition has to use the same one anyway, so folding it into the
    // encode - which is how this was first ported - paid for it twice on any job with
    // a video twin.
    if (job.matchEmbeddedJpeg && rendersHdr) {
      // Only the grade's own inputs matter to a fit; the encoder settings are along
      // for the ride because they share a shape.
      const options = {
        ...job.grade,
        medium: 'still',
        outputPath: '',
        crf: 0,
        preset: 0,
        maxEdge: Number.POSITIVE_INFINITY,
        stillFullChroma: false,
      } as const;
      hdrMatch = rendersSdr
        ? // The geometry is already paid for, off the 8-bit render the SDR targets
          // needed anyway, so only the colour is refitted here.
          profile == null
          ? null
          : fitHdrMatch(linear(), job.rawFilePath, options, profile)
        : // Nothing renders SDR, so there is no 8-bit render to take geometry from and
          // no reason to make one: both halves run off this decode, and off one pass
          // over it, since they want the same downscale, preview and levels (§10.8).
          (fitHdrFromLinear(linear(), job.rawFilePath, options)?.match ?? null);
    }

    let base: ImageHandle | null = null;
    const sdrBase = (): ImageHandle => {
      if (base == null) {
        const size = largestSize(job.targets, false) ?? 0;
        const source = decode();
        // A native-resolution target with no match asks for neither a resize nor
        // a grade, and `renderImage` would answer with a 190MB copy of the frame.
        const shrinks = size > 0 && Math.max(source.width, source.height) > size;
        base = profile == null && !shrinks ? source : renderImage(source, profile, size);
        if (base !== source) {
          open.push(base);
          // Nothing reads the decode again: the fit above is done, and every SDR
          // rendition is a resize of this base rather than of the frame it came from.
          // Freeing it here rather than at the end of the job is what keeps the encode
          // from running with both resident.
          release(source);
          decoded = null;
          decodeSpent = true;
        }
      }
      return base;
    };

    // Which rendition is the decode's last reader, so that one can hand its pixels back
    // before the encode instead of after the job. Identified up front rather than by
    // counting down inside the loop, since getting it wrong by one leaves the encode
    // reading a released frame.
    const lastHdr = job.targets.filter((target) => target.hdr).at(-1);

    for (const target of job.targets) {
      if (target.hdr) {
        // The profile supplies the geometry; the HDR colour is refitted inside the
        // encode, in the domain the grade works in (§10.8.1).
        writeHdr(job, target, linear, hdrMatch, target === lastHdr);
        continue;
      }
      // Described off the same pixels the tile was written from, while they are
      // still here (§19.3), and only for the grid - the one pass every photo
      // goes through exactly once whatever its library builds from.
      //
      // Through the callback rather than from `sdrBase()`, because an
      // embedded-source tile never calls that: asking it for a handle here would
      // demosaic the whole RAW for a descriptor, on the path whose entire point
      // is not doing that.
      //
      // Never fatal. A descriptor is what stacking would like, not what the
      // import owes, and a photo without one is simply not a candidate.
      writeSdr(job, target, sdrBase, target.rendition !== 'grid' ? undefined : (image) => {
        try {
          descriptor = describeForStacking(image);
        } catch {
          descriptor = undefined;
        }
      });
    }

  } finally {
    // A 60MP decode and its graded copy are ~380MB between them, held by Rust
    // rather than by the JS heap, so nothing collects them if this is skipped.
    for (const image of open) freeImage(image);
    if (hdrMatch != null) freeHdrMatch(hdrMatch);
  }
  return descriptor;
}

self.onmessage = async (event) => {
  const job = event.data;
  try {
    await ensureOutputDirs(job);
    const descriptor = await renditions(job);
    self.postMessage({ photoId: job.photoId, success: true, descriptor });
  } catch (err) {
    for (const output of outputsOf(job)) await Bun.file(output).delete().catch(() => {});
    self.postMessage({ photoId: job.photoId, success: false, error: (err as Error).message });
  }
};
