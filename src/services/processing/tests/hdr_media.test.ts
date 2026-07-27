import { expect, test } from 'bun:test';
import {
  HDR_MEDIA,
  HDR_VARIANTS,
  type HdrVariant,
  avifencArgs,
  extensionFor,
  ffmpegArgs,
  fitted,
  isHdrMedium,
  isHdrVariant,
} from '../hdr_media';

const IMAGE = { width: 4024, height: 6024 };
const OPTIONS = {
  medium: 'video' as const,
  outputPath: '/tmp/out.mp4',
  peakNits: 1000,
  referenceWhiteNits: 203,
  whiteQuantile: 0.99,
  crf: 20,
  preset: 8,
  maxEdge: 8192,
};

function argsFor(variant: HdrVariant): string[] {
  return ffmpegArgs(IMAGE, { ...OPTIONS, variant });
}

function valueOf(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

test('the bitstream filter restates the colour signalling the encoder drops', () => {
  // The encoder writes "unknown" primaries and transfer however the -color_*
  // options are set, so these numbers are the only thing making the video HDR.
  // AV1 spec 6.4.2: 9 = BT.2020, 16 = SMPTE ST 2084.
  expect(valueOf(argsFor('pq'), '-bsf:v')).toBe(
    'av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9:color_range=tv',
  );
  expect(valueOf(argsFor('sdr'), '-bsf:v')).toContain('transfer_characteristics=1');
});

test('the conversion is told the input is scene-linear Rec.2020, not display sRGB', () => {
  // Without these the filter assumes the frame is already display-referred and
  // applies no transfer at all, which produces a black picture.
  const chain = valueOf(argsFor('pq'), '-vf') ?? '';
  expect(chain).toContain('tin=linear');
  expect(chain).toContain('pin=bt2020');
  // zscale names the identity matrix `gbr` and rejects `rgb` outright.
  expect(chain).toContain('min=gbr');
  expect(chain).toContain('t=smpte2084');
  expect(chain).toContain('npl=1000');
});

test('the peak is what ties linear 1.0 to a brightness', () => {
  const args = ffmpegArgs(IMAGE, { ...OPTIONS, variant: 'pq', peakNits: 4000 });
  expect(valueOf(args, '-vf')).toContain('npl=4000');
});

test('the SDR reference gets no PQ transfer to be stretched by', () => {
  const args = argsFor('sdr');
  expect(valueOf(args, '-vf')).not.toContain('npl=');
  expect(valueOf(args, '-color_trc')).toBe('bt709');
});

test('the video is Profile 0, which is the only profile that reaches an HDR compositor', () => {
  // 4:4:4 is Profile 1: Chromium refuses it, Safari cannot hardware-decode it,
  // and Firefox on Windows played it washed out - PQ values with no transfer
  // applied, i.e. a decode that never reached the HDR path. SVT-AV1 does
  // Profile 0 only, which is exactly what is wanted, and is the only encoder
  // here that can carry the mastering metadata.
  const args = argsFor('pq');
  expect(valueOf(args, '-c:v')).toBe('libsvtav1');
  expect(valueOf(args, '-vf')).toContain('format=yuv420p10le');
  expect(valueOf(args, '-svtav1-params')).toContain('mastering-display=');
  // The SDR reference gets none, so there is nothing for it to be mapped by.
  expect(argsFor('sdr')).not.toContain('-svtav1-params');
});

test('the raw input is described exactly as LibRaw hands it over', () => {
  const args = argsFor('pq');
  // Native-order 16-bit RGB, so a byte swap would corrupt every sample.
  expect(valueOf(args, '-pixel_format')).toBe('rgb48le');
  expect(valueOf(args, '-video_size')).toBe('4024x6024');
  expect(valueOf(args, '-frames:v')).toBe('1');
});

test('an oversized frame is fitted to the long edge on both axes, evenly', () => {
  // A 60MP portrait frame: SVT-AV1 refuses this outright at native size.
  const portrait = fitted(6336, 9504, 3840);
  expect(portrait.height).toBe(3840);
  expect(portrait.width).toBe(2560);

  // yuv420 has no odd dimensions, so both edges have to land even whatever the
  // aspect ratio asks for.
  const awkward = fitted(4001, 6003, 1000);
  expect(awkward.width % 2).toBe(0);
  expect(awkward.height % 2).toBe(0);

  // Anything already within the limit is passed through untouched rather than
  // resampled for nothing.
  expect(fitted(3840, 2160, 3840)).toEqual({ width: 3840, height: 2160 });
  expect(fitted(800, 600, 3840)).toEqual({ width: 800, height: 600 });
});

test('the resize happens in linear light, before the transfer is applied', () => {
  // Resampling PQ code values averages a non-linear encoding and darkens the
  // result, so the scale has to be part of the same zscale call.
  const args = ffmpegArgs({ width: 6336, height: 9504 }, { ...OPTIONS, variant: 'pq', maxEdge: 3840 });
  const chain = valueOf(args, '-vf') ?? '';
  expect(chain).toContain('w=2560:h=3840');
  expect(chain).toContain('tin=linear');
});

test('a still is converted by ffmpeg but tagged by avifenc', () => {
  // ffmpeg's avif muxer writes no colr box, so ffmpeg only produces the pixels
  // and must not be asked to encode AV1 here.
  const args = ffmpegArgs(IMAGE, { ...OPTIONS, medium: 'still', variant: 'pq', outputPath: '/tmp/out.y4m' });
  expect(valueOf(args, '-f')).toBe('rawvideo'); // the input format
  expect(args.slice(-3)).toEqual(['-f', 'yuv4mpegpipe', '/tmp/out.y4m']);
  expect(args).not.toContain('-c:v');
  expect(args).not.toContain('-bsf:v');

  // The colr box is the whole reason this detour exists: it is what Chrome
  // reads to decide a still is HDR.
  const avif = avifencArgs({ ...OPTIONS, medium: 'still', variant: 'pq', outputPath: '/tmp/out.avif' }, '/tmp/out.y4m');
  expect(valueOf(avif, '--cicp')).toBe('9/16/9');
  expect(valueOf(avif, '--depth')).toBe('10');
  expect(avif.slice(-2)).toEqual(['/tmp/out.y4m', '/tmp/out.avif']);
});

test('a still SDR reference is tagged sRGB, where the video one is BT.709', () => {
  // Same primaries, but BT.709's transfer is a camera OETF; a browser renders an
  // untagged still against sRGB, so that is what makes the control look normal.
  const still = avifencArgs({ ...OPTIONS, medium: 'still', variant: 'sdr' }, '/tmp/x.y4m');
  expect(valueOf(still, '--cicp')).toBe('1/13/1');
  expect(valueOf(argsFor('sdr'), '-color_trc')).toBe('bt709');

  // PQ is tagged identically in both media.
  expect(valueOf(avifencArgs({ ...OPTIONS, medium: 'still', variant: 'pq' }, '/tmp/x.y4m'), '--cicp')).toBe('9/16/9');
});

test('a still is 10-bit whatever the variant, so only the tagging differs', () => {
  // The video SDR reference stays 8-bit, which is what an SDR video is; a still
  // control has to differ from the HDR stills in transfer alone.
  for (const variant of HDR_VARIANTS) {
    const args = ffmpegArgs(IMAGE, { ...OPTIONS, medium: 'still', variant, outputPath: '/tmp/x.y4m' });
    expect(valueOf(args, '-vf')).toContain('format=yuv444p10le');
  }
  // The video is 4:2:0 on purpose, so it can hardware-decode; 8-bit for SDR.
  expect(valueOf(argsFor('sdr'), '-vf')).toContain('format=yuv420p');
  expect(valueOf(argsFor('pq'), '-vf')).toContain('format=yuv420p10le');
});

test('the still never subsamples chroma except the control that exists to', () => {
  // 4:2:0 quarters the colour samples, which is the wrong trade for a
  // photograph. avifenc takes the chroma from the y4m, so the conversion and the
  // flag have to agree or the flag is silently ignored - which is how the
  // subsampling went unnoticed. The video is the opposite case: there, 4:2:0 is
  // what makes it decodable at all.
  for (const variant of HDR_VARIANTS) {
    const chain = valueOf(ffmpegArgs(IMAGE, { ...OPTIONS, medium: 'still', variant }), '-vf') ?? '';
    expect(chain).toContain('format=yuv444p');
    expect(chain).not.toContain('420');
  }
  const avif = avifencArgs({ ...OPTIONS, medium: 'still', variant: 'pq' }, '/tmp/x.y4m');
  expect(valueOf(avif, '--yuv')).toBe('444');
  expect(valueOf(avif, '--jobs')).toBe('all');
});

test('the baseline control differs from the still in chroma and nothing else', () => {
  // Its whole purpose is to isolate one variable: if it renders on a device
  // where the 4:4:4 still does not, the decoder lacks AVIF Advanced profile
  // rather than lacking HDR.
  for (const variant of HDR_VARIANTS) {
    const control = ffmpegArgs(IMAGE, { ...OPTIONS, medium: 'still-baseline', variant });
    const still = ffmpegArgs(IMAGE, { ...OPTIONS, medium: 'still', variant });
    expect(valueOf(control, '-vf')).toContain('format=yuv420p10le');
    // Same transfer, same primaries, same everything else.
    expect(valueOf(control, '-vf')?.replace('420', '444')).toBe(valueOf(still, '-vf'));
  }
  const control = avifencArgs({ ...OPTIONS, medium: 'still-baseline', variant: 'pq' }, '/tmp/x.y4m');
  expect(valueOf(control, '--yuv')).toBe('420');
  expect(valueOf(control, '--cicp')).toBe('9/16/9');
});

test('each medium gets the extension its container needs', () => {
  expect(extensionFor('still')).toBe('.avif');
  expect(extensionFor('video')).toBe('.mp4');
});

test('the route parameters reject anything not in the sets', () => {
  for (const variant of HDR_VARIANTS) expect(isHdrVariant(variant)).toBe(true);
  for (const medium of HDR_MEDIA) expect(isHdrMedium(medium)).toBe(true);
  expect(isHdrVariant('hdr10')).toBe(false);
  expect(isHdrVariant('../../etc/passwd')).toBe(false);
  expect(isHdrMedium('image')).toBe(false);
  expect(isHdrMedium('..')).toBe(false);
});
