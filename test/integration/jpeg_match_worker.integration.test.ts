// Drives the real processing worker, because the module tests prove the transform
// is right without proving anything actually calls it. A flag that never reaches
// the worker leaves the feature permanently off however the server is configured.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { deltaE76 } from '../../src/services/processing/jpeg_match';
import { readEmbeddedJpeg } from '../../src/services/processing/raw_decoder';
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
    quality: 80,
    quantizer: 8,
    effort: 0,
    preset: 8,
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

async function render(matchEmbeddedJpeg: boolean, name: string): Promise<Buffer> {
  const outputPath = path.join(root, `${name}.avif`);
  const result = await runJob({
    kind: 'rendition',
    photoId: name,
    rawFilePath: FIXTURE,
    dataPath: root,
    targets: [target(outputPath)],
    grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.9 },
    reportSource: true,
    matchEmbeddedJpeg,
  });
  expect(result.success).toBe(true);
  return sharp(outputPath).removeAlpha().raw().toBuffer();
}

test(
  'the worker applies the match when the job asks for it, and not otherwise',
  async () => {
    const [plain, matched] = await Promise.all([render(false, 'plain'), render(true, 'matched')]);
    expect(matched.length).toBe(plain.length);

    // The camera's own JPEG is what both are trying to look like, so the test is
    // not "the bytes changed" but "the render moved towards the target".
    const jpeg = readEmbeddedJpeg(FIXTURE)!;
    const { width, height } = await sharp(path.join(root, 'plain.avif')).metadata();
    const reference = await sharp(jpeg).rotate().resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();

    let plainError = 0;
    let matchedError = 0;
    let counted = 0;
    for (let i = 0; i + 2 < plain.length; i += 3 * 11) {
      const target = [reference[i]!, reference[i + 1]!, reference[i + 2]!];
      plainError += deltaE76([plain[i]!, plain[i + 1]!, plain[i + 2]!], target);
      matchedError += deltaE76([matched[i]!, matched[i + 1]!, matched[i + 2]!], target);
      counted += 1;
    }
    expect(counted).toBeGreaterThan(100);
    // A flag that never reaches the worker makes these two equal, which is exactly
    // the failure this test exists to catch: every module test would still pass.
    expect(matchedError / counted).toBeLessThan(plainError / counted);
  },
  TIMEOUT,
);
