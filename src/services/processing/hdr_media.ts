import type { DecodedImage } from './raw_decoder';

// HDR renditions of one photo, in the two containers a browser will apply a PQ
// transfer to (DESIGN §10.7).
//
// The still is an AVIF, which Chrome renders as HDR on Android 14+ and on
// desktop, and Safari renders on macOS - including at 4:4:4, confirmed on an
// HDR display. Firefox honours no HDR image tagging at all - a PQ-tagged PNG and
// an untagged one read back identically - so for Firefox the same pixels are also
// encoded as a one-frame video, since its video pipeline does composite HDR on
// Windows by passing through to the compositor and the monitor. Neither can be
// checked from script, because anything read back through a canvas has already
// been tone-mapped, so both exist to be looked at on real hardware alongside an
// SDR reference to compare against.

// PQ only, plus the SDR reference to compare it against. HLG was carried for a
// while and never earned it: everything that renders HDR at all renders PQ, and
// PQ is absolute where HLG is relative to the display's own range, which makes
// it the wrong curve for judging whether a given panel reaches a given nits
// value.
export const HDR_VARIANTS = ['pq', 'sdr'] as const;
export type HdrVariant = (typeof HDR_VARIANTS)[number];

// 'still-baseline' is the same AVIF at 4:2:0, and exists only as a control.
// 4:4:4 is AVIF's Advanced profile (AV1 High), which a decoder may refuse while
// still claiming AVIF support - only Baseline is mandatory. Apple decodes images
// through the OS, and that stack has no 4:4:4 path for VP9, so whether it has
// one for AVIF is unknown. Without a 4:2:0 control beside it, a still failing on
// an Apple device cannot be told apart from a failure to handle HDR at all.
export const HDR_MEDIA = ['still', 'still-baseline', 'video'] as const;
export type HdrMedium = (typeof HDR_MEDIA)[number];

function isStill(medium: HdrMedium): boolean {
  return medium === 'still' || medium === 'still-baseline';
}

export function isHdrVariant(value: string): value is HdrVariant {
  return (HDR_VARIANTS as readonly string[]).includes(value);
}

export function isHdrMedium(value: string): value is HdrMedium {
  return (HDR_MEDIA as readonly string[]).includes(value);
}

export function extensionFor(medium: HdrMedium): string {
  return isStill(medium) ? '.avif' : '.mp4';
}

export function contentTypeFor(medium: HdrMedium): string {
  return isStill(medium) ? 'image/avif' : 'video/mp4';
}

// 4:2:0 only for the control; everything else keeps full chroma.
function chromaFor(medium: HdrMedium): '420' | '444' {
  return medium === 'still-baseline' ? '420' : '444';
}

export interface HdrEncodeOptions {
  variant: HdrVariant;
  medium: HdrMedium;
  outputPath: string;
  /** Nits that a fully exposed sensor sample maps to. Ignored by 'sdr'. */
  peakNits: number;
  /** Constant-quality level; lower is better and slower. */
  crf: number;
  /** Encoder speed, 0 slowest. Clamped per encoder: libaom 0-8, avifenc 0-10. */
  preset: number;
  /** Longest edge of the output. A larger frame is fitted to it. */
  maxEdge: number;
}

// yuv420 has no odd dimensions.
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function fitted(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return { width, height };
  return { width: even(width * scale), height: even(height * scale) };
}

// SVT-AV1's constraint, stated in its own words: "Source Height must be less
// than or equal to 8704". There is no matching width limit - 12288 wide encodes
// fine - so it is portrait frames that hit it, and a 60MP one does: 6336x9504
// fails while the same frame landscape does not.
//
// The asymmetry means a tall frame could be encoded rotated and turned back in
// the client, which would keep the last 9% of its height. Not done: it is 9% of
// linear resolution on a view already past any display's row count, and the
// obvious way to signal the rotation - the MP4 display matrix - is exactly what
// Firefox 153 lists as "not shown as HDR", so it would have to be CSS on the
// one browser this file exists for.
const MAX_VIDEO_HEIGHT = 8704;

export function fittedForVideo(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const first = fitted(width, height, maxEdge);
  if (first.height <= MAX_VIDEO_HEIGHT) return first;
  return { width: even(first.width * (MAX_VIDEO_HEIGHT / first.height)), height: MAX_VIDEO_HEIGHT };
}

// Transfer, matrix and primaries as CICP numbers (AV1 spec 6.4.2, and the same
// values AVIF's colr box carries), alongside ffmpeg's names for them. zscale
// takes ffmpeg's spelling as an alias for zimg's own, so one table serves the
// filter and the tagging both.
interface Coding {
  name: string;
  cicp: number;
}

interface Target {
  primaries: Coding;
  transfer: Coding;
  matrix: Coding;
}

const BT2020: Coding = { name: 'bt2020', cicp: 9 };
const BT2020_NCL: Coding = { name: 'bt2020nc', cicp: 9 };
const BT709: Coding = { name: 'bt709', cicp: 1 };

const TARGETS: Record<HdrVariant, Target> = {
  pq: { primaries: BT2020, transfer: { name: 'smpte2084', cicp: 16 }, matrix: BT2020_NCL },
  sdr: { primaries: BT709, transfer: BT709, matrix: BT709 },
};

// A still's SDR reference is tagged sRGB rather than BT.709. They share
// primaries, but BT.709's transfer is a camera OETF, and a browser renders an
// untagged still against sRGB - so sRGB is what makes the control look like an
// ordinary picture. Video keeps BT.709, which is what a video decoder expects.
const STILL_SDR_TRANSFER: Coding = { name: 'iec61966-2-1', cicp: 13 };

function targetFor(variant: HdrVariant, medium: HdrMedium): Target {
  const target = TARGETS[variant];
  if (variant !== 'sdr' || !isStill(medium)) return target;
  return { ...target, transfer: STILL_SDR_TRANSFER };
}

// zscale names the identity matrix `gbr` and rejects `rgb` outright.
const RGB_MATRIX = 'gbr';

// Rec.2020 primaries and the D65 white point, as SMPTE ST 2086 expects them.
function masteringDisplay(peakNits: number): string {
  return [
    'mastering-display=G(0.265,0.690)B(0.150,0.060)R(0.680,0.320)WP(0.3127,0.3290)',
    `L(${peakNits},0.0001)`,
    `:content-light=${peakNits},${Math.round(peakNits / 2)}`,
  ].join('');
}

// The still is 4:4:4. It is a photograph, and 4:2:0 keeps luma at full
// resolution while dropping chroma to a quarter of the samples, smearing
// precisely the saturated edges a photo is judged on. At 4:4:4 a 24MP frame
// still encodes in under half a second, so there is nothing to trade for.
// Not identity/RGB: avifenc relabels y4m planes as GBR without converting them
// (SSIM 0.55 against the correct decode), and RGB compresses worse than
// decorrelated YCbCr anyway.
//
// The video is 4:2:0, which is AV1 Profile 0. 4:4:4 was tried and reverted: it
// is Profile 1, Chromium refuses it outright, Safari cannot hardware-decode it,
// and on Firefox/Windows it played but rendered washed out - PQ code values
// shown with no transfer applied, which is what a decode that never reaches the
// HDR compositor looks like. Profile 0 is the only one a hardware decoder and an
// overlay path will take, and this file exists to reach that path. Chroma
// resolution is the cheapest thing to give up in a file judged on brightness.
//
// A still is 10-bit whatever the variant, so its SDR reference differs from the
// HDR ones only in transfer and tagging. Video keeps 8-bit SDR, which is what an
// SDR video actually is.
function pixelFormat(variant: HdrVariant, medium: HdrMedium): string {
  if (isStill(medium)) return `yuv${chromaFor(medium)}p10le`;
  return variant === 'sdr' ? 'yuv420p' : 'yuv420p10le';
}

// The decode hands back scene-linear Rec.2020 at full range, so the input side of
// the conversion has to say so: zscale reads the frame's tags, and rawvideo
// carries none. npl is what ties linear 1.0 to an absolute brightness, and so is
// the one number that decides how bright the result looks.
function filterChain(options: HdrEncodeOptions, size: { width: number; height: number } | null): string {
  const { variant, medium, peakNits } = options;
  const target = targetFor(variant, medium);
  const npl = variant === 'sdr' ? '' : `:npl=${peakNits}`;
  // Resizing inside zscale keeps it in the linear light the decode handed over,
  // which is where downscaling is correct; a resize after the transfer would
  // average PQ code values and darken the result.
  const resize = size == null ? '' : `:w=${size.width}:h=${size.height}`;
  return [
    `zscale=tin=linear:min=${RGB_MATRIX}:pin=bt2020:rin=full`,
    `:t=${target.transfer.name}:m=${target.matrix.name}:p=${target.primaries.name}:r=tv${npl}${resize}`,
    `,format=${pixelFormat(variant, medium)}`,
  ].join('');
}

export function ffmpegArgs(image: { width: number; height: number }, options: HdrEncodeOptions): string[] {
  const { variant, medium, peakNits, outputPath } = options;
  const target = targetFor(variant, medium);
  // Video has an encoder ceiling on top of the requested edge; a still does not.
  const size =
    medium === 'video'
      ? fittedForVideo(image.width, image.height, options.maxEdge)
      : fitted(image.width, image.height, options.maxEdge);
  const resize = size.width === image.width && size.height === image.height ? null : size;

  const input = [
    'ffmpeg',
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    // LibRaw's samples are in native order, so no byte swap is needed here.
    '-f', 'rawvideo',
    '-pixel_format', 'rgb48le',
    '-video_size', `${image.width}x${image.height}`,
    '-framerate', '1',
    '-i', '-',
    '-frames:v', '1',
    '-vf', filterChain(options, resize),
  ];

  // The still is only converted here, then handed to avifenc: ffmpeg's avif
  // muxer writes no colr box, so the primaries and transfer are lost exactly as
  // they are below, and AVIF has no equivalent of the bitstream filter to put
  // them back. y4m carries the pixels and nothing else; avifenc does the tagging.
  if (isStill(medium)) return [...input, '-strict', '-1', '-f', 'yuv4mpegpipe', outputPath];

  // The encoder drops the primaries and transfer on its own, leaving a file that
  // says "unknown" where it matters most, so av1_metadata writes them back into
  // the sequence header. Verified with ffprobe: without the filter the stream
  // reports color_primaries=unknown, with it bt2020/smpte2084.
  const metadata = [
    `av1_metadata=color_primaries=${target.primaries.cicp}`,
    `:transfer_characteristics=${target.transfer.cicp}`,
    `:matrix_coefficients=${target.matrix.cicp}`,
    ':color_range=tv',
  ].join('');

  return [
    ...input,
    // SVT-AV1, which does Profile 0 only - exactly what is wanted here, and it
    // is 2.4x faster than libaom and the only one of the two that can carry the
    // mastering-display and content-light metadata through ffmpeg.
    '-c:v', 'libsvtav1',
    '-preset', String(options.preset),
    '-crf', String(options.crf),
    '-color_primaries', target.primaries.name,
    '-color_trc', target.transfer.name,
    '-colorspace', target.matrix.name,
    '-color_range', 'tv',
    // SMPTE ST 2086 and MaxCLL/MaxFALL. Declared rather than measured: they are
    // a hint for a display's tone mapping, and a histogram pass would not change
    // what a panel does with one still. The SDR reference gets none, so there is
    // nothing for it to be tone-mapped against.
    ...(variant === 'sdr' ? [] : ['-svtav1-params', masteringDisplay(peakNits)]),
    '-bsf:v', metadata,
    // Seekable and decodable from the first byte, since it is displayed rather
    // than streamed.
    '-movflags', '+faststart',
    outputPath,
  ];
}

export function avifencArgs(options: HdrEncodeOptions, y4mPath: string): string[] {
  const target = targetFor(options.variant, options.medium);
  return [
    'avifenc',
    // The whole point of routing through avifenc: an explicit nclx colr box,
    // which is what Chrome reads to decide a still is HDR.
    '--cicp', `${target.primaries.cicp}/${target.transfer.cicp}/${target.matrix.cicp}`,
    '--range', 'limited',
    '--depth', '10',
    // avifenc takes the chroma from the y4m and this flag only has to agree with
    // it: passing 444 while feeding a 4:2:0 y4m silently encoded 4:2:0 anyway,
    // which is how the subsampling went unnoticed.
    '--yuv', chromaFor(options.medium),
    '--speed', String(Math.min(10, options.preset)),
    '--min', '0',
    '--max', String(options.crf),
    // Single-threaded by default, and it is most of the encode time: 9.6s
    // against 0.5s on a 24MP frame.
    '--jobs', 'all',
    y4mPath,
    options.outputPath,
  ];
}

async function finish(exited: Promise<number>, stderr: ReadableStream<Uint8Array>, command: string): Promise<void> {
  const [exitCode, text] = await Promise.all([exited, new Response(stderr).text()]);
  if (exitCode === 0) return;
  const tail = text.trim().split('\n').slice(-3).join('; ');
  throw new Error(`${command} failed (${exitCode}): ${tail === '' ? 'no output' : tail}`);
}

async function pipeTo(args: string[], data: Buffer): Promise<void> {
  const proc = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  // ~115MB down a pipe: write and close before awaiting, or the child blocks on
  // a stdin that never ends and the exit code never arrives.
  proc.stdin.write(data);
  await proc.stdin.end();
  await finish(proc.exited, proc.stderr, args[0] ?? 'command');
}

async function run(args: string[]): Promise<void> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  await finish(proc.exited, proc.stderr, args[0] ?? 'command');
}

export async function encodeHdr(image: DecodedImage, options: HdrEncodeOptions): Promise<void> {
  if (image.depth !== 16) throw new Error(`HDR encode needs a 16-bit decode, got ${image.depth}`);

  if (options.medium === 'video') {
    await pipeTo(ffmpegArgs(image, options), image.data);
    return;
  }

  const y4mPath = `${options.outputPath}.y4m`;
  try {
    await pipeTo(ffmpegArgs(image, { ...options, outputPath: y4mPath }), image.data);
    await run(avifencArgs(options, y4mPath));
  } finally {
    await Bun.file(y4mPath).delete().catch(() => {});
  }
}
