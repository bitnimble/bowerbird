// The catalogue is built from these fields, and a reader that returns plausible garbage for one
// of them is a library full of photographs dated wrong or attributed to the wrong lens. These are
// the known-correct values for the checked-in files (§11.1), one per format: an ARW, which is a
// TIFF, and a CR3, which is an ISO base-media file.
//
// CR2 is scanned and imported (§7) but deliberately not pinned here. A fixture is
// a photograph committed to the repository for good, and the only CR2s to hand are
// portraits of people who did not agree to that. It shares every path this covers
// except the container - it is a TIFF, like the ARW - so what it would add is a
// second proof that Canon is read.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { readRawHeader } from '../../src/services/processing/raw_decoder';
import { extractMetadata } from '../../src/services/processing/metadata';

const SONY = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const CANON = `${import.meta.dir}/../fixtures/IMG_5360.CR3`;

// **The lens names are the decoder's resolved ones, not the EXIF strings.** rawler matches what
// the body wrote against its own lens database and hands back that entry's name, so the Sony
// carries its maker and the Tamron is spelled the way the database spells it rather than the way
// Tamron shouted it into the file. LibRaw passed the EXIF string through, which is why these two
// moved. The resolved name is what the catalogue stores and what the lens correction looks up, so
// it is the one worth pinning.
test('reads the camera body and lens off the RAW header', () => {
  const header = readRawHeader(SONY);
  expect(header.cameraMake).toBe('Sony');
  expect(header.cameraModel).toBe('ILCE-6300');
  expect(header.lensModel).toBe('Sony FE 50mm F1.8');
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
  expect(header.lensModel).toBe('Tamron SP 70-200mm f/2.8 Di VC USD');
  expect(header.iso).toBe(125);
  expect(header.aperture).toBeCloseTo(2.8, 2);
  expect(header.focalLength).toBeCloseTo(70, 2);
  expect(header.shutterSpeed).toBeCloseTo(1 / 320, 4);
  expect(header.orientation).toBe(8); // shot portrait, so the rotation path is live
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

// The decode-geometry pins that used to sit here - the frame size the camera says
// it took, the recorded dimensions matching the decoded ones, and the masked border
// - moved to `native/rawshim/src/fixture_tests.rs`. None of them involved TypeScript:
// they are this crate checking its own crop against a real file, and driving that
// over FFI bought nothing but a JSON encoding of the answer. `bun run test:native:full`
// runs them.

test('a fixed-lens body reports no lens rather than a placeholder', () => {
  // LibRaw leaves Lens as "" or "---" when nothing was recorded. Either must read
  // as unknown, not as a lens literally named "---".
  const header = readRawHeader(SONY);
  expect(header.lensModel).not.toBe('---');
  expect(header.lensModel).not.toBe('');
});
