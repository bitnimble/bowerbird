import type { FileMetadata } from '../../processing/metadata';
import { buildDiff, detectMoves } from '../sync_algorithm';
import type { DbPhoto, DiskFile, LibraryDiff } from '../sync_algorithm';

const META = {} as FileMetadata;
const disk = (filePath: string, hash: string): DiskFile => ({ filePath, hash, metadata: META });
const db = (id: string, file_path: string, file_hash: string | null, is_missing = false): DbPhoto => ({
  id,
  file_path,
  file_hash,
  is_missing,
});
const noAlbums = () => false;

const present = (...paths: string[]) => new Set(paths);

describe('buildDiff', () => {
  it('classifies added, removed, modified, and unchanged (a.arw unchanged, so not opened)', () => {
    // a.arw is present but unchanged -> omitted from `changed` (never opened).
    const diff = buildDiff(
      [db('p1', 'a.arw', 'h1'), db('p2', 'b.arw', 'h2'), db('p3', 'c.arw', 'h3')],
      present('a.arw', 'b.arw', 'd.arw'),
      [disk('b.arw', 'hX'), disk('d.arw', 'h4')],
    );
    expect(diff.removed.map((r) => r.photoId)).toEqual(['p3']);
    expect(diff.modified.map((m) => [m.photoId, m.oldHash, m.newHash])).toEqual([['p2', 'h2', 'hX']]);
    expect(diff.added.map((a) => a.filePath)).toEqual(['d.arw']);
    expect(diff.reappeared).toEqual([]);
  });

  it('flags a present-but-unchanged file that was missing as reappeared (not re-opened)', () => {
    const diff = buildDiff([db('p1', 'a.arw', 'h1', true)], present('a.arw'), []);
    expect(diff.reappeared).toEqual([{ photoId: 'p1' }]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it('leaves a present-but-unreadable (extract-failed) missing file untouched, not reappeared', () => {
    const diff = buildDiff([db('p1', 'a.arw', 'h1', true)], present('a.arw'), [], new Set(['a.arw']));
    expect(diff.reappeared).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
  });
});

describe('detectMoves', () => {
  it('pairs a removed and added file with the same hash as one move', () => {
    const diff = buildDiff([db('p1', 'old/a.arw', 'h1')], present('new/a.arw'), [disk('new/a.arw', 'h1')]);
    const result = detectMoves(diff, noAlbums);
    expect(result.moves).toEqual([{ photoId: 'p1', oldFilePath: 'old/a.arw', newFilePath: 'new/a.arw', fileHash: 'h1' }]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('duplicate handling: 3 removed + 1 added of one hash = 1 move + 2 removals', () => {
    const diff: LibraryDiff = {
      removed: [
        { photoId: 'p1', filePath: 'x1.arw', fileHash: 'h', wasMissing: false },
        { photoId: 'p2', filePath: 'x2.arw', fileHash: 'h', wasMissing: false },
        { photoId: 'p3', filePath: 'x3.arw', fileHash: 'h', wasMissing: false },
      ],
      added: [{ filePath: 'y.arw', fileHash: 'h', metadata: META }],
      modified: [],
      reappeared: [],
    };
    const result = detectMoves(diff, noAlbums);
    expect(result.moves).toHaveLength(1);
    expect(result.removed).toHaveLength(2);
    expect(result.added).toHaveLength(0);
  });

  it('album bias: keeps the album member as the move, non-album as the removal', () => {
    const diff: LibraryDiff = {
      removed: [
        { photoId: 'notInAlbum', filePath: 'x1.arw', fileHash: 'h', wasMissing: false },
        { photoId: 'inAlbum', filePath: 'x2.arw', fileHash: 'h', wasMissing: false },
      ],
      added: [{ filePath: 'y.arw', fileHash: 'h', metadata: META }],
      modified: [],
      reappeared: [],
    };
    const result = detectMoves(diff, (id) => id === 'inAlbum');
    expect(result.moves.map((m) => m.photoId)).toEqual(['inAlbum']);
    expect(result.removed.map((r) => r.photoId)).toEqual(['notInAlbum']);
  });

  it('modified+added-with-old-hash: the addition becomes a new photo, not a move', () => {
    // A modified in place (h1 -> h2); B added carrying the original h1.
    const diff: LibraryDiff = {
      removed: [{ photoId: 'pRemoved', filePath: 'gone.arw', fileHash: 'h1', wasMissing: false }],
      added: [{ filePath: 'B.arw', fileHash: 'h1', metadata: META }],
      modified: [{ photoId: 'pA', filePath: 'A.arw', oldHash: 'h1', newHash: 'h2', metadata: META, wasMissing: false }],
      reappeared: [],
    };
    const result = detectMoves(diff, noAlbums);
    // h1 is reserved by the modified entry, so no move is made from it.
    expect(result.moves).toEqual([]);
    expect(result.added.map((a) => a.filePath)).toEqual(['B.arw']);
    expect(result.removed.map((r) => r.photoId)).toEqual(['pRemoved']);
    expect(result.modified.map((m) => m.photoId)).toEqual(['pA']);
  });

  it('reserves only one added entry per modified file, pairing the rest as moves', () => {
    // P1 modified h1->h2; two files carry h1: one is the relocated original (a new
    // photo), the other is the move destination of removed P2.
    const diff: LibraryDiff = {
      removed: [{ photoId: 'p2', filePath: 'gone.arw', fileHash: 'h1', wasMissing: false }],
      added: [
        { filePath: 'B.arw', fileHash: 'h1', metadata: META },
        { filePath: 'C.arw', fileHash: 'h1', metadata: META },
      ],
      modified: [{ photoId: 'p1', filePath: 'A.arw', oldHash: 'h1', newHash: 'h2', metadata: META, wasMissing: false }],
      reappeared: [],
    };
    const result = detectMoves(diff, noAlbums);
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.photoId).toBe('p2');
    expect(result.added).toHaveLength(1); // exactly one addition reserved as a new photo
    expect(result.removed).toHaveLength(0);
  });

  it('matches a previously-missing record against a reappearance at a new path', () => {
    const diff = buildDiff([db('p1', 'old.arw', 'h1', true)], present('new.arw'), [disk('new.arw', 'h1')]);
    const result = detectMoves(diff, noAlbums);
    expect(result.moves).toEqual([{ photoId: 'p1', oldFilePath: 'old.arw', newFilePath: 'new.arw', fileHash: 'h1' }]);
  });
});
