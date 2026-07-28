// The RAW header reader walks LibRaw structs at hand-computed byte offsets, so a
// LibRaw upgrade that reorders a field degrades silently to plausible garbage.
// These are the known-correct values for the checked-in files (§11.1), one per
// format: an ARW, which is a TIFF, and a CR3, which is an ISO base-media file.
//   docker exec bowerbird-dev bun test test/integration
import { describe, expect, test } from 'bun:test';
import { decodeRaw, readRawHeader } from '../../src/services/processing/raw_decoder';
import { extractMetadata } from '../../src/services/processing/metadata';

const SONY = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const CANON = `${import.meta.dir}/../fixtures/IMG_5360.CR3`;

test('reads the camera body and lens off the RAW header', () => {
  const header = readRawHeader(SONY);
  expect(header.cameraMake).toBe('Sony');
  expect(header.cameraModel).toBe('ILCE-6300');
  expect(header.lensModel).toBe('FE 50mm F1.8');
});

test('reads the exposure settings off the RAW header', () => {
  const header = readRawHeader(SONY);
  expect(header.iso).toBe(640);
  expect(header.aperture).toBeCloseTo(1.8, 2);
  expect(header.focalLength).toBeCloseTo(50, 2);
  expect(header.shutterSpeed).toBeCloseTo(0.01, 4);
});

test('reads a Canon body, lens and exposure through the same reader', () => {
  const header = readRawHeader(CANON);
  expect(header.cameraMake).toBe('Canon');
  expect(header.cameraModel).toBe('EOS R8');
  expect(header.lensModel).toBe('TAMRON SP 70-200mm F/2.8 Di VC USD A009');
  expect(header.iso).toBe(125);
  expect(header.aperture).toBeCloseTo(2.8, 2);
  expect(header.focalLength).toBeCloseTo(70, 2);
  expect(header.shutterSpeed).toBeCloseTo(1 / 320, 4);
  expect(header.orientation).toBe(5); // shot portrait, so the flip path is live
});

test('reads the capture zone out of a CR3, whose EXIF is not at the front of a TIFF', async () => {
  // The tags live in a `CMT2` box under `moov`, not in a TIFF header. LibRaw
  // exposes no zone at all, so this is the whole of Canon's timezone support.
  const metadata = await extractMetadata(CANON);
  expect(metadata.dateTakenOffset).toBe('+11:00');
  expect(metadata.dateTaken).toBe('2024-06-07T13:38:25.000Z');
});

test('a body that records no fix reports no coordinates rather than Null Island', async () => {
  // Canon reports a parsed GPS block on every frame and zeroes it when there was
  // no fix, which read as 0,0 - a real place, in the Gulf of Guinea.
  const metadata = await extractMetadata(CANON);
  expect(metadata.latitude).toBeNull();
  expect(metadata.longitude).toBeNull();
});

// Pinned, because the failure this guards is a plausible-looking number: the EOS
// R8 decoded to 3879x5811, a 3% tight and off-centre crop of the picture the
// camera took, from applying a crop LibRaw had already applied.
describe.each([
  ['ARW', SONY, 4024, 6024],
  ['CR3', CANON, 3999, 5999],
])('%s', (_format, fixture, width, height) => {
  test('decodes the frame the camera says it took', () => {
    const image = decodeRaw(fixture);
    expect([image.width, image.height]).toEqual([width, height]);
  });

  // Bodies that state a visible frame inside the raw frame (the ILCE-7CR does) get
  // cropped to it, or the masked border decodes as black bars down two edges. The
  // stored dimensions have to describe the same picture the thumbnail shows, so
  // these two must never disagree -- that is what breaks first if the crop is
  // applied in one path and not the other.
  test('the recorded dimensions are the dimensions that get decoded', () => {
    const header = readRawHeader(fixture);
    const image = decodeRaw(fixture);
    expect(image.width).toBe(header.width);
    expect(image.height).toBe(header.height);
  });

  test('the decoded image has no black border on any edge', () => {
    const image = decodeRaw(fixture);
    const lit = (x: number, y: number): boolean => {
      const i = (y * image.width + x) * 3;
      return image.data[i]! + image.data[i + 1]! + image.data[i + 2]! > 24;
    };
    const midX = image.width >> 1;
    const midY = image.height >> 1;
    expect(lit(0, midY)).toBe(true);
    expect(lit(image.width - 1, midY)).toBe(true);
    expect(lit(midX, 0)).toBe(true);
    expect(lit(midX, image.height - 1)).toBe(true);
  });
});

test('a fixed-lens body reports no lens rather than a placeholder', () => {
  // LibRaw leaves Lens as "" or "---" when nothing was recorded. Either must read
  // as unknown, not as a lens literally named "---".
  const header = readRawHeader(SONY);
  expect(header.lensModel).not.toBe('---');
  expect(header.lensModel).not.toBe('');
});
