import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { BlobLocations } from '../../blobs/blob_locations';
import { Originals } from '../../blobs/originals';
import { TransferService } from '../../blobs/transfer_service';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { Peers } from '../../replication/peer_transport';
import { StackMembership } from '../../stacks/stack_membership';
import { BackupLocations } from '../backup_locations';
import { backupStagePath, backupStagingDir } from '../backup_root';
import { Cull } from '../cull';
import { Mirror } from '../mirror';
import { PassivePeers } from '../passive_peers';
import { LibraryActivity } from '../../activity/library_activity';
import { BackupApi } from '../../../api/backup/backup_api';
import {
  BackupRunResponseSchema,
  BackupStatusesSchema,
  BackupStatusSchema,
  FetchBackStatusSchema,
  type FetchBackProgress,
} from '../../../schemas/backup';
import { PathSegment, route } from '../../../schemas/route';
import { libraryMutex } from '../../sync/coordination/library_mutex';

// One device, one folder, real files on both sides. The passive peer answers the same blob
// protocol a device does, so what is exercised here is the whole of a backup: the diff, the
// transfer queue, the hash checks, and the one deletion of an original the cull makes.

const LIB = 'library1';

const trees: string[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

function temp(name: string): string {
  const made = mkdtempSync(path.join(tmpdir(), `bb-backup-${name}-`));
  trees.push(made);
  return made;
}

function makeDevice(): {
  db: Database;
  root: string;
  backupRoot: string;
  mirror: Mirror;
  backups: BackupLocations;
  originals: Originals;
  photoScan: PhotoScanRepository;
  photoPaths: PhotoPathsRepository;
  libraries: LibrariesRepository;
  transfers: TransferService;
  passive: PassivePeers;
  activity: LibraryActivity;
} {
  const activity = new LibraryActivity();
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const root = temp('library');
  const backupRoot = temp('folder');
  db.query(
    "INSERT INTO libraries (id, root_path, name, bin_name) VALUES (?, ?, 'Trip', 'Bin')",
  ).run(LIB, root);

  const photoProcessing = new PhotoProcessingRepository(db, new RenditionsRepository(db));
  const photoPaths = new PhotoPathsRepository(db, new StackMembership(db));
  const photoMetadata = new PhotoMetadataRepository(db, photoProcessing);
  const photoScan = new PhotoScanRepository(db, photoProcessing);
  const libraries = new LibrariesRepository(db);
  const backups = new BackupLocations(db);
  const passive = new PassivePeers(db, libraries, photoPaths, photoMetadata, backups);
  // No devices here: a backup is the only peer this test has, and an active one asked for
  // anything would be a fetch going somewhere nobody configured.
  const transfers = new TransferService(
    db,
    photoPaths,
    photoMetadata,
    libraries,
    new BlobLocations(db),
    backups,
    new Peers(passive, {
      canReach: () => false,
      request: () => Promise.reject(new Error('no device is paired')),
    }),
    undefined,
    activity,
  );
  const mirror = new Mirror(db, libraries, backups, transfers, new Cull(db, transfers), activity);
  return {
    db,
    root,
    backupRoot,
    mirror,
    backups,
    originals: new Originals(db, photoPaths, transfers, backups),
    photoScan,
    photoPaths,
    libraries,
    transfers,
    passive,
    activity,
  };
}

it('tracks backup copying, offload and restoration beyond the transfer queue', async () => {
  const device = makeDevice();
  addPhoto(device, 'p1', 'p1.arw', 'original bytes', '2026-01-01T00:00:00.000Z');
  await device.mirror.setTarget(LIB, device.backupRoot);
  device.mirror.setBudget(LIB, 1);
  const backup = device.mirror.run(LIB);
  expect(device.activity.current(LIB)).toEqual([{ kind: 'backing_up', count: 1 }]);
  expect((await backup).report).toMatchObject({ copied: 1, offloaded: 1 });
  expect(device.activity.current(LIB)).toEqual([]);

  const restored = device.mirror.removeTarget(LIB, true);
  try {
    expect(device.activity.current(LIB)).toEqual([
      { kind: 'restoring_backup', count: 1 },
      { kind: 'fetching', count: 1 },
    ]);
  } finally {
    await restored;
  }
  expect(readFileSync(path.join(device.root, 'p1.arw'), 'utf8')).toBe('original bytes');
  expect(device.activity.current(LIB)).toEqual([]);
});

function addPhoto(
  device: ReturnType<typeof makeDevice>,
  id: string,
  relPath: string,
  bytes: string,
  addedAt: string,
): void {
  const abs = path.join(device.root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  device.photoScan.insertFromScan({
    id,
    library_id: LIB,
    shoot_id: null,
    file_hash: 'stat-hash',
    file_path: relPath,
    width: 100,
    height: 80,
    orientation: 0,
    date_taken: null,
    date_taken_offset: null,
    date_added: addedAt,
    date_updated: null,
    file_size: Buffer.byteLength(bytes),
    latitude: null,
    longitude: null,
    iso: null,
    shutter_speed: null,
    aperture: null,
    focal_length: null,
    camera_make: null,
    camera_model: null,
    lens_model: null,
    capture_sequence: null,
  });
}

function photoRow(
  device: ReturnType<typeof makeDevice>,
  id: string,
): { is_missing: number; content_hash: string | null } {
  return device.db.query('SELECT is_missing, content_hash FROM photos WHERE id = ?').get(id) as {
    is_missing: number;
    content_hash: string | null;
  };
}

describe('backing a library up to a folder', () => {
  it('preserves same-size damaged move sources and repairs from a matching local original', async () => {
    for (const local of [true, false]) {
      const device = makeDevice();
      addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
      const configured = await device.mirror.setTarget(LIB, device.backupRoot);
      if (!configured.configured) throw new Error('missing backup');
      if (!local) device.mirror.setBudget(LIB, 1);
      await device.mirror.run(LIB);
      writeFileSync(path.join(device.backupRoot, 'one.arw'), 'BAD-one');
      device.db
        .query(
          "UPDATE photos SET recipe = json_set(recipe, '$.path', 'Bin/one.arw') WHERE id = 'p1'",
        )
        .run();
      if (local) {
        mkdirSync(path.join(device.root, 'Bin'));
        writeFileSync(path.join(device.root, 'Bin/one.arw'), 'RAW-one');
      }
      const result = await device.mirror.run(LIB);
      expect(result.report.moved).toBe(0);
      expect(readFileSync(path.join(device.backupRoot, 'one.arw'), 'utf8')).toBe('BAD-one');
      if (local) {
        expect(result.report).toMatchObject({
          outcome: 'complete',
          copied: 1,
          issues: { total: 0 },
        });
        expect(readFileSync(path.join(device.backupRoot, 'Bin/one.arw'), 'utf8')).toBe('RAW-one');
        expect(result.status).toMatchObject({ configured: true, status: 'current' });
      } else {
        expect(result.report.outcome).toBe('partial');
        expect(device.backups.entry(LIB, configured.peer_id, 'p1')?.health).toBe('changed');
        expect(existsSync(path.join(device.backupRoot, 'Bin/one.arw'))).toBe(false);
      }
    }
  });

  it('rejects markers naming active devices or this device without changing pairing or files', async () => {
    for (const identity of ['active', 'self']) {
      const device = makeDevice();
      addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
      const original = await device.mirror.setTarget(LIB, device.backupRoot);
      await device.mirror.run(LIB);
      const self = device.db.query('SELECT peer_id FROM replication_identity').get() as {
        peer_id: string;
      };
      const peer = identity === 'self' ? self.peer_id : 'active1234567890';
      if (identity === 'active')
        device.db
          .query(
            "INSERT INTO replication_peers (library_id, peer_id, name, paired_at, address, kind) VALUES (?, ?, 'Laptop', '2026-01-01', 'http://laptop', 'active')",
          )
          .run(LIB, peer);
      const before = device.db
        .query('SELECT kind, address FROM replication_peers WHERE peer_id = ?')
        .get(peer);
      const selected = temp('active-marker');
      const marker = JSON.stringify({ library_id: LIB, library_name: 'Trip', peer_id: peer });
      writeFileSync(path.join(selected, '.bowerbird-backup.json'), marker);
      await expect(device.mirror.setTarget(LIB, selected)).rejects.toMatchObject({
        issueCode: 'wrong_backup',
      });
      expect(
        device.db.query('SELECT kind, address FROM replication_peers WHERE peer_id = ?').get(peer),
      ).toEqual(before);
      expect(readFileSync(path.join(selected, '.bowerbird-backup.json'), 'utf8')).toBe(marker);
      expect(device.mirror.status(LIB)).toMatchObject({
        configured: true,
        path: device.backupRoot,
      });
      if (!original.configured) throw new Error('missing backup');
      expect(device.backups.entry(LIB, original.peer_id, 'p1')?.health).toBe('held');
    }
  });

  it('protects the last original when its local file disappears before a scan', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    const original = await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);
    rmSync(path.join(device.root, 'one.arw'));
    expect(photoRow(device, 'p1').is_missing).toBe(0);
    const selected = temp('replacement');
    await expect(device.mirror.setTarget(LIB, selected)).rejects.toMatchObject({
      issueCode: 'local_missing',
    });
    expect(existsSync(path.join(selected, '.bowerbird-backup.json'))).toBe(false);
    expect(device.mirror.status(LIB)).toMatchObject({ configured: true, path: device.backupRoot });
    if (!original.configured) throw new Error('missing backup');
    expect(device.backups.entry(LIB, original.peer_id, 'p1')?.health).toBe('held');
    writeFileSync(path.join(selected, 'one.arw'), 'RAW-one');
    expect(await device.mirror.setTarget(LIB, selected)).toMatchObject({
      configured: true,
      path: selected,
      coverage: { backed_up: 1 },
    });
    expect(
      await device.originals.open(
        device.libraries.getById(LIB)!,
        device.photoPaths.getBasicById('p1')!,
      ),
    ).toBe(path.join(device.root, 'one.arw'));
  });

  it('discards a damaged local resume prefix without marking the healthy backup damaged', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    const configured = await device.mirror.setTarget(LIB, device.backupRoot);
    if (!configured.configured) throw new Error('missing backup');
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    mkdirSync(path.join(device.root, '.bowerbird-staging'));
    writeFileSync(path.join(device.root, '.bowerbird-staging', 'p1.partial'), 'BAD');
    const library = device.libraries.getById(LIB)!;
    const photo = device.photoPaths.getBasicById('p1')!;
    await expect(device.originals.open(library, photo)).rejects.toMatchObject({
      issueCode: 'transfer_failed',
    });
    expect(device.backups.entry(LIB, configured.peer_id, 'p1')?.health).toBe('held');
    expect(existsSync(path.join(device.root, '.bowerbird-staging'))).toBe(false);
    expect(readFileSync(path.join(device.backupRoot, 'one.arw'), 'utf8')).toBe('RAW-one');
    expect(await device.originals.open(library, photo)).toBe(path.join(device.root, 'one.arw'));
    expect(readFileSync(path.join(device.root, 'one.arw'), 'utf8')).toBe('RAW-one');
  });

  it('retains every blocked move as a current issue across restart while bounding history samples', async () => {
    const device = makeDevice();
    for (let i = 0; i < 12; i += 1)
      addPhoto(device, `p${i}`, `${i}.arw`, `RAW-${i}`, '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);
    mkdirSync(path.join(device.backupRoot, 'Bin'));
    for (let i = 0; i < 12; i += 1) {
      device.db
        .query("UPDATE photos SET recipe = json_set(recipe, '$.path', ?) WHERE id = ?")
        .run(`Bin/${i}.arw`, `p${i}`);
      writeFileSync(path.join(device.backupRoot, 'Bin', `${i}.arw`), 'user file');
    }
    const result = await device.mirror.run(LIB);
    expect(result.report.issues).toMatchObject({
      total: 12,
      counts: [{ code: 'path_conflict', count: 12 }],
    });
    expect(result.report.issues.samples).toHaveLength(10);
    const restarted = new Mirror(
      device.db,
      device.libraries,
      device.backups,
      device.transfers,
      new Cull(device.db, device.transfers),
    );
    const status = restarted.status(LIB);
    if (!status.configured) throw new Error('missing backup');
    expect(status.issues).toMatchObject({
      total: 12,
      counts: [{ code: 'path_conflict', count: 12 }],
    });
    expect(status.issues.samples).toHaveLength(10);
    writeFileSync(path.join(device.backupRoot, 'Bin/0.arw'), 'RAW-0');
    const repaired = await restarted.run(LIB);
    expect(repaired.report.moved).toBe(1);
    expect(repaired.status).toMatchObject({
      configured: true,
      issues: { total: 11, counts: [{ code: 'path_conflict', count: 11 }] },
    });
    expect(readFileSync(path.join(device.backupRoot, '0.arw'), 'utf8')).toBe('RAW-0');
  });

  it('keeps current local-integrity evidence until a live check proves repair or safe eviction', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    const configured = await device.mirror.setTarget(LIB, device.backupRoot);
    if (!configured.configured) throw new Error('missing backup');
    await device.mirror.run(LIB);
    writeFileSync(path.join(device.root, 'one.arw'), 'BAD-one');
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    device.mirror.setBudget(LIB, null);
    const unrelated = await device.mirror.run(LIB);
    expect(unrelated.report.outcome).toBe('partial');
    expect(unrelated.status).toMatchObject({
      configured: true,
      status: 'attention',
      issues: { counts: [{ code: 'local_changed', count: 1 }] },
    });
    writeFileSync(path.join(device.root, 'one.arw'), 'RAW-one');
    expect(await device.transfers.evict(['p1'], configured.peer_id)).toEqual({
      evicted: ['p1'],
      refused: [],
    });
    const clean = device.mirror.status(LIB);
    expect(clean).toMatchObject({
      configured: true,
      status: 'current',
      issues: { total: 0 },
      last_backup_report: unrelated.report,
    });
    expect(existsSync(path.join(device.root, 'one.arw'))).toBe(false);
  });

  it('continues reporting byte progress when the wall clock moves backwards', async () => {
    const device = makeDevice();
    const chunk = 8 * 1024 * 1024;
    addPhoto(device, 'p1', 'one.arw', 'x'.repeat(chunk + 1), '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    let wall = Date.now();
    let monotonic = 1_000;
    const wallClock = spyOn(Date, 'now').mockImplementation(() => wall);
    const durationClock = spyOn(performance, 'now').mockImplementation(() => monotonic);
    const progress: number[] = [];
    device.transfers.onChanged(() => progress.push(device.transfers.list(LIB)[0]?.bytes_done ?? 0));
    const request = device.passive.request.bind(device.passive);
    device.passive.request = async (...args) => {
      if (args[2]?.method === 'PUT') {
        wall -= 100_000;
        monotonic += 1_000;
      }
      return await request(...args);
    };
    try {
      expect((await device.mirror.run(LIB)).report.copied).toBe(1);
      expect(progress).toContain(chunk);
    } finally {
      wallClock.mockRestore();
      durationClock.mockRestore();
    }
  });

  it('lists the damaged path after an on-demand fetch outside a backup pass', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    writeFileSync(path.join(device.backupRoot, 'one.arw'), 'BAD-one');
    await expect(
      device.originals.open(device.libraries.getById(LIB)!, device.photoPaths.getBasicById('p1')!),
    ).rejects.toMatchObject({ issueCode: 'backup_changed' });
    const status = device.mirror.status(LIB);
    if (!status.configured) throw new Error('missing backup');
    expect(status.status).toBe('attention');
    expect(status.issues).toMatchObject({
      total: 1,
      counts: [{ code: 'backup_changed', count: 1 }],
    });
    expect(status.issues.samples[0]).toMatchObject({
      code: 'backup_changed',
      path: 'one.arw',
      photo_id: 'p1',
    });
  });

  it('keeps historical reports without warning about successfully retried transfers', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    const configured = await device.mirror.setTarget(LIB, device.backupRoot);
    if (!configured.configured) throw new Error('missing backup');
    writeFileSync(path.join(device.backupRoot, 'one.arw'), 'user file');
    const failed = await device.mirror.run(LIB);
    writeFileSync(path.join(device.backupRoot, 'one.arw'), 'RAW-one');
    device.transfers.resume(device.transfers.list(LIB)[0]!.id);
    await device.transfers.drain();
    expect(device.mirror.status(LIB)).toMatchObject({
      configured: true,
      status: 'current',
      last_backup_report: failed.report,
    });
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    const request = device.passive.request.bind(device.passive);
    device.passive.request = async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    await expect(device.mirror.removeTarget(LIB, true)).rejects.toThrow('1 original');
    const restoreFailure = device.mirror.status(LIB);
    if (!restoreFailure.configured) throw new Error('missing backup');
    device.passive.request = request;
    await device.originals.open(
      device.libraries.getById(LIB)!,
      device.photoPaths.getBasicById('p1')!,
    );
    device.mirror.setBudget(LIB, null);
    expect(device.mirror.status(LIB)).toMatchObject({
      configured: true,
      status: 'current',
      last_restore_report: restoreFailure.last_restore_report,
    });
  });

  it('resolves queued passive I/O against the current target under the library lock', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    const configured = await device.mirror.setTarget(LIB, device.backupRoot);
    if (!configured.configured) throw new Error('missing backup');
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lock = libraryMutex.run(LIB, async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const next = temp('replacement');
    const changing = device.mirror.setTarget(LIB, next);
    const request = device.passive.request(configured.peer_id, route('p1', PathSegment.stage()));
    release.resolve();
    await lock;
    await changing;
    await expect(request).rejects.toMatchObject({ issueCode: 'wrong_backup' });
    expect(existsSync(path.join(next, 'one.arw'))).toBe(false);
  });

  it('keeps pause counts truthful when an aborted passive request settles later', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    const request = device.passive.request.bind(device.passive);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    device.passive.request = async (...args) => {
      arrived.resolve();
      await release.promise;
      return await request(...args);
    };
    const running = device.mirror.run(LIB);
    await arrived.promise;
    device.transfers.pause(device.transfers.list(LIB)[0]!.id);
    const result = await running;
    expect(result.report).toMatchObject({
      copied: 0,
      outcome: 'partial',
      issues: { counts: [{ code: 'paused', count: 1 }] },
    });
    expect(result.status).toMatchObject({
      configured: true,
      status: 'paused',
      activity: null,
      coverage: { pending: 1 },
    });
    release.resolve();
    await device.transfers.drain();
    expect(device.transfers.list(LIB)[0]!.state).toBe('paused');
    expect(existsSync(path.join(device.backupRoot, 'one.arw'))).toBe(false);
  });

  it('reports offload progress independently of completed push counts', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    const evict = device.transfers.evict.bind(device.transfers);
    device.transfers.evict = async (...args) => {
      expect(device.mirror.status(LIB)).toMatchObject({
        configured: true,
        activity: { phase: 'offloading', done: 0, total: 1, current: null },
      });
      return await evict(...args);
    };
    expect((await device.mirror.run(LIB)).report.offloaded).toBe(1);
  });

  it('reports mixed successful copies and paused or conflicting originals', async () => {
    const device = makeDevice();
    for (const id of ['good', 'conflict', 'paused'])
      addPhoto(device, id, `${id}.arw`, `RAW-${id}`, '2026-01-01T00:00:00.000Z');
    const status = await device.mirror.setTarget(LIB, device.backupRoot);
    if (!status.configured) throw new Error('missing backup');
    writeFileSync(path.join(device.backupRoot, 'conflict.arw'), 'user file');
    device.db
      .query(
        "INSERT INTO blob_transfers (id, library_id, photo_id, peer_id, direction, state, queued_at) VALUES ('paused', ?, 'paused', ?, 'push', 'paused', '2026-01-01')",
      )
      .run(LIB, status.peer_id);
    const result = await device.mirror.run(LIB);
    expect(result.report).toMatchObject({ copied: 1, outcome: 'partial', issues: { total: 2 } });
    expect(result.report.issues.counts).toEqual(
      expect.arrayContaining([
        { code: 'path_conflict', count: 1 },
        { code: 'paused', count: 1 },
      ]),
    );
    expect(result.status).toMatchObject({
      configured: true,
      status: 'attention',
      coverage: { backed_up: 1, pending: 2 },
      transfers: { paused: 1, failed: 1 },
    });
  });

  it('retains full issue totals while bounding report samples', async () => {
    const device = makeDevice();
    await device.mirror.setTarget(LIB, device.backupRoot);
    for (let i = 0; i < 12; i += 1) {
      addPhoto(device, `p${i}`, `${i}.arw`, 'RAW', '2026-01-01T00:00:00.000Z');
      writeFileSync(path.join(device.backupRoot, `${i}.arw`), 'user file');
    }
    const result = await device.mirror.run(LIB);
    expect(result.report.issues.total).toBe(12);
    expect(result.report.issues.counts).toEqual([{ code: 'path_conflict', count: 12 }]);
    expect(result.report.issues.samples).toHaveLength(10);
  });

  it('reinitialises a missing marker and reuses verified retained originals', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    addPhoto(device, 'p2', 'two.arw', 'RAW-two', '2026-01-01T00:00:00.000Z');
    const before = await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);
    rmSync(path.join(device.backupRoot, '.bowerbird-backup.json'));
    rmSync(path.join(device.backupRoot, 'two.arw'));
    expect(device.mirror.status(LIB)).toMatchObject({ configured: true, access: 'marker_missing' });
    const recovered = await device.mirror.setTarget(LIB, device.backupRoot);
    if (!before.configured || !recovered.configured) throw new Error('missing backup');
    expect(recovered.peer_id).not.toBe(before.peer_id);
    expect(recovered.coverage).toMatchObject({ backed_up: 1, pending: 1 });
    const result = await device.mirror.run(LIB);
    expect(result.report).toMatchObject({ outcome: 'complete', copied: 1 });
    expect(result.status).toMatchObject({
      configured: true,
      status: 'current',
      coverage: { backed_up: 2, pending: 0 },
    });
  });

  it('preserves missing offloaded evidence through marker recovery and restart', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    rmSync(path.join(device.backupRoot, '.bowerbird-backup.json'));
    rmSync(path.join(device.backupRoot, 'one.arw'));
    await device.mirror.setTarget(LIB, device.backupRoot);
    const restarted = new Mirror(
      device.db,
      device.libraries,
      device.backups,
      device.transfers,
      new Cull(device.db, device.transfers),
    );
    expect(restarted.status(LIB)).toMatchObject({
      configured: true,
      status: 'attention',
      coverage: { missing: 1, missing_originals: 1 },
    });
  });

  it('marks same-size backup damage while retaining local originals and healthy local damage evidence', async () => {
    for (const damaged of ['backup', 'local']) {
      const device = makeDevice();
      addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
      const status = await device.mirror.setTarget(LIB, device.backupRoot);
      if (!status.configured) throw new Error('missing backup');
      await device.mirror.run(LIB);
      writeFileSync(
        path.join(damaged === 'backup' ? device.backupRoot : device.root, 'one.arw'),
        'BAD-one',
      );
      device.mirror.setBudget(LIB, 1);
      const result = await device.mirror.run(LIB);
      expect(result.report.offloaded).toBe(0);
      expect(result.report.issues.counts).toContainEqual({
        code: damaged === 'backup' ? 'backup_changed' : 'local_changed',
        count: 1,
      });
      expect(device.backups.entry(LIB, status.peer_id, 'p1')?.health).toBe(
        damaged === 'backup' ? 'changed' : 'held',
      );
      expect(existsSync(path.join(device.root, 'one.arw'))).toBe(true);
      expect(result.status).toMatchObject({
        configured: true,
        status: 'attention',
        budget_unmet: true,
      });
    }
  });

  it('reports blocked moves and adopts exact matching destinations without removing extra copies', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);
    device.db
      .query("UPDATE photos SET recipe = json_set(recipe, '$.path', 'Bin/one.arw') WHERE id = 'p1'")
      .run();
    mkdirSync(path.join(device.backupRoot, 'Bin'));
    writeFileSync(path.join(device.backupRoot, 'Bin/one.arw'), 'user file');
    const conflict = await device.mirror.run(LIB);
    expect(conflict.report.issues.samples[0]).toMatchObject({
      code: 'path_conflict',
      phase: 'moving',
      path: 'Bin/one.arw',
    });
    writeFileSync(path.join(device.backupRoot, 'Bin/one.arw'), 'RAW-one');
    expect((await device.mirror.run(LIB)).report.moved).toBe(1);
    expect(readFileSync(path.join(device.backupRoot, 'one.arw'), 'utf8')).toBe('RAW-one');
  });

  it('surfaces failed restoration without erasing backup reports', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    addPhoto(device, 'p2', 'two.arw', 'RAW-two', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    const backed = await device.mirror.run(LIB);
    rmSync(path.join(device.backupRoot, 'two.arw'));
    await expect(device.mirror.removeTarget(LIB, true)).rejects.toThrow('1 original');
    expect(device.mirror.status(LIB)).toMatchObject({
      configured: true,
      last_backup_report: backed.report,
      last_restore_report: {
        outcome: 'partial',
        restored: 1,
        issues: { samples: [{ code: 'backup_missing', phase: 'restoring' }] },
      },
    });
    const photo = device.photoPaths.getBasicById('p2')!;
    await expect(
      device.originals.open(device.libraries.getById(LIB)!, photo),
    ).rejects.toMatchObject({ issueCode: 'backup_missing' });
    const status = device.mirror.status(LIB);
    if (!status.configured) throw new Error('missing backup');
    expect(status.issues.samples[0]).toMatchObject({ code: 'backup_missing', path: 'two.arw' });
  });

  it('rejects concurrent backup and target changes while reporting active copy progress', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    const request = device.passive.request.bind(device.passive);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    device.passive.request = async (...args) => {
      arrived.resolve();
      await release.promise;
      return await request(...args);
    };
    const running = device.mirror.run(LIB);
    await arrived.promise;
    expect(device.mirror.status(LIB)).toMatchObject({
      configured: true,
      status: 'working',
      activity: { phase: 'copying', done: 0, total: 1, current: { path: 'one.arw' } },
    });
    await expect(device.mirror.run(LIB)).rejects.toThrow(/operation is running/);
    await expect(device.mirror.setTarget(LIB, temp('next'))).rejects.toThrow(
      /operation is running/,
    );
    release.resolve();
    expect((await running).report.copied).toBe(1);
  });

  it('reports typed disk errors without counting a disappeared source as copied', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.passive.request = async () => {
      device.db.query("UPDATE photos SET is_missing = 1 WHERE id = 'p1'").run();
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    const result = await device.mirror.run(LIB);
    expect(result.report).toMatchObject({ copied: 0, outcome: 'partial' });
    expect(result.report.issues.samples[0]).toMatchObject({ code: 'no_space', path: 'one.arw' });
  });

  it('serves unconfigured and partial backup results through validated API responses', async () => {
    const device = makeDevice();
    const api = new BackupApi(device.mirror);
    const initial = await api.routes.request(route(LIB));
    expect(BackupStatusSchema.parse(await initial.json())).toEqual({
      library_id: LIB,
      configured: false,
    });
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    writeFileSync(path.join(device.backupRoot, 'one.arw'), 'user file');
    const response = await api.routes.request(route(LIB, PathSegment.run()), { method: 'POST' });
    const result = BackupRunResponseSchema.parse(await response.json());
    expect(result.report).toMatchObject({ outcome: 'partial', copied: 0 });
    expect(result.status).toMatchObject({ configured: true, status: 'attention' });
  });

  it('selects, limits, lists and removes a backup through the API', async () => {
    const device = makeDevice();
    const api = new BackupApi(device.mirror);
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    const json = { 'content-type': 'application/json' };

    const selected = await api.routes.request(route(), {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ library_id: LIB, path: device.backupRoot, name: 'Drive' }),
    });
    expect(BackupStatusSchema.parse(await selected.json())).toMatchObject({
      configured: true,
      name: 'Drive',
      path: device.backupRoot,
    });

    const limited = await api.routes.request(route(LIB, PathSegment.budget()), {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ local_budget_bytes: 1000 }),
    });
    expect(BackupStatusSchema.parse(await limited.json())).toMatchObject({
      local_budget_bytes: 1000,
    });

    const listed = await api.routes.request(route());
    expect(BackupStatusesSchema.parse(await listed.json()).backups).toMatchObject([
      { library_id: LIB, configured: true },
    ]);

    const progress = await api.routes.request(route(LIB, PathSegment.fetch()));
    expect(FetchBackStatusSchema.parse(await progress.json())).toEqual({ progress: null });

    const removed = await api.routes.request(`${route(LIB)}?fetch_first=1`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect(device.mirror.status(LIB)).toEqual({ library_id: LIB, configured: false });
  });

  it('reports a conflicting path without claiming the backup is current', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    writeFileSync(path.join(device.backupRoot, 'one.arw'), 'another file');

    const result = await device.mirror.run(LIB);

    expect(result.report).toMatchObject({ outcome: 'partial', copied: 0, issues: { total: 1 } });
    expect(result.report.issues.samples[0]).toMatchObject({
      code: 'path_conflict',
      path: 'one.arw',
      phase: 'copying',
    });
    expect(result.status).toMatchObject({
      configured: true,
      status: 'attention',
      coverage: { pending: 1 },
    });
    expect(readFileSync(path.join(device.backupRoot, 'one.arw'), 'utf8')).toBe('another file');
  });

  it('keeps missing backup evidence when no local original can repair it', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    rmSync(path.join(device.backupRoot, 'one.arw'));

    const result = await device.mirror.run(LIB);

    expect(result.status).toMatchObject({
      configured: true,
      status: 'attention',
      coverage: { missing: 1, missing_originals: 1, backed_up: 0 },
    });
    expect(
      device.backups.entry(LIB, result.status.configured ? result.status.peer_id : '', 'p1'),
    ).toMatchObject({ health: 'missing' });
    await expect(
      device.originals.open(device.libraries.getById(LIB)!, device.photoPaths.getBasicById('p1')!),
    ).rejects.toThrow(/missing/);
  });

  it('refuses malformed markers during explicit folder selection', async () => {
    const device = makeDevice();
    const marker = path.join(device.backupRoot, '.bowerbird-backup.json');
    writeFileSync(marker, 'broken');
    await expect(device.mirror.setTarget(LIB, device.backupRoot)).rejects.toThrow(/marker/);
    expect(readFileSync(marker, 'utf8')).toBe('broken');
  });

  it('refuses switching an offloaded original to an empty folder', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    await expect(device.mirror.setTarget(LIB, temp('empty'))).rejects.toThrow(/original/);
    expect(device.mirror.status(LIB)).toMatchObject({ configured: true, path: device.backupRoot });
  });

  it('returns unconfigured state and refuses a run with no target', async () => {
    const device = makeDevice();
    expect(device.mirror.status(LIB)).toEqual({ library_id: LIB, configured: false });
    await expect(device.mirror.run(LIB)).rejects.toThrow(/backup folder/);
  });

  it('copies every original to the folder, and copies nothing the second time', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    addPhoto(device, 'p2', 'trip/two.arw', 'RAW-two', '2026-01-02T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);

    const first = await device.mirror.run(LIB);

    expect(first.report.copied).toBe(2);
    expect(readFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'utf8')).toBe('RAW-one');
    expect(readFileSync(path.join(device.backupRoot, 'trip/two.arw'), 'utf8')).toBe('RAW-two');
    expect(existsSync(backupStagingDir(device.backupRoot))).toBe(false);
    // The hash exists from the moment bytes first move, and it is what every later check reads.
    expect(photoRow(device, 'p1').content_hash).toMatch(/^[0-9a-f]{64}$/);

    expect((await device.mirror.run(LIB)).report.copied).toBe(0);
    expect(existsSync(backupStagingDir(device.backupRoot))).toBe(false);

    addPhoto(device, 'p3', 'trip/three.arw', 'RAW-three', '2026-01-03T00:00:00.000Z');
    expect((await device.mirror.run(LIB)).report.copied).toBe(1);
    expect(readFileSync(path.join(device.backupRoot, 'trip/three.arw'), 'utf8')).toBe('RAW-three');
    expect(existsSync(backupStagingDir(device.backupRoot))).toBe(false);
  });

  it('removes empty and abandoned staging directories during a backup pass', async () => {
    const device = makeDevice();
    await device.mirror.setTarget(LIB, device.backupRoot);
    const dir = backupStagingDir(device.backupRoot);
    mkdirSync(dir);

    expect((await device.mirror.run(LIB)).report.copied).toBe(0);
    expect(existsSync(dir)).toBe(false);

    mkdirSync(dir);
    writeFileSync(backupStagePath(device.backupRoot, 'abandoned'), 'half a RAW');
    expect((await device.mirror.run(LIB)).report.copied).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(device.backupRoot)).toBe(true);
  });

  it('keeps paused and failed stages and unrelated files during a backup pass', async () => {
    const device = makeDevice();
    await device.mirror.setTarget(LIB, device.backupRoot);
    const peer = device.db
      .query("SELECT peer_id FROM replication_peers WHERE kind = 'passive'")
      .get() as {
      peer_id: string;
    };
    const dir = backupStagingDir(device.backupRoot);
    mkdirSync(dir);
    for (const state of ['paused', 'failed']) {
      addPhoto(device, state, `${state}.arw`, `${state} bytes`, '2026-01-01T00:00:00.000Z');
      writeFileSync(backupStagePath(device.backupRoot, state), `${state} bytes`);
      device.db
        .query(
          `INSERT INTO blob_transfers (id, library_id, photo_id, peer_id, direction, state, queued_at)
           VALUES (?, ?, ?, ?, 'push', ?, '2026-01-01T00:00:00.000Z')`,
        )
        .run(state, LIB, state, peer.peer_id, state);
    }
    writeFileSync(path.join(dir, 'keep.arw'), 'users own');
    writeFileSync(backupStagePath(device.backupRoot, 'abandoned'), 'orphan');
    writeFileSync(path.join(device.backupRoot, 'failed.arw'), 'users own');

    expect((await device.mirror.run(LIB)).report.copied).toBe(0);

    expect(existsSync(backupStagePath(device.backupRoot, 'abandoned'))).toBe(false);
    for (const state of ['paused', 'failed']) {
      expect(readFileSync(backupStagePath(device.backupRoot, state), 'utf8')).toBe(
        `${state} bytes`,
      );
    }
    expect(readFileSync(path.join(dir, 'keep.arw'), 'utf8')).toBe('users own');
    expect(readFileSync(path.join(device.backupRoot, 'failed.arw'), 'utf8')).toBe('users own');
  });

  it('copies again what the folder has quietly lost', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);
    // Somebody tidies the drive, or a filesystem loses a directory. Nothing says so until a pass
    // looks at the copy again.
    rmSync(path.join(device.backupRoot, 'trip/one.arw'));

    const run = await device.mirror.run(LIB);

    expect(run.report.copied).toBe(1);
    expect(readFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'utf8')).toBe('RAW-one');
  });

  it('follows a photo the catalogue has moved, rather than copying it again', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);

    // What a bin move or a folder rename leaves behind: the row names a new path, and the file on
    // this device is already there.
    mkdirSync(path.join(device.root, 'Bin'), { recursive: true });
    writeFileSync(path.join(device.root, 'Bin/one.arw'), 'RAW-one');
    rmSync(path.join(device.root, 'trip/one.arw'));
    device.db
      .query("UPDATE photos SET recipe = json_set(recipe, '$.path', 'Bin/one.arw') WHERE id = 'p1'")
      .run();

    const run = await device.mirror.run(LIB);

    expect(run.report.moved).toBe(1);
    expect(run.report.copied).toBe(0);
    expect(existsSync(path.join(device.backupRoot, 'trip/one.arw'))).toBe(false);
    expect(readFileSync(path.join(device.backupRoot, 'Bin/one.arw'), 'utf8')).toBe('RAW-one');
  });

  it('adopts a copy somebody put there by hand, once both files hash the same', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    mkdirSync(path.join(device.backupRoot, 'trip'), { recursive: true });
    writeFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'RAW-one');

    await device.mirror.run(LIB);

    // Backed up without sending a byte, and the photograph has the hash both copies were held to,
    // which is what the cull will later read.
    expect(device.backups.entry(LIB, device.backups.holders(LIB, 'p1')[0]!, 'p1')?.rel_path).toBe(
      'trip/one.arw',
    );
    expect(photoRow(device, 'p1').content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await device.mirror.run(LIB)).report.copied).toBe(0);
  });

  it('discards a failed transfer stage once a matching full backup copy has been restored', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    const peer = device.db
      .query("SELECT peer_id FROM replication_peers WHERE kind = 'passive'")
      .get() as {
      peer_id: string;
    };
    const dir = backupStagingDir(device.backupRoot);
    mkdirSync(dir);
    writeFileSync(backupStagePath(device.backupRoot, 'p1'), 'RAW');
    mkdirSync(path.join(device.backupRoot, 'trip'));
    writeFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'RAW-one');
    device.db
      .query(
        `INSERT INTO blob_transfers (id, library_id, photo_id, peer_id, direction, state, queued_at)
         VALUES ('retry', ?, 'p1', ?, 'push', 'failed', '2026-01-01T00:00:00.000Z')`,
      )
      .run(LIB, peer.peer_id);

    expect((await device.mirror.run(LIB)).report.copied).toBe(1);

    expect(device.db.query("SELECT state FROM blob_transfers WHERE id = 'retry'").get()).toEqual({
      state: 'done',
    });
    expect(readFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'utf8')).toBe('RAW-one');
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses to count a file of somebody else’s that happens to sit at the photo’s path', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    mkdirSync(path.join(device.backupRoot, 'trip'), { recursive: true });
    writeFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'SOMEBODY-ELSES-FILE');
    device.mirror.setBudget(LIB, 1);

    await device.mirror.run(LIB);

    // Neither overwritten on the backup nor given up here, which is the pair of answers that
    // matters: the file on the drive is still theirs, and this device still holds the photograph.
    expect(readFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'utf8')).toBe(
      'SOMEBODY-ELSES-FILE',
    );
    expect(readFileSync(path.join(device.root, 'trip/one.arw'), 'utf8')).toBe('RAW-one');
    expect(device.backups.holders(LIB, 'p1')).toEqual([]);
  });

  it('refuses a folder this catalogue already backs another library up to', async () => {
    const device = makeDevice();
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.db
      .query(
        "INSERT INTO libraries (id, root_path, name, bin_name) VALUES ('library2', ?, 'Other', 'Bin')",
      )
      .run(temp('other-library'));

    await expect(device.mirror.setTarget('library2', device.backupRoot)).rejects.toThrow(
      /overlaps the backup/,
    );
  });

  // The same folder, reached by a catalogue that knows nothing about it: a drive carried to
  // another machine, or a library re-added after a restore. Its own marker is the only evidence
  // of what it holds, and it is what stops two libraries writing into one tree.
  it('refuses a folder whose marker names another library', async () => {
    const device = makeDevice();
    const taken = temp('taken');
    writeFileSync(
      path.join(taken, '.bowerbird-backup.json'),
      JSON.stringify({
        library_id: 'elsewhere1234567',
        library_name: 'Reef',
        peer_id: 'abcdefghij123456',
      }),
    );

    await expect(device.mirror.setTarget(LIB, taken)).rejects.toThrow(/backs up "Reef"/);
  });

  it('refuses a folder inside the library it is backing up', async () => {
    const device = makeDevice();

    await expect(device.mirror.setTarget(LIB, path.join(device.root, 'backup'))).rejects.toThrow(
      /overlaps a library/,
    );
  });
});

describe('the cull', () => {
  it('gives back the least recently used local copies, keeping them on the backup', async () => {
    const device = makeDevice();
    addPhoto(device, 'old', 'trip/old.arw', 'RAW-old-file', '2026-01-01T00:00:00.000Z');
    addPhoto(device, 'new', 'trip/new.arw', 'RAW-new-file', '2026-01-02T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    // Room for one of the two, so exactly one has to go.
    device.mirror.setBudget(LIB, 'RAW-old-file'.length + 1);

    const run = await device.mirror.run(LIB);

    expect(run.report.offloaded).toBe(1);
    expect(existsSync(path.join(device.root, 'trip/old.arw'))).toBe(false);
    expect(existsSync(path.join(device.root, 'trip/new.arw'))).toBe(true);
    // Still on the backup, and the row says where it is rather than that it has gone.
    expect(readFileSync(path.join(device.backupRoot, 'trip/old.arw'), 'utf8')).toBe('RAW-old-file');
    expect(photoRow(device, 'old').is_missing).toBe(1);
    // What the grid draws the badge from: gone from this disk *and* held by a backup, which is a
    // different state from a photograph somebody deleted out from under the library.
    expect(new PhotoListingRepository(device.db).getById('old')?.is_offloaded).toBe(true);
    expect(new PhotoListingRepository(device.db).getById('new')?.is_offloaded).toBe(false);
  });

  it('keeps the copy of a photo something has opened, and takes an older one instead', async () => {
    const device = makeDevice();
    addPhoto(device, 'old', 'trip/old.arw', 'RAW-old-file', '2026-01-01T00:00:00.000Z');
    addPhoto(device, 'new', 'trip/new.arw', 'RAW-new-file', '2026-01-02T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);
    // The newer photograph is the one nothing has looked at since, which is what decides it.
    device.originals.touch('old');
    device.mirror.setBudget(LIB, 'RAW-old-file'.length + 1);

    await device.mirror.run(LIB);

    expect(existsSync(path.join(device.root, 'trip/old.arw'))).toBe(true);
    expect(existsSync(path.join(device.root, 'trip/new.arw'))).toBe(false);
  });

  it('refuses to remove a local copy the backup does not match', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);
    // The drive rots, or somebody edits the file on it. The row still says it is backed up.
    writeFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'NOT-THE-SAME');
    device.mirror.setBudget(LIB, 1);

    const run = await device.mirror.run(LIB);

    expect(run.report.offloaded).toBe(0);
    expect(readFileSync(path.join(device.root, 'trip/one.arw'), 'utf8')).toBe('RAW-one');
    expect(photoRow(device, 'p1').is_missing).toBe(0);
  });

  it('removes nothing while the folder is not there, and says which folder', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    await device.mirror.run(LIB);
    device.mirror.setBudget(LIB, 1);
    rmSync(device.backupRoot, { recursive: true, force: true });

    expect(await device.mirror.run(LIB)).toMatchObject({
      report: { outcome: 'blocked' },
      status: { configured: true, access: 'folder_missing' },
    });

    expect(existsSync(path.join(device.root, 'trip/one.arw'))).toBe(true);
    expect(device.mirror.status(LIB)).toMatchObject({
      configured: true,
      last_backup_report: { issues: { samples: [{ code: 'folder_missing' }] } },
    });
  });
});

describe('a photo with no local copy', () => {
  it('is found again when the same folder is paired back', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    await device.mirror.removeTarget(LIB, false);
    expect(device.backups.holders(LIB, 'p1')).toEqual([]);

    await device.mirror.setTarget(LIB, device.backupRoot);

    // The only copy was on the drive the whole time, and pairing it again is what reaches it.
    const photo = device.photoPaths.getBasicById('p1')!;
    const library = device.libraries.getById(LIB)!;
    expect(readFileSync((await device.originals.open(library, photo))!, 'utf8')).toBe('RAW-one');
  });

  it('is fetched back from the backup when something opens it', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    expect(existsSync(path.join(device.root, 'trip/one.arw'))).toBe(false);

    const photo = device.photoPaths.getBasicById('p1')!;
    const library = device.libraries.getById(LIB)!;
    const opened = await device.originals.open(library, photo);

    expect(opened).toBe(path.join(device.root, 'trip/one.arw'));
    expect(readFileSync(opened!, 'utf8')).toBe('RAW-one');
    expect(existsSync(path.join(device.root, '.bowerbird-staging'))).toBe(false);
    // And the catalogue says so again, so the badge goes and the pipeline is asked for what it owes.
    expect(photoRow(device, 'p1').is_missing).toBe(0);
  });

  it('says which folder to connect when the backup is not there', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    rmSync(device.backupRoot, { recursive: true, force: true });

    const photo = device.photoPaths.getBasicById('p1')!;
    const library = device.libraries.getById(LIB)!;

    await expect(device.originals.open(library, photo)).rejects.toThrow(/not available/);
  });
});

describe('stopping a backup', () => {
  it('can fetch every original back onto this device before it forgets the folder', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    expect(photoRow(device, 'p1').is_missing).toBe(1);

    const stopping = device.mirror.removeTarget(LIB, true);
    expect(device.mirror.fetchBackProgress(LIB)).toMatchObject({ done: 0, total: 1 });
    await stopping;
    expect(device.mirror.fetchBackProgress(LIB)).toBeNull();

    expect(readFileSync(path.join(device.root, 'trip/one.arw'), 'utf8')).toBe('RAW-one');
    expect(photoRow(device, 'p1').is_missing).toBe(0);
    expect(device.mirror.status(LIB)).toEqual({ library_id: LIB, configured: false });
  });

  it('keeps the folder when an original cannot come back', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    rmSync(path.join(device.backupRoot, 'trip/one.arw'));

    await expect(device.mirror.removeTarget(LIB, true)).rejects.toThrow(
      "1 original couldn't be restored",
    );

    expect(device.mirror.status(LIB)).toMatchObject({ configured: true, path: device.backupRoot });
    expect(device.mirror.status(LIB)).toMatchObject({
      last_restore_report: { outcome: 'partial', restored: 0 },
    });
  });

  it('leaves no partial copies behind on a folder it stops backing up to', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    mkdirSync(backupStagingDir(device.backupRoot));
    writeFileSync(backupStagePath(device.backupRoot, 'p1'), 'RAW');

    await device.mirror.removeTarget(LIB, false);

    expect(existsSync(backupStagingDir(device.backupRoot))).toBe(false);
  });

  it('counts only restored originals as fetched while a restore runs', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    addPhoto(device, 'p2', 'trip/two.arw', 'RAW-two', '2026-01-02T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    rmSync(path.join(device.backupRoot, 'trip/two.arw'));
    const seen: FetchBackProgress[] = [];
    device.transfers.onChanged(() => {
      const progress = device.mirror.fetchBackProgress(LIB);
      if (progress != null) seen.push(progress);
    });

    await expect(device.mirror.removeTarget(LIB, true)).rejects.toThrow(
      "1 original couldn't be restored",
    );

    expect(seen.at(-1)).toMatchObject({ done: 1, total: 2, failed: 1 });
    expect(device.mirror.status(LIB)).toMatchObject({ last_restore_report: { restored: 1 } });
  });
});
