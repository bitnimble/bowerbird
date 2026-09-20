import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import type { Library } from '../../../schemas/libraries';
import { shootContains } from '../../../utils/shoots';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import type { AddedEntry, DiskFile } from './scan_diff';
import type { ScanLeases } from './scan_leases';
import type { ScanReconciler } from './scan_reconciler';
import type { ShootRelocation } from './scan_relocations';
import { idleScanStatus, type ScanStatus } from './scan_status';
import type { ScanTiles } from './scan_tiles';

const log = new Logger('scan');
const SCAN_PROGRESS_EVERY = 500;





/**
 * Lightroom's develop settings for the photos a run just inserted.
 *
 * A seam rather than the service, defaulted to nothing, so a scan test is not also a
 * test about XMP - the same shape `ProcessingTrigger` above uses.
 */
export interface SidecarImporter {
  importFor(rootPath: string, photos: readonly { id: string; filePath: string }[]): number;
}



export class ScanBatch {
  readonly shoots: ReturnType<ShootsRepository['listFolders']>;
  readonly byFolder: Map<string, string>;
  readonly touched: string[] | null;
  added = 0;
  importedEdits = 0;
  private readonly awaitingSidecars: { id: string; filePath: string }[] = [];
  private rate: number | null = null;
  private committedAt: number | null = null;

  constructor(
    readonly libraryId: string,
    readonly library: Library,
    readonly owner: string,
    scopePaths: readonly string[] | null,
    private readonly startedAt: number,
    private readonly keepLease: () => void,
    private readonly tiles: ScanTiles,
    private readonly libraries: LibrariesRepository,
    shoots: ShootsRepository,
    private readonly reconciler: ScanReconciler,
    private readonly leases: ScanLeases,
    private readonly sidecars: SidecarImporter,
    private readonly status: ScanStatus,
  ) {
    // Read before the scan: first import places photos as it goes and needs shoots up front.
    // Mutex holds them still for whole run (§9.9).
    this.shoots = shoots.listFolders(libraryId);
    // Deepest ancestor lookup replaces a scan of every shoot per photo.
    this.byFolder = new Map(this.shoots.map((shoot) => [shoot.folder_path, shoot.id]));
    // Full runs hand processing whole library; scoped runs retain only touched ids.
    this.touched = scopePaths != null ? [] : null;
  }

  shootFor(relPath: string): string | null {
    const segments = relPath.split('/');
    let prefix = '';
    let deepest: string | null = null;
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      deepest = this.byFolder.get(prefix) ?? deepest;
    }
    return deepest;
  }

  reportScan(scanned: number, toScan: number): void {
    this.keepLease();
    this.committedAt ??= Date.now();
    this.status.set(this.libraryId, {
      ...idleScanStatus(this.libraryId, 'processing'),
      photos_to_scan: toScan,
      photos_scanned: scanned,
      photos_per_second: this.rate,
    });
    if (scanned > 0 && scanned % SCAN_PROGRESS_EVERY === 0) {
      log.info('scanning', { library: this.libraryId, scanned, of: toScan, ms: Date.now() - this.startedAt });
    }
  }

  insertPhoto(entry: AddedEntry, addedAt: string): string {
    const id = this.reconciler.insertAdded(this.libraryId, entry, this.shootFor(entry.filePath), addedAt);
    this.touched?.push(id);
    this.awaitingSidecars.push({ id, filePath: entry.filePath });
    // Row now has id scan could not know, which is all its staged tile was waiting for.
    // Collected rather than renamed here because this runs inside insert transaction.
    this.tiles.claim(id, entry.stagedTile);
    return id;
  }

  // Lightroom edits are imported only for rows this run inserted, after commit and before
  // processing count. File I/O inside insert transaction would hold write lock per photo.
  importSidecars(): void {
    if (this.awaitingSidecars.length === 0) return;
    this.importedEdits += this.sidecars.importFor(this.library.root_path, this.awaitingSidecars);
    this.awaitingSidecars.length = 0;
  }

  // First scan commits additions in batches, so a killed import resumes where it reached.
  // Only a run with no rows qualifies: against populated library an addition can be move's far half.
  insertBatch(files: readonly DiskFile[]): void {
    if (!this.libraries.getById(this.libraryId)) {
      throw new AppError('NOT_FOUND', `library not found: ${this.libraryId}`);
    }
    this.keepLease();
    const batchAt = new Date().toISOString();
    this.leases.applyOwned(this.libraryId, this.owner, () => {
      for (const file of files) {
        this.insertPhoto(
          {
            filePath: file.filePath,
            fileHash: file.hash,
            metadata: file.metadata,
            channel: 'live',
            stagedTile: file.stagedTile,
          },
          batchAt,
        );
      }
    });
    this.importSidecars();
    this.tiles.adopt();
    this.added += files.length;
    const now = Date.now();
    const seconds = (now - (this.committedAt ?? now)) / 1000;
    if (seconds > 0) this.rate = files.length / seconds;
    this.committedAt = now;
  }

  relocateShoots(relocations: readonly ShootRelocation[]): void {
    for (const relocation of relocations) {
      for (const shoot of this.shoots) {
        if (shoot.folder_path === relocation.oldFolderPath) shoot.folder_path = relocation.newFolderPath;
        else if (shootContains(relocation.oldFolderPath, shoot.folder_path)) {
          shoot.folder_path = relocation.newFolderPath + shoot.folder_path.slice(relocation.oldFolderPath.length);
        }
      }
    }
    if (relocations.length === 0) return;
    this.byFolder.clear();
    for (const shoot of this.shoots) this.byFolder.set(shoot.folder_path, shoot.id);
  }
}
