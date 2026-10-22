import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../../config';
import {
  LIB,
  makeLibrary,
  put,
  roots,
  type Peer,
} from '../../sync/scan/tests/scan_service_test_helpers';
import { LibrariesRepository } from '../libraries_repository';
import { LibrariesService } from '../libraries_service';
import { UNRESTRICTED_WRITES } from '../write_grants';

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function serviceFor(peer: Peer): { service: LibrariesService; repo: LibrariesRepository } {
  const repo = new LibrariesRepository(peer.db);
  const service = new LibrariesService(repo, peer.photoScan, peer.photoPaths, UNRESTRICTED_WRITES);
  service.addLifecycleListener(peer.scan);
  return { service, repo };
}

function photos(peer: Peer): { id: string; path: string; is_missing: number }[] {
  return peer.db
    .query(
      "SELECT id, json_extract(recipe, '$.path') AS path, is_missing FROM photos ORDER BY path",
    )
    .all() as { id: string; path: string; is_missing: number }[];
}

function nextScan(peer: Peer): Promise<void> {
  return new Promise((resolve) => peer.scan.onScanned(() => resolve()));
}

describe('changing a library root', () => {
  it('finds the photos of a folder already moved there, under their own ids', async () => {
    const peer = makeLibrary();
    const { service, repo } = serviceFor(peer);
    put(peer, 'a.arw', 'A');
    put(peer, 'Trip/b.arw', 'B');
    await peer.scan.scanLibrary(LIB);
    const before = photos(peer);
    expect(before.map((p) => [p.path, p.is_missing])).toEqual([
      ['Trip/b.arw', 0],
      ['a.arw', 0],
    ]);

    const moved = `${peer.root}-moved`;
    renameSync(peer.root, moved);
    await peer.scan.scanLibrary(LIB);
    expect(photos(peer).map((p) => p.is_missing)).toEqual([1, 1]);

    const scanned = nextScan(peer);
    await service.update(LIB, { root_path: moved });
    await scanned;

    expect(repo.getById(LIB)?.root_path).toBe(moved);
    expect(photos(peer)).toEqual(before);
  });

  it('accepts a folder that is not there yet, and finds the photos once they arrive', async () => {
    const peer = makeLibrary();
    const { service, repo } = serviceFor(peer);
    put(peer, 'a.arw', 'A');
    await peer.scan.scanLibrary(LIB);
    const before = photos(peer);

    const target = `${peer.root}-later`;
    const scanned = nextScan(peer);
    await service.update(LIB, { root_path: target });
    await scanned;
    expect(repo.getById(LIB)?.root_path).toBe(target);
    expect(photos(peer).map((p) => p.is_missing)).toEqual([1]);

    renameSync(peer.root, target);
    await peer.scan.scanLibrary(LIB);
    expect(photos(peer)).toEqual(before);
  });

  it('records the bin it finds at the new root', async () => {
    const peer = makeLibrary();
    const { service, repo } = serviceFor(peer);
    const target = `${peer.root}-other`;
    mkdirSync(path.join(target, 'Bin'), { recursive: true });

    const scanned = nextScan(peer);
    await service.update(LIB, { root_path: target });
    await scanned;

    const bin = statSync(path.join(target, 'Bin'));
    expect(repo.getBinIdentity(LIB)).toMatchObject({ dev: bin.dev, ino: bin.ino });
  });

  it('keeps an empty shoot when pointed at a folder its files have not reached yet', async () => {
    const peer = makeLibrary();
    const { service } = serviceFor(peer);
    const empty = path.join(peer.root, 'Empty');
    mkdirSync(empty);
    const folder = statSync(empty);
    peer.shoots.insert({
      id: 'shoot0001',
      parent_id: null,
      library_id: LIB,
      folder_path: 'Empty',
      name: 'Empty',
      description: null,
      ordering: 'taken_asc',
      folder_dev: folder.dev,
      folder_ino: folder.ino,
      folder_birthtime: folder.birthtimeMs,
    });
    const target = `${peer.root}-later`;
    mkdirSync(target);

    const scanned = nextScan(peer);
    await service.update(LIB, { root_path: target });
    await scanned;

    expect(peer.shoots.getById('shoot0001')?.name).toBe('Empty');
  });

  it('forgets the old bin when the new root has none yet', async () => {
    const peer = makeLibrary();
    const { service, repo } = serviceFor(peer);
    repo.setBinIdentity(LIB, { dev: 1, ino: 2, birthtime: 3 });

    const scanned = nextScan(peer);
    await service.update(LIB, { root_path: `${peer.root}-later` });
    await scanned;

    expect(repo.getBinIdentity(LIB)).toEqual({ dev: null, ino: null, birthtime: null });
  });

  it('keeps the new root, and scans it, when a later part of the request is refused', async () => {
    const peer = makeLibrary();
    const { service, repo } = serviceFor(peer);
    const target = `${peer.root}-moved`;
    mkdirSync(path.join(target, 'Taken'), { recursive: true });

    const scanned = nextScan(peer);
    const refused = service.update(LIB, { root_path: target, bin_name: 'Taken' });
    await expect(refused).rejects.toMatchObject({ code: 'CONFLICT' });
    await scanned;

    expect(repo.getById(LIB)?.root_path).toBe(target);
  });

  it('refuses a relative path, a file, DATA_DIR and another library’s root, changing nothing', async () => {
    const peer = makeLibrary();
    const { service, repo } = serviceFor(peer);
    repo.setBinIdentity(LIB, { dev: 1, ino: 2, birthtime: 3 });
    let scans = 0;
    peer.scan.onScanned(() => scans++);
    const file = `${peer.root}.txt`;
    writeFileSync(file, '');
    const other = `${peer.root}-taken`;
    peer.db
      .query("INSERT INTO libraries (id, root_path, name) VALUES ('lib00two', ?, 'Other')")
      .run(other);

    for (const [root_path, code] of [
      ['relative/photos', 'VALIDATION_ERROR'],
      [file, 'VALIDATION_ERROR'],
      [path.join(config.dataDir, 'inside'), 'VALIDATION_ERROR'],
      [other, 'CONFLICT'],
      [`${other}/`, 'CONFLICT'],
    ] as const) {
      await expect(service.update(LIB, { root_path })).rejects.toMatchObject({ code });
    }
    expect(repo.getById(LIB)?.root_path).toBe(peer.root);
    expect(repo.getBinIdentity(LIB)).toEqual({ dev: 1, ino: 2, birthtime: 3 });
    expect(scans).toBe(0);
    expect(existsSync(peer.root)).toBe(true);
  });

  it('treats its own root, however spelled, as no change', async () => {
    const peer = makeLibrary();
    const { service, repo } = serviceFor(peer);
    let scans = 0;
    peer.scan.onScanned(() => scans++);

    await service.update(LIB, { root_path: `${peer.root}/` });

    expect(repo.getById(LIB)?.root_path).toBe(peer.root);
    expect(scans).toBe(0);
  });
});
