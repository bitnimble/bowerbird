// Drives the real processing worker, because the module tests prove the transform
// is right without proving anything actually calls it. A flag that never reaches
// the worker leaves the feature permanently off however the server is configured.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _for_testing_deltaEToPreview } from '../../src/services/processing/rawshim_for_testing';
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

async function render(
  matchEmbeddedJpeg: boolean,
  name: string,
  render: { denoise: number; sharpen: number } = { denoise: 0, sharpen: 0 },
): Promise<string> {
  const outputPath = path.join(root, `${name}.avif`);
  const result = await runJob({
    kind: 'rendition',
    photoId: name,
    rawFilePath: FIXTURE,
    dataPath: root,
    targets: [target(outputPath)],
    grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.9 },
    matchEmbeddedJpeg,
    ...render,
  });
  expect(result.success).toBe(true);
  return outputPath;
}

test(
  'the worker applies the match when the job asks for it, and not otherwise',
  async () => {
    const [plain, matched] = await Promise.all([render(false, 'plain'), render(true, 'matched')]);

    // The camera's own JPEG is what both are trying to look like, so the test is
    // not "the bytes changed" but "the render moved towards the target". Which of
    // two files landed closer is a pair of scalars, so it is measured where the
    // three images already are rather than by reading them all back.
    //
    // Sampled on a normalised grid rather than by buffer index, because the three
    // are not the same shape: the JPEG is distortion-cropped, so at an 800px long
    // edge it comes out 534 wide against the render's 535, and walking a shared
    // index would slide a pixel per row and compare different parts of the scene.
    const { meanDeltaE, counted, sizes } = _for_testing_deltaEToPreview([plain, matched], FIXTURE);
    expect(sizes[0]).toEqual(sizes[1]!);
    expect(counted).toBeGreaterThan(100);
    // A flag that never reaches the worker makes these two equal, which is exactly
    // the failure this test exists to catch: every module test would still pass.
    expect(meanDeltaE[1]!).toBeLessThan(meanDeltaE[0]!);
  },
  TIMEOUT,
);

test(
  'the worker applies the denoise and the sharpen the job asks for',
  async () => {
    // Same shape of test as the match above, and for the same reason. Both settings
    // reach the worker through a `...this.render()` spread in `processing_service`,
    // which is the pattern that dropped `matchEmbeddedJpeg` in silence once before -
    // TypeScript does not excess-check a spread, so a renamed or unread settings key
    // leaves the whole stage permanently off with every module test still green.
    //
    // The assertion is only that the pixels moved. What the filters do to them is
    // measured in `image.rs` against constructed inputs, where it can be measured
    // properly; what cannot be checked there is whether anything calls them.
    const [plain, processed] = await Promise.all([
      render(false, 'unprocessed'),
      render(false, 'processed', { denoise: 1, sharpen: 0.6 }),
    ]);

    expect(readFileSync(processed).equals(readFileSync(plain))).toBe(false);
  },
  TIMEOUT,
);
