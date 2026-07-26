// The lossless export is a second decode path: 16-bit output, its own colour
// space call, and a sharp pipeline that silently downconverts unless told not
// to. All of that is invisible until someone opens the file (§10.5).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ProcessingService } from '../../src/services/processing/processing_service';
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
  const samples = new Uint16Array(image.data.buffer, image.data.byteOffset, image.width * image.height * image.channels);
  const png = await sharp(samples, { raw: { width: image.width, height: image.height, channels: image.channels } })
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

// Goes through the real worker, not a copy of its logic. The bug this pins wrote
// a file of exactly the right dimensions and bit depth whose pixels were the
// 16-bit buffer misread as 8-bit samples, so only the shipped path, compared
// pixel by pixel, catches it.
test('the render the service produces is the image that was decoded', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-lossless-'));
  const output = path.join(dir, 'out.png');
  try {
    const service = new ProcessingService(
      {} as never,
      { processingConcurrency: 1 } as never,
      { getThumbnailSource: () => 'render' } as never,
    );
    await service.renderLossless(FIXTURE, output, 'test-photo');

    const image = decodeRaw(FIXTURE, 16);
    const samples = new Uint16Array(image.data.buffer, image.data.byteOffset, image.width * image.height * image.channels);
    const expected = await sharp(samples, { raw: { width: image.width, height: image.height, channels: image.channels } })
      .raw()
      .toBuffer();
    const actual = await sharp(output).raw().toBuffer();

    expect(Buffer.compare(expected, actual)).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// sharp infers sample depth from the typed array's type. Passing a Buffer with
// `raw.depth: 'ushort'` is accepted and then ignored, which is exactly how the
// render came to be silently wrong.
test('a Buffer with raw.depth is NOT read as 16-bit, which is why a typed array is used', async () => {
  const px = new Uint16Array([65535, 0, 0, 0, 65535, 0, 0, 0, 65535, 32768, 32768, 32768]);
  const raw = { raw: { width: 2, height: 2, channels: 3 } };

  const viaTypedArray = await sharp(px, raw).metadata();
  expect(viaTypedArray.depth).toBe('ushort');

  const viaBuffer = await sharp(Buffer.from(px.buffer), { raw: { ...raw.raw, depth: 'ushort' } } as sharp.SharpOptions).metadata();
  expect(viaBuffer.depth).toBe('uchar');
});
