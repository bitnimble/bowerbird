import { describe, it, expect } from 'bun:test';
import type { ScannedDir } from '../../../../utils/scan';
import type { MoveEntry } from '../scan_diff';
import { detectRelocationsByIdentity, detectShootRelocations, findBinByIdentity } from '../scan_relocations';

// The half of following a renamed bin that needs no filesystem. A bind mount of
// the bin elsewhere under the root and a hardlinked directory both arrive here as
// nothing but two ScannedDirs sharing a dev:ino - which is why this is worth
// having apart from the IO, since neither can be staged without root.
describe('findBinByIdentity', () => {
  const dir = (relPath: string, ino: number, dev = 1): ScannedDir => ({ relPath, dev, ino, birthtimeMs: 0 });
  const bin = { dev: 1, ino: 42 };

  it('finds the one directory carrying the identity, under whatever name', () => {
    const found = findBinByIdentity([dir('Trip', 7), dir('Rubbish', 42)], bin);
    expect(found).toEqual({ kind: 'one', target: dir('Rubbish', 42) });
  });

  // Following either would rewrite `bin_name` onto it and re-prefix every binned
  // row into it, after which that folder's live photographs read as removed.
  it('refuses two directories sharing the identity, and names both', () => {
    const found = findBinByIdentity([dir('Bin', 42), dir('mirror-of-bin', 42)], bin);
    expect(found).toEqual({ kind: 'ambiguous', candidates: ['Bin', 'mirror-of-bin'] });
  });

  // `getBinPath` joins a single name, so a bin one folder deep cannot even be
  // expressed - a constraint inherited from `BinNameSchema`.
  it('refuses a nested candidate', () => {
    expect(findBinByIdentity([dir('Trip/Rubbish', 42)], bin)).toEqual({ kind: 'ambiguous', candidates: ['Trip/Rubbish'] });
  });

  // The device is half the key: inode numbers repeat across filesystems, so a
  // card reader mounted inside the library would otherwise match.
  it('does not match the same inode on another device', () => {
    expect(findBinByIdentity([dir('Rubbish', 42, 2)], bin)).toEqual({ kind: 'none' });
  });

  it('answers nothing when there is nothing recorded to match', () => {
    expect(findBinByIdentity([dir('Rubbish', 42)], null)).toEqual({ kind: 'none' });
    expect(findBinByIdentity([dir('Rubbish', 42)], { dev: 1, ino: null })).toEqual({ kind: 'none' });
    // Some filesystems report 0, and treating that as a key would match anything
    // else that reports it.
    expect(findBinByIdentity([dir('Rubbish', 0)], { dev: 1, ino: 0 })).toEqual({ kind: 'none' });
  });
});

describe('detectShootRelocations', () => {
  const shoot = (id: string, folder_path: string) => ({ id, folder_path });
  const move = (oldFilePath: string, newFilePath: string): MoveEntry => ({
    photoId: oldFilePath,
    oldFilePath,
    newFilePath,
    fileHash: 'h',
  });
  const photos = (...paths: string[]) => paths.map((file_path) => ({ file_path }));
  // The folder being gone is the usual case under test; the ones that care pass
  // their own predicate.
  const detect = (
    shoots: Parameters<typeof detectShootRelocations>[0],
    moves: Parameters<typeof detectShootRelocations>[1],
    dbPhotos: Parameters<typeof detectShootRelocations>[2],
    folderStillOnDisk: Parameters<typeof detectShootRelocations>[3] = () => false,
  ) => detectShootRelocations(shoots, moves, dbPhotos, folderStillOnDisk);

  it('infers the new folder when every photo under it moved, keeping its position', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC/a.arw', 'NewYork/a.arw'), move('NYC/b.arw', 'NewYork/b.arw')],
      photos('NYC/a.arw', 'NYC/b.arw'),
    );
    expect(relocations).toEqual([{ shootId: 's1', oldFolderPath: 'NYC', newFolderPath: 'NewYork' }]);
  });

  it('infers a move to a different depth, not just a rename in place', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC/a.arw', 'Archive/2024/NYC/a.arw')],
      photos('NYC/a.arw'),
    );
    expect(relocations).toEqual([{ shootId: 's1', oldFolderPath: 'NYC', newFolderPath: 'Archive/2024/NYC' }]);
  });

  // The whole point of the all-or-nothing rule: a partial move is ambiguous, so
  // the shoot is left alone for the user to resolve rather than guessed at.
  it('declines when one photo stayed behind', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC/a.arw', 'NewYork/a.arw')],
      photos('NYC/a.arw', 'NYC/b.arw'),
    );
    expect(relocations).toEqual([]);
  });

  it('declines when the photos scattered to different folders', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC/a.arw', 'NewYork/a.arw'), move('NYC/b.arw', 'Elsewhere/b.arw')],
      photos('NYC/a.arw', 'NYC/b.arw'),
    );
    expect(relocations).toEqual([]);
  });

  // Not a reshuffle: the folder holding every photo is now NewYork/sub, which is
  // exactly what a move into a subfolder looks like from the photos' side.
  it('treats a move deeper as a move, when every photo goes with it', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC/a.arw', 'NewYork/sub/a.arw'), move('NYC/b.arw', 'NewYork/sub/b.arw')],
      photos('NYC/a.arw', 'NYC/b.arw'),
    );
    expect(relocations).toEqual([{ shootId: 's1', oldFolderPath: 'NYC', newFolderPath: 'NewYork/sub' }]);
  });

  it('declines when the photos landed at different depths, which is a reshuffle', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC/a.arw', 'NewYork/a.arw'), move('NYC/b.arw', 'NewYork/sub/b.arw')],
      photos('NYC/a.arw', 'NYC/b.arw'),
    );
    expect(relocations).toEqual([]);
  });

  it('declines a target another shoot already owns', () => {
    const relocations = detect(
      [shoot('s1', 'NYC'), shoot('s2', 'NewYork')],
      [move('NYC/a.arw', 'NewYork/a.arw')],
      photos('NYC/a.arw'),
    );
    expect(relocations).toEqual([]);
  });

  it('says nothing about an empty shoot, which offers no evidence either way', () => {
    expect(detect([shoot('s1', 'NYC')], [], [])).toEqual([]);
  });

  // A nested shoot's own photos prove its own move, so each is inferred
  // independently and lands at the right place without a cascade.
  it('relocates a parent and its nested shoot from their own photos', () => {
    const relocations = detect(
      [shoot('s1', 'Trip'), shoot('s2', 'Trip/Day1')],
      [move('Trip/a.arw', 'Vacation/a.arw'), move('Trip/Day1/b.arw', 'Vacation/Day1/b.arw')],
      photos('Trip/a.arw', 'Trip/Day1/b.arw'),
    );
    expect(relocations).toEqual([
      { shootId: 's1', oldFolderPath: 'Trip', newFolderPath: 'Vacation' },
      { shootId: 's2', oldFolderPath: 'Trip/Day1', newFolderPath: 'Vacation/Day1' },
    ]);
  });

  // Sorting a shoot's frames into a new subfolder moves every one of them and
  // keeps each filename, so by the paths alone it is identical to a rename. The
  // shoot's folder still being on disk is the only thing that tells them apart.
  it('declines when the photos moved into a subfolder of a folder that still exists', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC/a.arw', 'NYC/Selects/a.arw'), move('NYC/b.arw', 'NYC/Selects/b.arw')],
      photos('NYC/a.arw', 'NYC/b.arw'),
      (folder) => folder === 'NYC',
    );
    expect(relocations).toEqual([]);
  });

  it('declines a folder that is still on disk even when every photo left it', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC/a.arw', 'Elsewhere/a.arw')],
      photos('NYC/a.arw'),
      () => true,
    );
    expect(relocations).toEqual([]);
  });

  it('does not mistake a sibling folder for the shoot (NYC2 is not under NYC)', () => {
    const relocations = detect(
      [shoot('s1', 'NYC')],
      [move('NYC2/a.arw', 'Other/a.arw')],
      photos('NYC/keep.arw', 'NYC2/a.arw'),
    );
    expect(relocations).toEqual([]);
  });
});

describe('detectRelocationsByIdentity', () => {
  // One device throughout unless a test is about two, which is the ordinary case:
  // a library on one filesystem.
  const shoot = (
    id: string,
    folder_path: string,
    folder_ino: number | null,
    folder_birthtime: number | null = 100,
    folder_dev: number | null = 1,
  ) => ({ id, folder_path, folder_dev, folder_ino, folder_birthtime });
  const dir = (relPath: string, ino: number, birthtimeMs = 100, dev = 1): ScannedDir => ({ relPath, dev, ino, birthtimeMs });
  const detect = (
    shoots: Parameters<typeof detectRelocationsByIdentity>[0],
    dirs: Parameters<typeof detectRelocationsByIdentity>[1],
    folderStillOnDisk: Parameters<typeof detectRelocationsByIdentity>[2] = () => false,
  ) => detectRelocationsByIdentity(shoots, dirs, folderStillOnDisk);

  it('follows the inode to the folder’s new path', () => {
    expect(detect([shoot('s1', 'NYC', 7)], [dir('NewYork', 7)])).toEqual([
      { shootId: 's1', oldFolderPath: 'NYC', newFolderPath: 'NewYork' },
    ]);
  });

  // The case photo evidence structurally cannot see: nothing moved, so there is
  // no other trace of the rename at all.
  it('follows a shoot holding no photos', () => {
    expect(detect([shoot('empty', 'Planned', 9)], [dir('Booked', 9)])).toEqual([
      { shootId: 'empty', oldFolderPath: 'Planned', newFolderPath: 'Booked' },
    ]);
  });

  it('leaves a shoot whose folder is still there', () => {
    expect(detect([shoot('s1', 'NYC', 7)], [dir('NewYork', 7)], () => true)).toEqual([]);
  });

  it('has nothing to match on for a shoot that was never scanned', () => {
    expect(detect([shoot('s1', 'NYC', null, null)], [dir('NewYork', 7)])).toEqual([]);
  });

  // A recycled inode number pointing at an unrelated folder.
  it('refuses a match whose birthtime disagrees', () => {
    expect(detect([shoot('s1', 'NYC', 7, 100)], [dir('Somewhere', 7, 999)])).toEqual([]);
  });

  // Reported as 0 by some filesystems, where rejecting on it would disable the
  // check exactly where the inode is the only evidence there is.
  it('still matches when either side reports no birthtime', () => {
    expect(detect([shoot('s1', 'NYC', 7, 0)], [dir('NewYork', 7, 999)])).toHaveLength(1);
    expect(detect([shoot('s1', 'NYC', 7, 100)], [dir('NewYork', 7, 0)])).toHaveLength(1);
  });

  it('refuses a folder another shoot already holds', () => {
    expect(detect([shoot('s1', 'NYC', 7), shoot('s2', 'NewYork', 8)], [dir('NewYork', 7)])).toEqual([]);
  });

  // Hardlinked directories, or a filesystem recycling numbers within one scan:
  // either way the identification is not one.
  it('refuses an ambiguous match across two folders sharing an inode', () => {
    expect(detect([shoot('s1', 'NYC', 7)], [dir('A', 7), dir('B', 7)])).toEqual([]);
  });

  it('gives one target to at most one shoot', () => {
    const relocations = detect([shoot('s1', 'NYC', 7), shoot('s2', 'LA', 7)], [dir('NewYork', 7)]);
    expect(relocations).toHaveLength(1);
  });

  // Inode numbers repeat across filesystems, so a card reader or a share mounted
  // inside the library would otherwise hand a dead shoot an unrelated folder and
  // rewrite every one of its photos' paths onto the wrong volume.
  it('refuses a match on another device, however well the inode agrees', () => {
    expect(detect([shoot('s1', 'NYC', 7, 100, 1)], [dir('Import/Card', 7, 100, 2)])).toEqual([]);
  });

  it('matches within the device it recorded, alongside a twin inode elsewhere', () => {
    const relocations = detect([shoot('s1', 'NYC', 7, 100, 1)], [dir('Import/Card', 7, 100, 2), dir('NewYork', 7, 100, 1)]);
    expect(relocations).toEqual([{ shootId: 's1', oldFolderPath: 'NYC', newFolderPath: 'NewYork' }]);
  });

  // Recorded before the device was half the key, so the only safe reading is that
  // it is not enough to identify anything.
  it('has nothing to match on for a shoot with no recorded device', () => {
    expect(detect([shoot('s1', 'NYC', 7, 100, null)], [dir('NewYork', 7)])).toEqual([]);
  });
});
