import { expect, test } from 'bun:test';
import { HDR_VARIANTS, ffmpegArgs, fitted, isHdrVariant } from '../hdr_video';

const IMAGE = { width: 4024, height: 6024 };
const OPTIONS = { outputPath: '/tmp/out.mp4', peakNits: 1000, crf: 20, preset: 8, maxEdge: 8192 };

function argsFor(variant: (typeof HDR_VARIANTS)[number]): string[] {
  return ffmpegArgs(IMAGE, { ...OPTIONS, variant });
}

function valueOf(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

test('the bitstream filter restates the colour signalling the encoder drops', () => {
  // SVT-AV1 writes "unknown" primaries and transfer however the -color_* options
  // are set, so these numbers are the only thing making the file HDR. AV1 spec
  // 6.4.2: 9 = BT.2020, 16 = SMPTE ST 2084, 18 = ARIB STD-B67.
  expect(valueOf(argsFor('pq'), '-bsf:v')).toBe(
    'av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9:color_range=tv',
  );
  expect(valueOf(argsFor('hlg'), '-bsf:v')).toContain('transfer_characteristics=18');
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

test('the peak is what ties linear 1.0 to a brightness, so it reaches both the transfer and the metadata', () => {
  const args = ffmpegArgs(IMAGE, { ...OPTIONS, variant: 'pq', peakNits: 4000 });
  expect(valueOf(args, '-vf')).toContain('npl=4000');
  expect(valueOf(args, '-svtav1-params')).toContain('L(4000,0.0001)');
  expect(valueOf(args, '-svtav1-params')).toContain('content-light=4000,2000');
});

test('the SDR reference carries no HDR metadata to tone-map against', () => {
  const args = argsFor('sdr');
  expect(args).not.toContain('-svtav1-params');
  expect(valueOf(args, '-vf')).not.toContain('npl=');
  expect(valueOf(args, '-color_trc')).toBe('bt709');
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

test('isHdrVariant rejects anything not in the set', () => {
  for (const variant of HDR_VARIANTS) expect(isHdrVariant(variant)).toBe(true);
  expect(isHdrVariant('hdr10')).toBe(false);
  expect(isHdrVariant('../../etc/passwd')).toBe(false);
});
