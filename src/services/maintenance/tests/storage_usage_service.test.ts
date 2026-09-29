import { expect, test } from 'bun:test';
import path from 'node:path';
import { StorageUsageService } from '../storage_usage_service';
import { put, root, service, usingStorageRoot } from './storage_usage_test_helpers';

usingStorageRoot();

test('counts persistent generated files, catalogue, backups, and caches without originals or staged updates', async () => {
  put('data/library/renditions/full-hdr/photo.avif', 10);
  put('data/library/analysis/photo.bba', 20);
  put('data/library/drafts/layers/seams.bin', 30);
  const cache = put('quality-cache/photo.avif', 40);
  put('catalogue.db', 50);
  put('catalogue.db-wal', 60);
  put('catalogue.db-shm', 70);
  put('catalogue.db-journal', 80);
  put('backups/catalogue.db-2026-09-01T00-00-00-000Z.db', 90);
  put('printer-profiles/paper.icc', 100);
  put('catalogue.db.pre-restore-123', 110);
  put('catalogue.db.pre-restore-123-wal', 120);
  const reference = put('reference_frame.ARW', 130);
  put('originals/photo.ARW', 10_000);
  put('originals/Bin/photo.ARW', 10_000);
  put('updates/staged/payload', 10_000);
  put('exports/photo.avif', 10_000);
  put('catalogue.db.restoring-123', 10_000);
  put('other.db.pre-restore-123', 10_000);
  put('backups/originals/photo.ARW', 10_000);
  put('backups/.catalogue.db-2026-09-01T00-00-00-000Z-1.part', 10_000);
  put('backups/other.db-2026-09-01T00-00-00-000Z.db', 10_000);
  put('backups/catalogue.db-2026-09-02T00-00-00-000Z.db/photo.ARW', 10_000);
  put('printer-profiles/originals/photo.ARW', 10_000);

  expect(await service([path.dirname(cache), reference]).measure()).toEqual({ bytes: 910 });
});

test('missing optional data and catalogue paths contribute zero', async () => {
  expect(await service([path.join(root, 'missing-cache')]).measure()).toEqual({ bytes: 0 });
});

test('counts retained data without render, fetch, scan, or assembly staging files', async () => {
  put('data/library/renditions/full-hdr/photo.avif', 10);
  put('data/library/analysis/photo.bba', 20);
  put('data/library/drafts/layers/seams.bin', 30);
  put('data/library/renditions/full-hdr/photo.avif.abcdefgh.tmp', 10_000);
  put('data/library/renditions/full-hdr/photo.avif.abcdefgh.fetching', 10_000);
  put('data/library/renditions/grid/photo.avif.descriptor', 10_000);
  put('data/library/drafts/.volume-abcdefgh.bin', 10_000);
  put('data/library/renditions/full-hdr/photo.avif.abcdefghijklmnop.tmp', 10_000);

  expect(await service().measure()).toEqual({ bytes: 60 });
});

test('excludes catalogue staging when the database lives inside generated data', async () => {
  const dataDir = path.join(root, 'data');
  const dbPath = put('data/catalogue.db', 10);
  put('data/backups/catalogue.db-2026-09-01T00-00-00-000Z.db', 20);
  put('data/backups/.catalogue.db-2026-09-01T00-00-00-000Z-1.part', 10_000);
  put('data/catalogue.db.restoring-2026-09-01T00-00-00-000Z', 10_000);

  expect(await new StorageUsageService({ dataDir, dbPath }).measure()).toEqual({ bytes: 30 });
});

test.each(['updates', ''])('excludes staged updates inside DATA_DIR/%s without excluding persistent data', async (directory) => {
  const dataDir = path.join(root, 'data');
  const dbPath = put('data/catalogue.db', 10);
  put('data/library/renditions/full-hdr/photo.avif', 20);
  put(path.join('data', directory, 'download/payload.tar'), 10_000);
  put(path.join('data', directory, 'staged/bowerbird'), 10_000);
  put(path.join('data', directory, 'staged.version'), 10_000);
  const updatesDir = path.join(dataDir, directory);

  expect(await new StorageUsageService({ dataDir, dbPath, updatesDir }).measure()).toEqual({ bytes: 30 });
});
