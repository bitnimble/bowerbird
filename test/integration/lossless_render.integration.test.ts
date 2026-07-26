// The lossless export is a second decode path: 16-bit output, its own colour
// space call, and a sharp pipeline that silently downconverts unless told not
// to. All of that is invisible until someone opens the file (§10.5).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { decodeRaw } from '../../src/services/processing/raw_decoder';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

test('a 16-bit decode yields twice the bytes of an 8-bit one', () => {
  const eight = decodeRaw(FIXTURE, 8);
  const sixteen = decodeRaw(FIXTURE, 16);

  expect(eight.depth).toBe(8);
  expect(sixteen.depth).toBe(16);
  // Same picture, same crop: only the sample size differs.
  expect(sixteen.width).toBe(eight.width);
  expect(sixteen.height).toBe(eight.height);
  expect(sixteen.data.length).toBe(eight.data.length * 2);
});

test('the 16-bit decode survives the PNG encode at full depth', async () => {
  const image = decodeRaw(FIXTURE, 16);
  const png = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: image.channels, depth: 'ushort' },
  } as sharp.SharpOptions)
    .toColourspace('rgb16')
    .png({ compressionLevel: 1, effort: 1 })
    .toBuffer();

  // Read the IHDR directly: sharp's own metadata has reported `uchar` for a file
  // that really was 16-bit, so the bytes are the only trustworthy answer.
  expect(png[24]).toBe(16); // bit depth
  expect(png[25]).toBe(2); // colour type 2 = truecolour RGB

  const meta = await sharp(png).metadata();
  expect(meta.width).toBe(image.width);
  expect(meta.height).toBe(image.height);
});
