import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Logger } from '../../logger';
import { deleteModelFiles } from '../../utils/deletions';
import { ModelVersionSchema, type ModelsStatus } from '../../schemas/models';
import bundled from './bundled_upscaler.json';
import { fileUrl, latest, matches, type HubModel } from './hub';

const log = new Logger('models');

export const UPSCALER_FILES = ['upscaler.json', 'upscaler.bin'] as const;
const INSTALLED = 'installed.json';
const CHECK_CACHE_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const InstalledSchema = ModelVersionSchema.extend({ git_oids: z.record(z.string(), z.string()) });
export type Installed = z.infer<typeof InstalledSchema>;

export const BUNDLED_UPSCALER: Installed = {
  revision: bundled.revision,
  committed_at: bundled.committed_at,
  git_oids: Object.fromEntries(Object.entries(bundled.files).map(([name, f]) => [name, f.git_oid])),
};

/**
 * The upscaler's model: the one this build carries, or a newer one downloaded from Hugging Face
 * into `home` without updating the app.
 */
export class ModelsService {
  private installed: Installed | null = null;
  private latest: HubModel | null = null;
  private checkedAt: number | null = null;
  private error: string | null = null;
  private inFlight: Promise<void> | null = null;
  private downloading = false;

  constructor(
    private readonly home: string,
    /** Renders with the model at these manifest and weights paths from the next frame on. */
    private readonly hold: (manifest: string, weights: string) => void,
    /** Once a downloaded model is in use, for what was rendered with the last one. */
    private readonly changed: () => void,
    private readonly bundledModel: Installed = BUNDLED_UPSCALER,
  ) {}

  /**
   * At startup: a downloaded model, unless the build's own is as new. Anything else in `home` is
   * dropped, a download a newer build overtook or one a kill left part-written among it.
   */
  load(): Promise<void> {
    this.loaded = this.loading();
    return this.loaded;
  }

  private loaded: Promise<void> = Promise.resolve();

  private async loading(): Promise<void> {
    const installed = this.read();
    if (installed != null && isNewer(installed, this.bundledModel)) {
      try {
        this.hold(...this.paths(installed.revision));
        this.installed = installed;
        return;
      } catch (err) {
        log.warn("could not load the downloaded upscaler model, so the build's own is in use", {
          err: String(err),
        });
      }
    }
    if (existsSync(this.home)) await deleteModelFiles(this.home, this.home);
  }

  /** Cached, so a page that checks hourly on three devices is not three calls an hour. */
  async check(force = false): Promise<ModelsStatus> {
    const fresh = this.checkedAt != null && Date.now() - this.checkedAt < CHECK_CACHE_MS;
    if (force || !fresh) {
      this.inFlight ??= this.fetchLatest().finally(() => (this.inFlight = null));
      await this.inFlight;
    }
    return this.status();
  }

  status(): ModelsStatus {
    const current = this.installed ?? this.bundledModel;
    const available = this.newer();
    return {
      upscaler: {
        current: {
          revision: current.revision,
          committed_at: current.committed_at,
          downloaded: this.installed != null,
        },
        available:
          available == null
            ? null
            : {
                ...available.version,
                bytes: available.files.reduce((sum, file) => sum + file.size, 0),
              },
        downloading: this.downloading,
      },
      checked_at: this.checkedAt == null ? null : new Date(this.checkedAt).toISOString(),
      error: this.error,
    };
  }

  async download(): Promise<ModelsStatus> {
    if (this.downloading) throw new Error('the upscaler model is already being downloaded');
    const model = this.newer();
    if (model == null) throw new Error('there is no newer upscaler model to download');
    this.downloading = true;
    this.error = null;
    try {
      await this.loaded;
      await this.fetchInto(model);
      this.hold(...this.paths(model.version.revision));
      this.installed = await this.record(model);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.downloading = false;
    }
    log.info('the upscaler model was updated', { revision: model.version.revision });
    this.changed();
    return this.status();
  }

  /** A downloaded model's file, for a page to fetch; null where the build's own is in use. */
  file(name: string): string | null {
    if (this.installed == null || !UPSCALER_FILES.some((file) => file === name)) return null;
    return path.join(this.home, this.installed.revision, name);
  }

  private newer(): HubModel | null {
    const model = this.latest;
    const current = this.installed ?? this.bundledModel;
    if (model == null || !isNewer(model.version, current)) return null;
    // A commit that added a different model beside this one is nothing to download.
    return model.files.some((file) => current.git_oids[file.name] !== file.git_oid) ? model : null;
  }

  private async fetchLatest(): Promise<void> {
    try {
      this.latest = await latest(UPSCALER_FILES);
      this.checkedAt = Date.now();
      this.error = null;
    } catch (err) {
      // `debug`: this runs hourly whether or not anybody asked, as the app's own check does.
      this.error = err instanceof Error ? err.message : String(err);
      log.debug('could not ask Hugging Face for the newest upscaler model', { err: this.error });
    }
  }

  /**
   * Into a directory of its own, named only once every file is checked. Recorded in
   * `installed.json` only once it is in use (`record`): a kill at any point leaves the model that
   * was in use.
   */
  private async fetchInto(model: HubModel): Promise<void> {
    const { revision } = model.version;
    const partial = path.join(this.home, `${revision}.partial`);
    await deleteModelFiles(this.home, partial);
    mkdirSync(partial, { recursive: true });
    try {
      for (const file of model.files) {
        const response = await fetch(fileUrl(revision, file.name), {
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`could not download ${file.name}: the hub answered ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!matches(file, bytes)) {
          throw new Error(`${file.name} does not match what the hub lists for it`);
        }
        await Bun.write(path.join(partial, file.name), bytes);
      }
      const into = path.join(this.home, revision);
      await deleteModelFiles(this.home, into);
      renameSync(partial, into);
    } finally {
      await deleteModelFiles(this.home, partial);
    }
  }

  /** The model as the one in use at the next start, and every other in `home` dropped. */
  private async record(model: HubModel): Promise<Installed> {
    const { revision } = model.version;
    const installed: Installed = {
      ...model.version,
      git_oids: Object.fromEntries(model.files.map((file) => [file.name, file.git_oid])),
    };
    const written = path.join(this.home, `${INSTALLED}.partial`);
    await Bun.write(written, JSON.stringify(installed));
    renameSync(written, path.join(this.home, INSTALLED));
    for (const entry of readdirSync(this.home)) {
      if (entry !== revision && entry !== INSTALLED) {
        await deleteModelFiles(this.home, path.join(this.home, entry));
      }
    }
    return installed;
  }

  private read(): Installed | null {
    const recorded = path.join(this.home, INSTALLED);
    if (!existsSync(recorded)) return null;
    let parsed;
    try {
      parsed = InstalledSchema.safeParse(JSON.parse(readFileSync(recorded, 'utf8')));
    } catch {
      return null;
    }
    if (!parsed.success) return null;
    const complete = UPSCALER_FILES.every((name) =>
      existsSync(path.join(this.home, parsed.data.revision, name)),
    );
    return complete ? parsed.data : null;
  }

  private paths(revision: string): [manifest: string, weights: string] {
    return [
      path.join(this.home, revision, 'upscaler.json'),
      path.join(this.home, revision, 'upscaler.bin'),
    ];
  }
}

function isNewer(candidate: { committed_at: string }, than: { committed_at: string }): boolean {
  return Date.parse(candidate.committed_at) > Date.parse(than.committed_at);
}
