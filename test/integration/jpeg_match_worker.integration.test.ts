// Drives the real processing worker, because the module tests prove the transform
// is right without proving anything actually calls it. A flag that never reaches
// the worker leaves the feature permanently off however the server is configured.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deltaE76 } from '../../src/services/processing/jpeg_match_test_only';
import { readEmbeddedJpeg } from '../../src/services/processing/raw_decoder';
import { decodeImage, freeImage, type ImageHandle } from '../../src/services/processing/rawshim_ops';
import { pixels } from '../../src/services/processing/rawshim_pixels';
import type { ProcessingResult, RenditionJob, RenditionTarget } from '../../src/services/processing/processing_types';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const WORKER = `${import.meta.dir}/../../src/services/processing/processing_worker.ts`;
const TIMEOUT = 180_000;

const root = mkdtempSync(path.join(tmpdir(), 'bb-match-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function target(outputPath: string): RenditionTarget {
  return {
    rendition: 'grid',
    hdr: false,
    outputPath,
    videoOutputPath: null,
    size: 800,
    source: 'render',
    sdrQuantizer: 26,
    hdrQuantizer: 8,
    preset: 8,
    stillFullChroma: false,
    sdrFullChroma: false,
  };
}

/** Runs one job through a real worker thread and resolves with its reply. */
function runJob(job: RenditionJob): Promise<ProcessingResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('worker did not reply'));
    }, TIMEOUT - 10_000);
    worker.onmessage = (event: MessageEvent<ProcessingResult>) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(job);
  });
}

/** The handle's pixels, with the handle released. */
function take(image: ImageHandle): { width: number; height: number; data: Buffer } {
  try {
    return { width: image.width, height: image.height, data: pixels(image) };
  } finally {
    freeImage(image);
  }
}

async function readImage(file: string, longEdge = 0): Promise<ReturnType<typeof take>> {
  return take(decodeImage(Buffer.from(await Bun.file(file).arrayBuffer()), longEdge));
}

/** The pixel at a fractional position, so images of different shapes compare. */
function at(image: ReturnType<typeof take>, u: number, v: number): [number, number, number] {
  const x = Math.min(image.width - 1, Math.floor(u * image.width));
  const y = Math.min(image.height - 1, Math.floor(v * image.height));
  const i = (y * image.width + x) * 3;
  return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
}

async function render(matchEmbeddedJpeg: boolean, name: string): Promise<ReturnType<typeof take>> {
  const outputPath = path.join(root, `${name}.avif`);
  const result = await runJob({
    kind: 'rendition',
    photoId: name,
    rawFilePath: FIXTURE,
    dataPath: root,
    targets: [target(outputPath)],
    grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.9 },
    matchEmbeddedJpeg,
  });
  expect(result.success).toBe(true);
  return readImage(outputPath);
}

test(
  'the worker applies the match when the job asks for it, and not otherwise',
  async () => {
    const [plain, matched] = await Promise.all([render(false, 'plain'), render(true, 'matched')]);
    expect(matched.data.length).toBe(plain.data.length);

    // The camera's own JPEG is what both are trying to look like, so the test is
    // not "the bytes changed" but "the render moved towards the target".
    const jpeg = readEmbeddedJpeg(FIXTURE)!;
    const reference = take(decodeImage(jpeg, Math.max(plain.width, plain.height)));

    // Sampled on a normalised grid rather than by buffer index, because the three
    // images are not the same shape: the JPEG is distortion-cropped, so at an 800px
    // long edge it comes out 534 wide against the render's 535, and walking a shared
    // index would slide a pixel per row and compare different parts of the scene.
    let plainError = 0;
    let matchedError = 0;
    let counted = 0;
    for (let step = 0; step < 4000; step += 1) {
      const u = (step % 61) / 61;
      const v = (step / 4000) % 1;
      const target = at(reference, u, v);
      plainError += deltaE76(at(plain, u, v), target);
      matchedError += deltaE76(at(matched, u, v), target);
      counted += 1;
    }
    expect(counted).toBeGreaterThan(100);
    // A flag that never reaches the worker makes these two equal, which is exactly
    // the failure this test exists to catch: every module test would still pass.
    expect(matchedError / counted).toBeLessThan(plainError / counted);
  },
  TIMEOUT,
);
