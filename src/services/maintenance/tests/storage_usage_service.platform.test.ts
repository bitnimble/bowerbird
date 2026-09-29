import { expect, test } from 'bun:test';
import { chmodSync, linkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { StorageUsageService } from '../storage_usage_service';
import { put, root, service, usingStorageRoot } from './storage_usage_test_helpers';

usingStorageRoot();

test('counts overlapping roots and hardlinked files once', async () => {
  const dataDir = path.join(root, 'data');
  const dbPath = put('data/catalogue.db', 10);
  put('data/backups/snapshot.db', 20);
  const rendition = put('data/library/renditions/photo.avif', 30);
  const duplicate = path.join(root, 'data/duplicate.avif');
  linkSync(rendition, duplicate);
  const usage = new StorageUsageService({ dataDir, dbPath, cachePaths: [dataDir, rendition, duplicate] });

  expect(await usage.measure()).toEqual({ bytes: 60 });
});

test.skipIf(process.platform === 'win32')('resolves managed roots and catalogue links, skips nested links into originals', async () => {
  const data = put('generated/renditions/photo.avif', 10);
  symlinkSync(path.dirname(path.dirname(data)), path.join(root, 'data'), 'dir');
  const original = put('originals/photo.ARW', 10_000);
  symlinkSync(path.dirname(original), path.join(root, 'generated/originals'), 'dir');
  symlinkSync(original, path.join(root, 'generated/photo.ARW'));
  const catalogue = put('volume/catalogue.db', 20);
  symlinkSync(catalogue, path.join(root, 'catalogue.db'));
  put('volume/catalogue.db-wal', 30);
  put('volume/catalogue.db.pre-restore-123', 40);
  put('backups/catalogue.db-2026-09-01T00-00-00-000Z.db', 50);
  put('volume/backups/catalogue.db-2026-09-02T00-00-00-000Z.db', 60);
  put('printer-profiles/paper.icc', 70);

  expect(await service().measure()).toEqual({ bytes: 280 });
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails visibly when a data directory cannot be read', async () => {
  put('data/private/photo.avif', 10);
  const directory = path.join(root, 'data/private');
  chmodSync(directory, 0);
  try {
    await expect(service().measure()).rejects.toMatchObject({ code: 'EACCES' });
  } finally {
    chmodSync(directory, 0o700);
  }
});
