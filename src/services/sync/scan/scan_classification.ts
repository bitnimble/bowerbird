import { Logger } from '../../../logger';
import type { Library } from '../../../schemas/libraries';
import { shootContains } from '../../../utils/shoots';
import type { AlbumsRepository } from '../../albums/albums_repository';
import { buildDiff, detectMoves, type AddedEntry, type LibraryDiff, type MoveEntry, type MoveResult } from './scan_diff';
import type { ScanBatch } from './scan_batch';
import type { ScanFileReader } from './scan_file_reader';
import type { CollectedEvidence } from './scan_evidence';
import type { ScanReconciler } from './scan_reconciler';
import { detectShootRelocations, type ShootRelocation } from './scan_relocations';
import type { ScanTiles } from './scan_tiles';

const log = new Logger('scan');

export interface ClassifiedScan {
  present: Set<string>;
  livePresent: Set<string>;
  diff: LibraryDiff;
  result: MoveResult;
  imported: AddedEntry[];
  relocations: ShootRelocation[];
  moves: MoveEntry[];
  relocatedPath: (filePath: string) => string;
  nowUtc: string;
}



  export async function readAndClassify(
  dependencies: { fileReader: ScanFileReader; albums: AlbumsRepository; reconciler: ScanReconciler },
  input: {
    libraryId: string;
    library: Library;
    scopePaths: readonly string[] | null;
    token: AbortController;
    startedAt: number;
    keepLease: () => void;
    tiles: ScanTiles;
    batch: ScanBatch;
    evidence: CollectedEvidence;
  },
): Promise<ClassifiedScan> {
  const { fileReader, albums, reconciler } = dependencies;
  const { libraryId, library, scopePaths, token, startedAt, keepLease, tiles, batch, evidence } = input;

    const { binned, dbPhotos, files, binRoot, binFolder, binFiles, byIdentity, onDisk } = evidence;
    const { present, changed, failed } = await fileReader.scanFiles(
      // Binned files included, so `dbByPath` covers them and the unchanged test
      // answers correctly: nothing binned is opened or hashed unless it changed.
      [...files, ...binFiles],
      [...dbPhotos, ...binned],
      token.signal,
      (scanned, toScan) => batch.reportScan(scanned, toScan),
      // The resumable first-scan path inserts every file it is handed as a new
      // live photograph, which a file under the bin is not (§9.1.1). A library
      // with rows, with binned rows, or with anything already in its bin takes
      // the ordinary diff instead.
      dbPhotos.length === 0 && binned.length === 0 && binFiles.length === 0
        ? (files) => batch.insertBatch(files)
        : null,
      keepLease,
      tiles.stageFor(library),
    );
    log.info('scan done', {
      library: libraryId,
      files: present.size,
      rows: dbPhotos.length,
      binned: binned.length,
      // The files whose stat changed, so the scan opened and hashed them; the
      // rest cost a stat each. This is what a slow scan's time went on.
      opened: changed.length + batch.added,
      unreadable: failed.size,
      ms: Date.now() - startedAt,
    });

    // Partitioned here rather than after the scan, which would throw away work
    // already paid for: with `dbByPath` from the live rows alone every binned
    // file looks new, and 100k binned RAWs would decode 100k RAW headers nightly.
    const binPaths = new Set(binned.map((p) => p.file_path));
    const isBinSide = (filePath: string): boolean => binPaths.has(filePath) || (binRoot != null && shootContains(binRoot, filePath));
    const livePresent = new Set([...present].filter((p) => !isBinSide(p)));
    const binPresent = new Set([...present].filter(isBinSide));
    const liveChanged = changed.filter((c) => !isBinSide(c.filePath));
    const binChanged = changed.filter((c) => isBinSide(c.filePath));

    // A row binned **in place** (§12.1) is not in the bin, so the bin's walk is not
    // the walk that answers for it - the live one is, its file being in the live
    // tree. Split rather than lumped in with the bin-resident rows: diffed
    // against the bin walk it would be absent from it every time and go
    // `is_missing`, and left out of both it would be invisible to a folder
    // rename the inode cannot follow, whose file then imports as a second, live
    // photograph.
    const inPlace = binned.filter((row) => binFolder == null || !shootContains(binFolder, row.file_path));
    const resident = binned.filter((row) => binFolder != null && shootContains(binFolder, row.file_path));
    const inPlacePaths = new Set(inPlace.map((row) => row.file_path));

    const live = buildDiff(dbPhotos, livePresent, liveChanged, failed);
    // On a scoped run both halves are discarded rather than diffed: there was no
    // walk to be an absence from.
    const empty = { removed: [], added: [], modified: [], reappeared: [] };
    const bin = binRoot == null ? empty : buildDiff(resident, binPresent, binChanged, failed, 'bin');
    // The whole `present` set, since these rows are claimed anywhere in the live
    // tree, and only their own `changed` entries: an addition from the live walk
    // is the live channel's, and handing this one the rest would make every new
    // photograph a bin-side addition.
    const loose =
      scopePaths != null
        ? empty
        : buildDiff(inPlace, present, changed.filter((c) => inPlacePaths.has(c.filePath)), failed, 'bin');
    const diff = {
      removed: [...live.removed, ...bin.removed, ...loose.removed],
      added: [...live.added, ...bin.added, ...loose.added],
      modified: [...live.modified, ...bin.modified, ...loose.modified],
      reappeared: [...live.reappeared, ...bin.reappeared, ...loose.reappeared],
    };
    const result = detectMoves(diff, (id) => albums.getAlbumIdsForPhoto(id).length > 0);
    // A path test beats a hash test for the crossings §9.1.1 can still see: a file
    // copied into the bin and the original deleted, or touched on the way, has a
    // different mtime and so a different hash.
    const imported = reconciler.pairByPath(result, binRoot);

    // Whole-folder moves are resolved before anything per-photo. A shoot folder
    // renamed outside the app shows up as one move per frame it holds, and
    // relocating the shoot answers all of them at once: the photos keep their
    // position inside the folder, so their paths shift by a prefix and their
    // shoot membership does not change at all. What is left is the moves that
    // are genuinely about individual files.
    //
    // The inode answered first and exactly, above (§9.4.1); the photos answer
    // the cases it cannot see, which is any move that minted a new inode -
    // across a filesystem, or a whole library restored from a backup.
    const settled = new Set(byIdentity.map((r) => r.shootId));
    const claimed = new Set(byIdentity.map((r) => r.newFolderPath));
    const relocations = [
      ...byIdentity,
      // Two shoots cannot occupy one folder, so a guess at a folder the inode
      // has already spoken for is wrong by construction.
      ...detectShootRelocations(
        batch.shoots.filter((shoot) => !settled.has(shoot.id)),
        result.moves,
        dbPhotos,
        onDisk,
      ).filter((r) => !claimed.has(r.newFolderPath)),
    ]
      // Deepest first, because each one rewrites its whole subtree by prefix.
      // Rename a folder and its child in one window and applying the parent
      // first would move the child's photos to a path the child's own rewrite
      // then fails to match, leaving rows pointing at a file that is not there
      // while `is_missing` still reads 0.
      .sort((a, b) => b.oldFolderPath.split('/').length - a.oldFolderPath.split('/').length);
    // Where a path the scan saw ends up once the relocations below have been
    // applied by prefix.
    const relocatedPath = (filePath: string): string => {
      const moved = relocations.find((r) => shootContains(r.oldFolderPath, filePath));
      return moved == null ? filePath : moved.newFolderPath + filePath.slice(moved.oldFolderPath.length);
    };
    const relocatedFolders = relocations.map((r) => r.oldFolderPath);
    const moves = result.moves.filter((mv) => !relocatedFolders.some((folder) => shootContains(folder, mv.oldFilePath)));

    batch.relocateShoots(relocations);
    const nowUtc = new Date().toISOString();

    return { present, livePresent, diff, result, imported, relocations, moves, relocatedPath, nowUtc };
  
}
