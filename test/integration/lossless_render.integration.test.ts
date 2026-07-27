// The full-resolution export is a second decode path (16-bit, its own colour
// space call) feeding an encoder that lives outside sharp entirely. None of that
// is visible until someone opens the file (§10.5).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ProcessingService } from '../../src/services/processing/processing_service';
import { decodeRaw } from '../../src/services/processing/raw_decoder';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

// P6 header, then big-endian 16-bit samples: the same shape the worker writes.
function ppmOf(image: ReturnType<typeof decodeRaw>): Buffer {
  const body = Buffer.from(image.data);
  body.swap16();
  return Buffer.concat([Buffer.from(`P6\n${image.width} ${image.height}\n65535\n`, 'ascii'), body]);
}

// Skips the magic plus the three whitespace-delimited header fields.
function samplesOf(buf: Buffer): Buffer {
  let offset = 2;
  let fields = 0;
  const isSpace = (i: number): boolean => /\s/.test(String.fromCharCode(buf[i]!));
  while (fields < 3) {
    while (offset < buf.length && isSpace(offset)) offset++;
    while (offset < buf.length && !isSpace(offset)) offset++;
    fields++;
  }
  return buf.subarray(offset + 1);
}

function service(): ProcessingService {
  return new ProcessingService({} as never, { processingConcurrency: 1, losslessDistance: 0.3, losslessEffort: 4 } as never, {
    getThumbnailSource: () => "render",
  } as never);
}

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

// Goes through the real worker, not a copy of its logic: the previous bug here
// wrote a file of exactly the right dimensions whose pixels were the 16-bit
// buffer misread as 8-bit, which only the shipped path can catch.
test('the render the service produces decodes back to the image that went in', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-lossless-'));
  const output = path.join(dir, 'out.jxl');
  try {
    await service().renderLossless(FIXTURE, output, 'test-photo');

    // A JXL, not a PNG: the first two bytes of a bare codestream are ff 0a, and
    // a container-wrapped one starts with a JXL box signature.
    const head = Buffer.from(await Bun.file(output).arrayBuffer().then((b) => b.slice(0, 12)));
    const bare = head[0] === 0xff && head[1] === 0x0a;
    const boxed = head.subarray(4, 8).toString('ascii') === 'JXL ';
    expect(bare || boxed).toBe(true);

    // Far smaller than the 16-bit PNG it replaces, which is the whole point.
    const image = decodeRaw(FIXTURE, 16);
    expect(statSync(output).size).toBeLessThan(image.data.length / 4);

    // Decode back to PPM, not PNG. djxl tags its PNG with an ICC profile and
    // sharp then colour-manages it, which shifts every value and reads as ~30 dB
    // of codec loss that isn't there. PPM carries no profile, so this compares
    // the pixels themselves.
    const roundTrip = path.join(dir, 'back.ppm');
    expect(Bun.spawnSync(['djxl', output, roundTrip]).exitCode).toBe(0);

    const expected = samplesOf(ppmOf(image));
    const actual = samplesOf(readFileSync(roundTrip));
    expect(actual.length).toBe(expected.length);

    let sum = 0;
    const n = expected.length / 2;
    for (let i = 0; i < n; i++) {
      const a = (expected[i * 2]! << 8) | expected[i * 2 + 1]!;
      const b = (actual[i * 2]! << 8) | actual[i * 2 + 1]!;
      sum += (a - b) ** 2;
    }
    // Sensor noise is what a lossy encoder discards first, so PSNR runs low on
    // RAW-derived pixels even when the result is perceptually identical. The
    // bound is set to catch a wrong-pixels bug, which lands far below this.
    const psnr = 10 * Math.log10(65535 ** 2 / (sum / n));
    expect(psnr).toBeGreaterThan(30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

// sharp infers sample depth from the typed array's type. Passing a Buffer with
// `raw.depth: 'ushort'` is accepted and then ignored, which is exactly how the
// render came to be silently wrong once already.
test('a Buffer with raw.depth is NOT read as 16-bit, which is why a typed array is used', async () => {
  const px = new Uint16Array([65535, 0, 0, 0, 65535, 0, 0, 0, 65535, 32768, 32768, 32768]);
  const raw = { raw: { width: 2, height: 2, channels: 3 } };

  const viaTypedArray = await sharp(px, raw).metadata();
  expect(viaTypedArray.depth).toBe('ushort');

  const viaBuffer = await sharp(Buffer.from(px.buffer), { raw: { ...raw.raw, depth: 'ushort' } } as sharp.SharpOptions).metadata();
  expect(viaBuffer.depth).toBe('uchar');
});
