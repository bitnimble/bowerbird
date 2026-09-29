import { lstat, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../../config';
import type { StorageUsage } from '../../schemas/storage_usage';
import {
  containsPath,
  listPrinterProfiles,
  printerProfilesDir,
  resolveCatalogue,
} from '../../utils/paths';
import { updatesHome } from '../updates/update_service';
import { listBackups } from './backup_service';

type StoragePaths = {
  dataDir: string;
  dbPath: string;
  cachePaths?: readonly string[];
  updatesDir?: string | null;
};

export class StorageUsageService {
  constructor(
    private readonly paths: StoragePaths = {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      updatesDir: updatesHome(),
      cachePaths: [
        path.join(tmpdir(), 'bowerbird-quality-check'),
        ...(process.env.BOWERBIRD_REFERENCE_FRAME == null
          ? []
          : [process.env.BOWERBIRD_REFERENCE_FRAME]),
      ],
    },
  ) {}

  async measure(): Promise<StorageUsage> {
    const catalogue = resolveCatalogue(this.paths.dbPath);
    const catalogueNames = [
      ...new Set([path.basename(this.paths.dbPath), path.basename(catalogue)]),
    ];
    const profiles = printerProfilesDir(this.paths.dbPath);
    const files = [
      catalogue,
      ...['-wal', '-shm', '-journal'].map((suffix) => `${catalogue}${suffix}`),
      ...(await Promise.all([...new Set([this.paths.dbPath, catalogue])].map(listBackups))).flat(),
      ...(await listPrinterProfiles(profiles)).map((name) => path.join(profiles, name)),
    ];
    const directory = path.dirname(catalogue);
    for (const name of await this.entries(directory)) {
      if (name.startsWith(`${path.basename(catalogue)}.pre-restore-`))
        files.push(path.join(directory, name));
    }

    const pending = files.map((file) => ({ file, descend: false }));
    for (const root of [this.paths.dataDir, ...(this.paths.cachePaths ?? [])]) {
      try {
        pending.push({ file: await realpath(root), descend: true });
      } catch (error) {
        if (!this.isMissing(error)) throw error;
      }
    }

    const excluded: string[] = [];
    if (this.paths.updatesDir != null) {
      try {
        const home = await realpath(this.paths.updatesDir);
        excluded.push(
          ...['download', 'staged', 'staged.version'].map((name) => path.join(home, name)),
        );
      } catch (error) {
        if (!this.isMissing(error)) throw error;
      }
    }

    const seen = new Set<string>();
    let bytes = 0;
    while (pending.length > 0) {
      const next = pending.pop();
      if (next == null) continue;
      const { file, descend } = next;
      if (excluded.some((directory) => containsPath(directory, file))) continue;
      if (descend && this.isStagingFile(file, catalogueNames)) continue;
      try {
        const info = await lstat(file, { bigint: true });
        if (info.isSymbolicLink()) continue;
        const key = info.ino === 0n ? file : `${info.dev}:${info.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (info.isFile()) bytes += Number(info.size);
        else if (info.isDirectory() && descend) {
          for (const name of await this.entries(file))
            pending.push({ file: path.join(file, name), descend: true });
        }
      } catch (error) {
        if (!this.isMissing(error)) throw error;
      }
    }
    return { bytes };
  }

  private isStagingFile(file: string, catalogueNames: readonly string[]): boolean {
    const name = path.basename(file);
    if (
      /\.avif(?:\.[a-z0-9]+\.(?:tmp|fetching)|\.descriptor)$|^\.volume-[a-z0-9]+\.bin$/.test(name)
    )
      return true;
    return catalogueNames.some(
      (base) =>
        name.startsWith(`${base}.restoring-`) ||
        (name.startsWith(`.${base}-`) && name.endsWith('.part')),
    );
  }

  private async entries(directory: string): Promise<string[]> {
    try {
      return await readdir(directory);
    } catch (error) {
      if (this.isMissing(error)) return [];
      throw error;
    }
  }

  private isMissing(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    );
  }
}
