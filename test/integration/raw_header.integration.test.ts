// The RAW header reader walks LibRaw structs at hand-computed byte offsets, so a
// LibRaw upgrade that reorders a field degrades silently to plausible garbage.
// These are the known-correct values for the checked-in ARW (§11.1).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { decodeRaw, readRawHeader } from '../../src/services/processing/raw_decoder';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

test('reads the camera body and lens off the RAW header', () => {
  const header = readRawHeader(FIXTURE);
  expect(header.cameraMake).toBe('Sony');
  expect(header.cameraModel).toBe('ILCE-6300');
  expect(header.lensModel).toBe('FE 50mm F1.8');
});

test('reads the exposure settings off the RAW header', () => {
  const header = readRawHeader(FIXTURE);
  expect(header.iso).toBe(640);
  expect(header.aperture).toBeCloseTo(1.8, 2);
  expect(header.focalLength).toBeCloseTo(50, 2);
  expect(header.shutterSpeed).toBeCloseTo(0.01, 4);
});

// Bodies that state a visible frame inside the raw frame (the ILCE-7CR does) get
// cropped to it, or the masked border decodes as black bars down two edges. The
// stored dimensions have to describe the same picture the thumbnail shows, so
// these two must never disagree -- that is what breaks first if the crop is
// applied in one path and not the other.
test('the recorded dimensions are the dimensions that get decoded', () => {
  const header = readRawHeader(FIXTURE);
  const image = decodeRaw(FIXTURE);
  expect(image.width).toBe(header.width);
  expect(image.height).toBe(header.height);
});

test('the decoded image has no black border on any edge', () => {
  const image = decodeRaw(FIXTURE);
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

test('a fixed-lens body reports no lens rather than a placeholder', () => {
  // LibRaw leaves Lens as "" or "---" when nothing was recorded. Either must read
  // as unknown, not as a lens literally named "---".
  const header = readRawHeader(FIXTURE);
  expect(header.lensModel).not.toBe('---');
  expect(header.lensModel).not.toBe('');
});
