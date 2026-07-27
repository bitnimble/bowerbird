import type { DecodedImage } from './raw_decoder';

// A still frame encoded as a one-frame video, which is the only way to get HDR
// in front of Firefox: it honours no HDR image tagging at all (a PQ-tagged PNG
// and an untagged one read back identically), while its video pipeline does
// composite HDR, on Windows, by passing through to the system and the monitor.
// Nothing in the page can observe that, so this exists to be looked at on real
// hardware rather than asserted against (DESIGN §10.7).

export const HDR_VARIANTS = ['pq', 'hlg', 'sdr'] as const;
export type HdrVariant = (typeof HDR_VARIANTS)[number];

export function isHdrVariant(value: string): value is HdrVariant {
  return (HDR_VARIANTS as readonly string[]).includes(value);
}

export interface HdrVideoOptions {
  variant: HdrVariant;
  outputPath: string;
  /** Nits that a fully exposed sensor sample maps to. Ignored by 'sdr'. */
  peakNits: number;
  /** SVT-AV1 constant-quality level; lower is better and slower. */
  crf: number;
  /** SVT-AV1 speed preset, 0 slowest to 13 fastest. */
  preset: number;
  /** Longest edge of the output. A larger frame is fitted to it. */
  maxEdge: number;
}

// AV1 tops out below a current sensor: SVT-AV1 encodes 8192x4352 but refuses a
// 6336x9504 60MP frame outright, failing with "code: -22 (Invalid argument)"
// and writing nothing. The still is meant to be looked at on a monitor, so
// oversized frames are fitted rather than rejected; yuv420 needs both edges
// even.
export function fitted(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return { width, height };
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

// AV1 rather than VP9 or HEVC: Firefox decodes AV1 everywhere without relying on
// a platform decoder, and it is the only one of the three whose colour
// signalling survives this ffmpeg build. VP9-in-WebM silently loses the
// primaries and transfer and has no metadata bitstream filter to put them back.
const CODEC = ['-c:v', 'libsvtav1'];

// Rec.2020 primaries and the D65 white point, as SMPTE ST 2086 expects them.
// MaxCLL/MaxFALL are declared rather than measured: they are a hint for a
// display's tone mapping, and getting them exactly right needs a histogram pass
// that would not change what the panel does with a single still.
function masteringDisplay(peakNits: number): string {
  return [
    'mastering-display=G(0.265,0.690)B(0.150,0.060)R(0.680,0.320)WP(0.3127,0.3290)',
    `L(${peakNits},0.0001)`,
    `:content-light=${peakNits},${Math.round(peakNits / 2)}`,
  ].join('');
}

// The transfer, matrix and primaries as AV1 spec section 6.4.2 numbers, for the
// bitstream filter below.
const CICP: Record<HdrVariant, { primaries: number; transfer: number; matrix: number }> = {
  pq: { primaries: 9, transfer: 16, matrix: 9 }, // BT.2020, SMPTE ST 2084, BT.2020 non-constant
  hlg: { primaries: 9, transfer: 18, matrix: 9 }, // BT.2020, ARIB STD-B67
  sdr: { primaries: 1, transfer: 1, matrix: 1 }, // BT.709 throughout
};

// The same three as ffmpeg's -color_* option values, plus the pixel format the
// encoder wants.
const TAGS: Record<HdrVariant, { transfer: string; matrix: string; primaries: string; format: string }> = {
  pq: { transfer: 'smpte2084', matrix: 'bt2020nc', primaries: 'bt2020', format: 'yuv420p10le' },
  hlg: { transfer: 'arib-std-b67', matrix: 'bt2020nc', primaries: 'bt2020', format: 'yuv420p10le' },
  sdr: { transfer: 'bt709', matrix: 'bt709', primaries: 'bt709', format: 'yuv420p' },
};

// zscale takes ffmpeg's spelling of all three as aliases for zimg's own, so the
// table above serves both. Its identity matrix is the exception: that is `gbr`,
// and `rgb` is rejected.
const RGB_MATRIX = 'gbr';

// The decode hands back scene-linear Rec.2020 at full range, so the input side of
// the conversion has to say so: zscale reads the frame's tags, and rawvideo
// carries none. npl is what ties linear 1.0 to an absolute brightness, and so is
// the one number that decides how bright the result looks.
function filterChain(variant: HdrVariant, peakNits: number, size: { width: number; height: number } | null): string {
  const target = TAGS[variant];
  const npl = variant === 'sdr' ? '' : `:npl=${peakNits}`;
  // Resizing inside zscale keeps it in the linear light the decode handed over,
  // which is where downscaling is correct; a resize after the transfer would
  // average PQ code values and darken the result.
  const resize = size == null ? '' : `:w=${size.width}:h=${size.height}`;
  return [
    `zscale=tin=linear:min=${RGB_MATRIX}:pin=bt2020:rin=full`,
    `:t=${target.transfer}:m=${target.matrix}:p=${target.primaries}:r=tv${npl}${resize}`,
    `,format=${target.format}`,
  ].join('');
}

export function ffmpegArgs(image: { width: number; height: number }, options: HdrVideoOptions): string[] {
  const { variant, peakNits, outputPath } = options;
  const cicp = CICP[variant];
  const target = TAGS[variant];
  const size = fitted(image.width, image.height, options.maxEdge);
  const resize = size.width === image.width && size.height === image.height ? null : size;

  // SVT-AV1 drops the primaries and transfer on its own, leaving a file that
  // says "unknown" where it matters most, so av1_metadata writes them back into
  // the sequence header. Verified with ffprobe: without the filter the stream
  // reports color_primaries=unknown, with it bt2020/smpte2084.
  const metadata = [
    `av1_metadata=color_primaries=${cicp.primaries}`,
    `:transfer_characteristics=${cicp.transfer}`,
    `:matrix_coefficients=${cicp.matrix}`,
    ':color_range=tv',
  ].join('');

  return [
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
    ...CODEC,
    '-preset', String(options.preset),
    '-crf', String(options.crf),
    '-vf', filterChain(variant, peakNits, resize),
    '-color_primaries', target.primaries,
    '-color_trc', target.transfer,
    '-colorspace', target.matrix,
    '-color_range', 'tv',
    ...(variant === 'sdr' ? [] : ['-svtav1-params', masteringDisplay(peakNits)]),
    '-bsf:v', metadata,
    // The still has to be seekable and decodable from the first byte, since it is
    // displayed rather than streamed.
    '-movflags', '+faststart',
    outputPath,
  ];
}

export async function encodeHdrVideo(image: DecodedImage, options: HdrVideoOptions): Promise<void> {
  if (image.depth !== 16) throw new Error(`HDR encode needs a 16-bit decode, got ${image.depth}`);

  const proc = Bun.spawn(ffmpegArgs(image, options), { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  // ~115MB down a pipe: write and close before awaiting, or ffmpeg blocks on a
  // stdin that never ends and the exit code never arrives.
  proc.stdin.write(image.data);
  await proc.stdin.end();

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    const tail = stderr.trim().split('\n').slice(-3).join('; ');
    throw new Error(`ffmpeg failed (${exitCode}): ${tail === '' ? 'no output' : tail}`);
  }
}
