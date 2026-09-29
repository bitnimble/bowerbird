import { afterEach, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StorageUsageService } from '../storage_usage_service';

export let root: string;

export function usingStorageRoot(): void {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bowerbird-storage-test-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));
}

export function put(relative: string, bytes: number): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes));
  return file;
}

export function service(cachePaths: readonly string[] = []): StorageUsageService {
  return new StorageUsageService({
    dataDir: path.join(root, 'data'),
    dbPath: path.join(root, 'catalogue.db'),
    cachePaths,
  });
}
