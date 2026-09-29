import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ScanLeases } from '../scan_leases';
import { LIB, makeLibrary, type Peer, put, roots } from './scan_service_test_helpers';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a missing library root', () => {
  it('keeps every shoot when the root disappears during the walk and returns', async () => {
    let restore = (): void => {};
    const peer = makeLibrary({ pendingMoves: () => { restore(); return []; } });
    put(peer, 'A/a.arw', 'A');
    put(peer, 'B/b.arw', 'B');
    await peer.scan.scanLibrary(LIB);
    for (const original of peer.photoScan.listForScan(LIB)) {
      peer.photoPaths.markDeleted(original.id, original.file_path);
    }
    const before = peer.shoots.listIdentities(LIB);
    expect(before).toHaveLength(2);
    const renamed = `${peer.root}-renamed`;
    roots.push(renamed);
    restore = () => {
      renameSync(renamed, peer.root);
      restore = () => {};
    };
    const keeper = ScanLeases.prototype.keeper;
    const duringWalk = spyOn(ScanLeases.prototype, 'keeper').mockImplementation(function(this: ScanLeases, libraryId, owner) {
      const keepLease = keeper.call(this, libraryId, owner);
      let entered = 0;
      return () => {
        keepLease();
        if (++entered === 2) renameSync(peer.root, renamed);
      };
    });
    try {
      await peer.scan.scanLibrary(LIB);
    } finally {
      duringWalk.mockRestore();
      if (existsSync(renamed) && !existsSync(peer.root)) renameSync(renamed, peer.root);
    }

    expect(existsSync(peer.root)).toBe(true);
    expect(peer.shoots.listIdentities(LIB)).toEqual(before);
  });

  it('marks originals missing when the root has become a file', async () => {
    const peer = makeLibrary();
    put(peer, 'top.arw');
    await peer.scan.scanLibrary(LIB);
    rmSync(peer.root, { recursive: true });
    writeFileSync(peer.root, 'not a directory');

    const missing = await peer.scan.scanLibrary(LIB);

    expect(missing.photos_removed).toBe(1);
    expect(peer.db.query('SELECT is_missing FROM photos').all()).toEqual([{ is_missing: 1 }]);
    expect(statSync(peer.root).isFile()).toBe(true);
  });

  it('leaves originals unchanged when the root cannot be read', async () => {
    const peer = makeLibrary();
    put(peer, 'top.arw');
    await peer.scan.scanLibrary(LIB);
    rmSync(peer.root, { recursive: true });
    symlinkSync(peer.root, peer.root);

    await expect(peer.scan.scanLibrary(LIB)).rejects.toThrow('ELOOP');

    expect(peer.db.query('SELECT is_missing FROM photos').all()).toEqual([{ is_missing: 0 }]);
    expect(peer.scan.getScanStatus(LIB).status).toBe('idle');
  });

  it('marks originals missing when an ancestor of the root has become a file', async () => {
    const peer = makeLibrary();
    put(peer, 'top.arw', 'top');
    put(peer, 'Bin/binned.arw', 'binned');
    await peer.scan.scanLibrary(LIB);
    const ancestor = path.dirname(peer.root);
    rmSync(ancestor, { recursive: true });
    writeFileSync(ancestor, 'not a directory');

    const missing = await peer.scan.scanLibrary(LIB);

    expect(missing.photos_removed).toBe(1);
    expect(missing.photos_modified).toBe(1);
    expect(peer.db.query('SELECT is_missing FROM photos ORDER BY id').all()).toEqual([
      { is_missing: 1 }, { is_missing: 1 },
    ]);
    expect(statSync(ancestor).isFile()).toBe(true);
  });
});

describe('which shoots a full scan removes', () => {
  const shootPaths = (peer: Peer): string[] => peer.shoots.listByLibrary(LIB).map((s) => s.folder_path).sort();

  it.each(['.cache', 'Excluded'])('drops a removed shoot beside a dangling out-of-scope link named %s', async (link) => {
    const peer = makeLibrary();
    put(peer, 'Trip/a.arw');
    await peer.scan.scanLibrary(LIB);
    expect(shootPaths(peer)).toEqual(['Trip']);

    rmSync(path.join(peer.root, 'Trip'), { recursive: true });
    peer.db.query('DELETE FROM photos').run();
    peer.rules.set(LIB, 'Excluded', 'excluded');
    symlinkSync(path.join(peer.root, 'Absent'), path.join(peer.root, link));
    await peer.scan.scanLibrary(LIB);

    expect(shootPaths(peer)).toEqual([]);
  });
});
