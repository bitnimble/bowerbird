import { existsSync } from 'node:fs';
import { AppError } from '../../../errors';
import { Logger } from '../../../logger';
import type { Library } from '../../../schemas/libraries';
import { shootContains } from '../../../utils/shoots';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import type { AddedEntry, DiskFile } from './scan_diff';
import type { CollectedEvidence } from './scan_evidence';
import type { ScanLeases } from './scan_leases';
import { photoFolders, type ScanReconciler } from './scan_reconciler';
import type { ShootRelocation } from './scan_relocations';
import { idleScanStatus, type ScanStatus } from './scan_status';

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
  private readonly scoped: boolean;
  added = 0;
  importedEdits = 0;
  private readonly awaitingSidecars: { id: string; filePath: string }[] = [];
  private mirrored = false;
  private rate: number | null = null;
  private committedAt: number | null = null;

  constructor(
    readonly libraryId: string,
    readonly library: Library,
    readonly owner: string,
    scopePaths: readonly string[] | null,
    private readonly startedAt: number,
    private readonly keepLease: () => void,
    private readonly evidence: CollectedEvidence,
    private readonly libraries: LibrariesRepository,
    shoots: ShootsRepository,
    private readonly reconciler: ScanReconciler,
    private readonly leases: ScanLeases,
    private readonly sidecars: SidecarImporter,
    private readonly status: ScanStatus,
  ) {
    // Mutex holds them still for whole run (§9.9).
    this.shoots = shoots.listFolders(libraryId);
    // Deepest ancestor lookup replaces a scan of every shoot per photo.
    this.byFolder = new Map(this.shoots.map((shoot) => [shoot.folder_path, shoot.id]));
    this.scoped = scopePaths != null;
    // Full runs hand processing whole library; scoped runs retain only touched ids.
    this.touched = this.scoped ? [] : null;
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
    // Until the first commit, so the first batch is timed from the end of the stat pass.
    if (this.added === 0) this.committedAt = Date.now();
    this.status.set(this.libraryId, {
      ...idleScanStatus(this.libraryId, 'processing'),
      photos_to_scan: toScan,
      photos_scanned: scanned,
      photos_per_second: this.rate,
    });
    if (scanned > 0 && scanned % SCAN_PROGRESS_EVERY === 0) {
      log.info('scanning', {
        library: this.libraryId,
        scanned,
        of: toScan,
        ms: Date.now() - this.startedAt,
      });
    }
  }

  insertPhoto(entry: AddedEntry, addedAt: string): string {
    const id = this.reconciler.insertAdded(
      this.libraryId,
      entry,
      this.shootFor(entry.filePath),
      addedAt,
    );
    this.touched?.push(id);
    this.awaitingSidecars.push({ id, filePath: entry.filePath });
    return id;
  }

  // Lightroom edits are imported only for rows this run inserted, after commit and before
  // processing count. File I/O inside insert transaction would hold write lock per photo.
  importSidecars(): void {
    if (this.awaitingSidecars.length === 0) return;
    this.importedEdits += this.sidecars.importFor(this.library.root_path, this.awaitingSidecars);
    this.awaitingSidecars.length = 0;
  }

  // An import commits additions in batches, so a killed one resumes where it reached.
  // Only a run that found every row's file qualifies: otherwise an addition can be a move's far half.
  insertBatch(files: readonly DiskFile[]): void {
    if (!this.libraries.has(this.libraryId)) {
      throw new AppError('NOT_FOUND', `library not found: ${this.libraryId}`);
    }
    this.keepLease();
    const batchAt = new Date().toISOString();
    this.leases.applyOwned(this.libraryId, this.owner, () => {
      if (!this.mirrored) this.mirrorShootFolders();
      for (const file of files) {
        this.insertPhoto(
          {
            filePath: file.filePath,
            fileHash: file.hash,
            metadata: file.metadata,
            channel: 'live',
          },
          batchAt,
        );
      }
    });
    this.importSidecars();
    this.added += files.length;
    const now = Date.now();
    const seconds = (now - (this.committedAt ?? now)) / 1000;
    if (seconds > 0) this.rate = files.length / seconds;
    this.committedAt = now;
  }

  private mirrorShootFolders(): void {
    this.mirrored = true;
    const { files, dirs, binSide, byIdentity } = this.evidence;
    this.relocateShoots(byIdentity);
    const live = files
      // A watcher names paths without statting them, and a vanished one would mirror its folder.
      .filter((file) => !binSide(file.relPath) && (!this.scoped || existsSync(file.absPath)))
      .map((file) => file.relPath);
    const created = this.reconciler.mirrorShootFolders(
      this.library,
      this.shoots,
      dirs,
      photoFolders(live),
    );
    for (const [folder, id] of created) {
      this.shoots.push({ id, folder_path: folder, photo_count: 0 });
      this.byFolder.set(folder, id);
    }
  }

  relocateShoots(relocations: readonly ShootRelocation[]): void {
    for (const relocation of relocations) {
      for (const shoot of this.shoots) {
        if (shoot.folder_path === relocation.oldFolderPath)
          shoot.folder_path = relocation.newFolderPath;
        else if (shootContains(relocation.oldFolderPath, shoot.folder_path)) {
          shoot.folder_path =
            relocation.newFolderPath + shoot.folder_path.slice(relocation.oldFolderPath.length);
        }
      }
    }
    if (relocations.length === 0) return;
    this.byFolder.clear();
    for (const shoot of this.shoots) this.byFolder.set(shoot.folder_path, shoot.id);
  }
}
