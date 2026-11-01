import { readdir, realpath, stat, statfs } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import { newId } from '../../schemas/id';
import type {
  ImportHeader,
  ImportJob,
  ImportScan,
  StartImportRequest,
} from '../../schemas/imports';
import type { Library } from '../../schemas/libraries';
import type { PhotoFormat } from '../../schemas/photos';
import type { Shoot } from '../../schemas/shoots';
import {
  copyOriginal,
  deleteImportStaging,
  isImportStaging,
  moveOriginal,
} from '../../utils/deletions';
import { ensureDir, numberedName } from '../../utils/files';
import { computeFileHash } from '../../utils/hash';
import { containsPath } from '../../utils/paths';
import { formatOf, isRendered, originalMediaType, scanLibraryTree } from '../../utils/scan';
import type { HeaderMetadata } from '../processing/analysis/metadata';
import { eachInOrder } from '../sync/scan/scan_order';
import type { ScanScope } from '../sync/scan/scan_evidence';

const log = new Logger('import');

const JOB_NAMES_KEPT = 20;
const SCAN_LEASE_RETRIES = 60;
const SCAN_LEASE_RETRY_MS = 1000;
const COARSEST_MTIME_MS = 2000;
const VOLUME_SYSTEM_FOLDERS = new Set(['$RECYCLE.BIN', 'System Volume Information']);

interface HeldFile {
  absPath: string;
  relPath: string;
  format: PhotoFormat;
  size: number;
  mtime: Date;
  hash: string;
}

interface HeldScan {
  id: string;
  files: HeldFile[];
}

export type ImportPicture =
  { kind: 'file'; absPath: string; mediaType: string } | { kind: 'bytes'; bytes: Uint8Array };

function withName(names: string[], name: string): string[] {
  return names.length < JOB_NAMES_KEPT ? [...names, name] : names;
}

export class ImportService {
  private held: HeldScan | null = null;
  private job: ImportJob | null = null;
  private starting = false;
  private stopRequested = false;

  constructor(
    private readonly libraries: { getById(id: string): Library | null; list(): Library[] },
    private readonly shoots: { getById(id: string): Shoot | null },
    private readonly photos: {
      filesHeld(libraryId: string): { file_hash: string; file_path: string }[];
    },
    private readonly scans: {
      scanLibrary(libraryId: string, scope: ScanScope): Promise<unknown>;
    },
    private readonly headers: {
      read(absPath: string): Promise<HeaderMetadata>;
      liftEmbedded(absPath: string): Promise<Uint8Array | null>;
    },
    private readonly concurrency: () => number,
    private readonly announce: (job: ImportJob) => void,
  ) {}

  async scan(source: string): Promise<ImportScan> {
    const root = path.resolve(source);
    const walked = await scanLibraryTree(
      {
        rootPath: root,
        includeSubfolders: true,
        includeNonRaw: true,
        binName: null,
        excluded: VOLUME_SYSTEM_FOLDERS,
      },
      '',
      undefined,
      undefined,
      true,
    ).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EACCES' || err.code === 'EPERM')
        throw new AppError('VALIDATION_ERROR', `We couldn't read ${root}.`);
      throw err;
    });
    if (walked.files.length === 0 && (await stat(root).catch(() => null)) == null)
      throw new AppError('NOT_FOUND', `We couldn't find ${root}.`);

    const files: HeldFile[] = [];
    await eachInOrder(
      walked.files,
      this.concurrency(),
      (file) => stat(file.absPath),
      (file, outcome) => {
        if (!('value' in outcome)) return;
        const format = formatOf(file.relPath);
        if (format == null) return;
        const { mtime, size } = outcome.value;
        files.push({
          absPath: file.absPath,
          relPath: file.relPath,
          format,
          size,
          mtime,
          hash: computeFileHash(file.absPath, { mtime: mtime.toISOString(), fileSize: size }),
        });
      },
      () => false,
    );

    this.held = { id: newId(), files };
    return {
      id: this.held.id,
      source: root,
      complete: walked.complete,
      files: files.map((file, id) => ({
        id,
        rel_path: file.relPath,
        format: file.format,
        file_size: file.size,
        modified_at: file.mtime.toISOString(),
      })),
    };
  }

  inLibrary(scanId: string, libraryId: string): number[] {
    // With the name as well as the hash: a burst's same-size frames share a card's 2 s timestamps,
    // and hash alone reads the ones not yet copied as held.
    const held = new Set<string>();
    for (const { file_hash, file_path } of this.photos.filesHeld(libraryId)) {
      const name = path.posix.basename(file_path).toLowerCase();
      held.add(`${file_hash}|${name}`);
      // Where a name collision lands it (`numberedName`).
      held.add(`${file_hash}|${name.replace(/_\d+(\.[^.]*)$/, '$1')}`);
    }
    const ids: number[] = [];
    this.heldScan(scanId).files.forEach((file, id) => {
      if (held.has(`${file.hash}|${path.posix.basename(file.relPath).toLowerCase()}`)) ids.push(id);
    });
    return ids;
  }

  async readHeaders(scanId: string, fileIds: readonly number[]): Promise<ImportHeader[]> {
    const held = this.heldScan(scanId);
    return await Promise.all(
      fileIds.map(async (id) => {
        const file = this.heldFile(held, id);
        const header = await this.headers.read(file.absPath).catch(() => null);
        return {
          file_id: id,
          date_taken: header?.dateTaken ?? null,
          camera_model: header?.cameraModel ?? null,
          lens_model: header?.lensModel ?? null,
        };
      }),
    );
  }

  async picture(scanId: string, fileId: number): Promise<ImportPicture> {
    const file = this.heldFile(this.heldScan(scanId), fileId);
    // No browser decoder to hand a HEIF to.
    if (file.format === 'heif') throw new AppError('NOT_FOUND', 'this file has no picture to show');
    if (isRendered(file.relPath))
      return { kind: 'file', absPath: file.absPath, mediaType: originalMediaType(file.relPath) };
    const bytes = await this.headers.liftEmbedded(file.absPath);
    if (bytes == null) throw new AppError('NOT_FOUND', 'this file has no embedded JPEG');
    return { kind: 'bytes', bytes };
  }

  currentJob(): ImportJob | null {
    return this.job;
  }

  async start(request: StartImportRequest): Promise<ImportJob> {
    if (this.starting || this.job?.status === 'copying')
      throw new AppError('CONFLICT', 'Photos are already being added.');
    this.starting = true;
    try {
      const held = this.heldScan(request.scan_id);
      const files = [...new Set(request.file_ids)].map((id) => this.heldFile(held, id));
      const deleteOriginals = request.delete_originals === true;
      if (deleteOriginals) await this.refuseCatalogued(files);
      const dir = await this.destination(request, files);

      this.stopRequested = false;
      const job: ImportJob = {
        id: newId(),
        library_id: request.library_id,
        shoot_id: request.shoot_id,
        status: 'copying',
        total: files.length,
        copied: 0,
        skipped: 0,
        failed: 0,
        failed_names: [],
        deleted: 0,
        kept: 0,
        kept_names: [],
      };
      this.job = job;
      void this.run(job, held.files, new Set(files), dir, deleteOriginals).catch((err: unknown) => {
        log.error('import stopped on an unexpected error', { err: String(err) });
        this.update(job, { status: 'stopped' });
      });
      return job;
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.stopRequested = true;
  }

  // Deleting a library's own file would leave its row, edits, and rating pointing at nothing.
  private async refuseCatalogued(files: HeldFile[]): Promise<void> {
    const roots = await Promise.all(
      this.libraries
        .list()
        .map((library) => realpath(library.root_path).catch(() => library.root_path)),
    );
    for (const file of files) {
      const real = await realpath(file.absPath).catch(() => file.absPath);
      if (roots.some((root) => containsPath(root, real)))
        throw new AppError(
          'VALIDATION_ERROR',
          "These originals are in a library, so we can't delete them.",
        );
    }
  }

  private async destination(request: StartImportRequest, files: HeldFile[]): Promise<string> {
    const library = this.libraries.getById(request.library_id);
    if (library == null)
      throw new AppError('NOT_FOUND', `library not found: ${request.library_id}`);
    if (library.read_only) throw new AppError('READ_ONLY', `${library.name} is read-only.`);
    // Checked rather than created: mkdir on an unplugged drive's mount point lands on the system disk.
    if ((await stat(library.root_path).catch(() => null))?.isDirectory() !== true)
      throw new AppError('NOT_FOUND', `${library.name} isn't connected.`);

    let dir = library.root_path;
    if (request.shoot_id != null) {
      const shoot = this.shoots.getById(request.shoot_id);
      if (shoot == null || shoot.library_id !== library.id)
        throw new AppError('NOT_FOUND', `shoot not found: ${request.shoot_id}`);
      dir = path.join(library.root_path, shoot.folder_path);
      // A shoot row can arrive by replication, so its path isn't this device's to trust.
      if (!containsPath(library.root_path, dir))
        throw new AppError('VALIDATION_ERROR', `shoot is outside the library: ${shoot.id}`);
      await ensureDir(dir);
    }

    const { bavail, bsize } = await statfs(dir);
    const needed = files.reduce((sum, file) => sum + file.size, 0);
    if (Number(bavail) * Number(bsize) < needed)
      throw new AppError('VALIDATION_ERROR', `There isn't enough free space for ${library.name}.`);
    await sweepCrashedCopies(dir);
    return dir;
  }

  private async run(
    job: ImportJob,
    files: readonly HeldFile[],
    ticked: ReadonlySet<HeldFile>,
    dir: string,
    deleteOriginals: boolean,
  ): Promise<void> {
    const library = this.libraries.getById(job.library_id);
    const landed: string[] = [];
    for (const group of sameCaptureGroups(files)) {
      if (this.stopRequested) break;
      if (group.some((file) => ticked.has(file)))
        await this.copyGroup(job, group, ticked, dir, landed, deleteOriginals);
    }
    if (library != null && landed.length > 0)
      await this.scanLanded(
        library.id,
        landed.map((abs) => path.relative(library.root_path, abs).split(path.sep).join('/')),
      );
    const done = job.copied + job.skipped + job.failed;
    this.update(job, { status: done < job.total ? 'stopped' : 'finished' });
  }

  // One suffix for the whole group, unticked files included: the library links a RAW to its camera
  // file by filename stem, and either may be copied on a later run.
  private async copyGroup(
    job: ImportJob,
    group: HeldFile[],
    ticked: ReadonlySet<HeldFile>,
    dir: string,
    landed: string[],
    deleteOriginals: boolean,
  ): Promise<void> {
    const targets = await freeTargets(group, dir);
    for (const [index, file] of group.entries()) {
      const { path: destination, identical } = targets[index]!;
      if (!ticked.has(file)) continue;
      if (this.stopRequested) return;
      let deleted = false;
      try {
        if (deleteOriginals) deleted = await moveOriginal(file.absPath, destination);
        else if (!identical) await copyOriginal(file.absPath, destination);
      } catch (err) {
        log.warn('could not copy a file', { file: file.absPath, err: String(err) });
        this.update(job, {
          failed: job.failed + 1,
          failed_names: withName(job.failed_names, file.relPath),
        });
        continue;
      }
      landed.push(destination);
      this.update(job, identical ? { skipped: job.skipped + 1 } : { copied: job.copied + 1 });
      if (!deleteOriginals) continue;
      this.update(
        job,
        deleted
          ? { deleted: job.deleted + 1 }
          : { kept: job.kept + 1, kept_names: withName(job.kept_names, file.relPath) },
      );
    }
  }

  // Past the retries the watcher or the daily scan finds them: the files are in the library.
  private async scanLanded(libraryId: string, paths: string[]): Promise<void> {
    for (let attempt = 0; attempt < SCAN_LEASE_RETRIES; attempt++) {
      try {
        await this.scans.scanLibrary(libraryId, { paths });
        return;
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'SYNC_IN_PROGRESS') {
          log.warn('could not scan what was added', { library: libraryId, err: String(err) });
          return;
        }
        if (this.stopRequested) return;
        await Bun.sleep(SCAN_LEASE_RETRY_MS);
      }
    }
    log.warn('gave up waiting for a running scan', { library: libraryId });
  }

  private update(job: ImportJob, change: Partial<ImportJob>): void {
    Object.assign(job, change);
    this.announce(job);
  }

  private heldScan(scanId: string): HeldScan {
    if (this.held?.id !== scanId) throw new AppError('NOT_FOUND', `scan not found: ${scanId}`);
    return this.held;
  }

  private heldFile(held: HeldScan, id: number): HeldFile {
    const file = held.files[id];
    if (file == null) throw new AppError('NOT_FOUND', `file not found: ${id}`);
    return file;
  }
}

function sameCaptureGroups(files: readonly HeldFile[]): HeldFile[][] {
  const groups = new Map<string, HeldFile[]>();
  for (const file of files) {
    const stem = file.relPath.slice(0, file.relPath.length - path.extname(file.relPath).length);
    const key = stem.toLowerCase();
    const group = groups.get(key);
    if (group == null) groups.set(key, [file]);
    else group.push(file);
  }
  return [...groups.values()];
}

async function freeTargets(
  group: readonly HeldFile[],
  dir: string,
): Promise<{ path: string; identical: boolean }[]> {
  for (let n = 0; ; n++) {
    const targets = await Promise.all(
      group.map(async (file) => {
        const target = path.join(dir, numberedName(path.basename(file.relPath), n));
        const existing = await stat(target).catch(() => null);
        return {
          path: target,
          identical: existing != null && isSameFile(existing, file),
          taken: existing != null,
        };
      }),
    );
    if (targets.every((target) => !target.taken || target.identical)) return targets;
  }
}

function isSameFile(existing: Stats, file: HeldFile): boolean {
  return (
    existing.size === file.size &&
    // A library on exFAT, HFS+ or FAT rounds the mtime the copy set, as far as FAT's 2 s.
    Math.abs(existing.mtime.getTime() - file.mtime.getTime()) <= COARSEST_MTIME_MS
  );
}

async function sweepCrashedCopies(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (isImportStaging(name)) await deleteImportStaging(path.join(dir, name));
  }
}
