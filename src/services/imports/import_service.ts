import { realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';
import { newId } from '../../schemas/id';
import type {
  ImportFileStates,
  ImportHeader,
  ImportJob,
  ImportScan,
  StartImportRequest,
} from '../../schemas/imports';
import type { Library } from '../../schemas/libraries';
import type { Shoot } from '../../schemas/shoots';
import { sweepImportStaging } from '../../utils/deletions';
import { ensureDir } from '../../utils/files';
import { computeFileHash } from '../../utils/hash';
import { containsPath } from '../../utils/paths';
import { formatOf, isRendered, originalMediaType, scanLibraryTree } from '../../utils/scan';
import type { HeaderMetadata } from '../processing/analysis/metadata';
import { eachInOrder } from '../sync/scan/scan_order';
import type { ScanScope } from '../sync/scan/scan_evidence';
import { type HeldFile, ImportRun } from './import_run';

const VOLUME_SYSTEM_FOLDERS = new Set(['$RECYCLE.BIN', 'System Volume Information']);

interface HeldScan {
  id: string;
  files: HeldFile[];
}

export interface ImportPicture {
  body: Blob;
  mediaType: string;
}

export class ImportService {
  private held: HeldScan | null = null;
  private run: ImportRun | null = null;
  private starting = false;

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
      { skipUnreadable: true },
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
          deleted: false,
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

  fileStates(scanId: string, libraryId: string): ImportFileStates {
    // With the name as well as the hash: a burst's same-size frames share a card's 2 s timestamps,
    // and hash alone reads the ones not yet copied as held.
    const held = new Set<string>();
    for (const { file_hash, file_path } of this.photos.filesHeld(libraryId)) {
      const name = path.posix.basename(file_path).toLowerCase();
      held.add(`${file_hash}|${name}`);
      // Where a name collision lands it (`numberedName`).
      held.add(`${file_hash}|${name.replace(/_\d+(\.[^.]*)$/, '$1')}`);
    }
    const { files } = this.heldScan(scanId);
    const idsOf = (matches: (file: HeldFile) => boolean): number[] =>
      files.flatMap((file, id) => (matches(file) ? [id] : []));
    return {
      in_library: idsOf((file) =>
        held.has(`${file.hash}|${path.posix.basename(file.relPath).toLowerCase()}`),
      ),
      deleted: idsOf((file) => file.deleted),
    };
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
      return { body: Bun.file(file.absPath), mediaType: originalMediaType(file.relPath) };
    const bytes = await this.headers.liftEmbedded(file.absPath);
    if (bytes == null) throw new AppError('NOT_FOUND', 'this file has no embedded JPEG');
    return { body: new Blob([new Uint8Array(bytes)]), mediaType: 'image/jpeg' };
  }

  currentJob(): ImportJob | null {
    return this.run?.job ?? null;
  }

  async start(request: StartImportRequest): Promise<ImportJob> {
    if (this.starting || this.run?.job.status === 'copying')
      throw new AppError('CONFLICT', 'Photos are already being added.');
    this.starting = true;
    try {
      const held = this.heldScan(request.scan_id);
      const files = [...new Set(request.file_ids)].map((id) => this.heldFile(held, id));
      if (request.delete_originals) await this.refuseCatalogued(files);
      const { library, dir } = await this.destination(request, files);

      this.run = new ImportRun(
        {
          library,
          shootId: request.shoot_id,
          dir,
          scanned: held.files,
          ticked: new Set(files),
          deleteOriginals: request.delete_originals,
        },
        this.scans,
        this.announce,
      );
      this.run.start();
      return this.run.job;
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.run?.stop();
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

  private async destination(
    request: StartImportRequest,
    files: HeldFile[],
  ): Promise<{ library: Library; dir: string }> {
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
    await sweepImportStaging(dir);
    return { library, dir };
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
