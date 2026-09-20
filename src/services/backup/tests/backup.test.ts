import { afterEach, describe, expect, it } from 'bun:test';
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
import { Cull } from '../cull';
import { Mirror } from '../mirror';
import { PassivePeers } from '../passive_peers';

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
} {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const root = temp('library');
  const backupRoot = temp('folder');
  db.query("INSERT INTO libraries (id, root_path, name, bin_name) VALUES (?, ?, 'Trip', 'Bin')").run(LIB, root);

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
  );
  const mirror = new Mirror(db, libraries, backups, transfers, new Cull(db, transfers));
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
  };
}

function addPhoto(device: ReturnType<typeof makeDevice>, id: string, relPath: string, bytes: string, addedAt: string): void {
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
  });
}

function photoRow(device: ReturnType<typeof makeDevice>, id: string): { is_missing: number; content_hash: string | null } {
  return device.db.query('SELECT is_missing, content_hash FROM photos WHERE id = ?').get(id) as {
    is_missing: number;
    content_hash: string | null;
  };
}

describe('backing a library up to a folder', () => {
  it('copies every original to the folder, and copies nothing the second time', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    addPhoto(device, 'p2', 'trip/two.arw', 'RAW-two', '2026-01-02T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);

    const first = await device.mirror.run(LIB);

    expect(first.copied).toBe(2);
    expect(readFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'utf8')).toBe('RAW-one');
    expect(readFileSync(path.join(device.backupRoot, 'trip/two.arw'), 'utf8')).toBe('RAW-two');
    // The hash exists from the moment bytes first move, and it is what every later check reads.
    expect(photoRow(device, 'p1').content_hash).toMatch(/^[0-9a-f]{64}$/);

    expect((await device.mirror.run(LIB)).copied).toBe(0);
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

    expect(run.copied).toBe(1);
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
    device.db.query("UPDATE photos SET recipe = json_set(recipe, '$.path', 'Bin/one.arw') WHERE id = 'p1'").run();

    const run = await device.mirror.run(LIB);

    expect(run.moved).toBe(1);
    expect(run.copied).toBe(0);
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
    expect(device.backups.entry(LIB, device.backups.holders(LIB, 'p1')[0]!, 'p1')?.rel_path).toBe('trip/one.arw');
    expect(photoRow(device, 'p1').content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await device.mirror.run(LIB)).copied).toBe(0);
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
    expect(readFileSync(path.join(device.backupRoot, 'trip/one.arw'), 'utf8')).toBe('SOMEBODY-ELSES-FILE');
    expect(readFileSync(path.join(device.root, 'trip/one.arw'), 'utf8')).toBe('RAW-one');
    expect(device.backups.holders(LIB, 'p1')).toEqual([]);
  });

  it('refuses a folder this catalogue already backs another library up to', async () => {
    const device = makeDevice();
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.db.query("INSERT INTO libraries (id, root_path, name, bin_name) VALUES ('library2', ?, 'Other', 'Bin')").run(
      temp('other-library'),
    );

    await expect(device.mirror.setTarget('library2', device.backupRoot)).rejects.toThrow(/already the backup folder/);
  });

  // The same folder, reached by a catalogue that knows nothing about it: a drive carried to
  // another machine, or a library re-added after a restore. Its own marker is the only evidence
  // of what it holds, and it is what stops two libraries writing into one tree.
  it('refuses a folder whose marker names another library', async () => {
    const device = makeDevice();
    const taken = temp('taken');
    writeFileSync(
      path.join(taken, '.bowerbird-backup.json'),
      JSON.stringify({ library_id: 'elsewhere1234567', library_name: 'Reef', peer_id: 'abcdefghij123456' }),
    );

    await expect(device.mirror.setTarget(LIB, taken)).rejects.toThrow(/backup of another library/);
  });

  it('refuses a folder inside the library it is backing up', async () => {
    const device = makeDevice();

    await expect(device.mirror.setTarget(LIB, path.join(device.root, 'backup'))).rejects.toThrow(/cannot be inside/);
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

    expect(run.offloaded).toBe(1);
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

    expect(run.offloaded).toBe(0);
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

    await expect(device.mirror.run(LIB)).rejects.toThrow(device.backupRoot);

    expect(existsSync(path.join(device.root, 'trip/one.arw'))).toBe(true);
    expect(device.mirror.status(LIB)?.last_error).toMatch(/not there/);
  });
});

describe('a photo with no local copy', () => {
  it('is found again when the same folder is paired back', async () => {
    const device = makeDevice();
    addPhoto(device, 'p1', 'trip/one.arw', 'RAW-one', '2026-01-01T00:00:00.000Z');
    await device.mirror.setTarget(LIB, device.backupRoot);
    device.mirror.setBudget(LIB, 1);
    await device.mirror.run(LIB);
    await device.mirror.removeTarget(LIB);
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
