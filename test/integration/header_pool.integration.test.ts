// A header read on a worker thread has to answer exactly what one here does.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HeaderPool } from '../../src/services/processing/analysis/header_pool';
import { extractMetadata } from '../../src/services/processing/analysis/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const COPIES = 6;

let root: string;
let files: string[];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-header-'));
  files = Array.from({ length: COPIES }, (_, i) => path.join(root, `p${i}.arw`));
  for (const file of files) copyFileSync(FIXTURE, file);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('it reads the same headers the main thread does', async () => {
  const pool = new HeaderPool(() => 4);
  const onThreads = await Promise.all(files.map((file) => pool.read(file)));
  const here = await Promise.all(files.map((file) => extractMetadata(file)));
  expect(onThreads.every((metadata) => metadata.width > 0)).toBe(true);
  expect(onThreads).toEqual(here);
});

// The queue is empty between every pair of files read one after another, so this is the case
// that spawns a thread per photograph if the pool retires on an empty queue rather than on
// having been idle for a while.
test('one at a time reuses its thread rather than spawning one per file', async () => {
  let spawned = 0;
  const madeWorkers = globalThis.Worker;
  globalThis.Worker = class extends madeWorkers {
    constructor(...args: ConstructorParameters<typeof madeWorkers>) {
      spawned++;
      super(...args);
    }
  };
  try {
    const pool = new HeaderPool(() => 1);
    for (const file of files) await pool.read(file);
  } finally {
    globalThis.Worker = madeWorkers;
  }
  expect(spawned).toBe(1);
});
