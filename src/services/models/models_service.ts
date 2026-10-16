import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Logger } from '../../logger';
import { deleteModelFiles } from '../../utils/deletions';
import { ModelVersionSchema, type ModelsStatus } from '../../schemas/models';
import bundled from './bundled_models.json';
import { fileUrl, latest, matches, type HubModels } from './hub';

const log = new Logger('models');

const INSTALLED = 'installed.json';
const CHECK_CACHE_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const InstalledSchema = ModelVersionSchema.extend({
  // Names a directory under `home`.
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  git_oids: z.record(z.string(), z.string()),
});
export type Installed = z.infer<typeof InstalledSchema>;

export const BUNDLED_MODELS: Installed = {
  revision: bundled.revision,
  committed_at: bundled.committed_at,
  git_oids: Object.fromEntries(Object.entries(bundled.files).map(([name, f]) => [name, f.git_oid])),
};

export interface Model {
  files: readonly string[];
  /** Renders with the model's files in `dir` from the next frame on. */
  hold: (dir: string) => void;
  /** Once a downloaded model with different files is in use, for what was rendered with the last one. */
  changed: () => void;
}

/**
 * The models on Hugging Face the app renders with: the ones this build carries, or newer ones
 * downloaded into `home` without updating the app. A commit is one update for all of them.
 */
export class ModelsService {
  private installed: Installed | null = null;
  private latest: HubModels | null = null;
  private checkedAt: number | null = null;
  private error: string | null = null;
  private inFlight: Promise<void> | null = null;
  private downloading = false;
  private readonly files: readonly string[];

  constructor(
    private readonly home: string,
    private readonly models: readonly Model[],
    private readonly bundledModels: Installed = BUNDLED_MODELS,
  ) {
    this.files = models.flatMap((model) => model.files);
  }

  /**
   * At startup: downloaded models, unless the build's own are as new. Anything else in `home` is
   * dropped, a download a newer build overtook or one a kill left part-written among it.
   */
  load(): Promise<void> {
    this.loaded = this.loading();
    return this.loaded;
  }

  private loaded: Promise<void> = Promise.resolve();

  private async loading(): Promise<void> {
    const installed = this.read();
    if (installed != null && isNewer(installed, this.bundledModels)) {
      try {
        this.hold(installed.revision);
        this.installed = installed;
        return;
      } catch (err) {
        log.warn("could not load the downloaded models, so the build's own are in use", {
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
    const current = this.installed ?? this.bundledModels;
    const available = this.newer();
    return {
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
      checked_at: this.checkedAt == null ? null : new Date(this.checkedAt).toISOString(),
      error: this.error,
    };
  }

  async download(): Promise<ModelsStatus> {
    if (this.downloading) throw new Error('the models are already being downloaded');
    const next = this.newer();
    if (next == null) throw new Error('there are no newer models to download');
    this.downloading = true;
    this.error = null;
    const before = this.installed ?? this.bundledModels;
    try {
      await this.loaded;
      await this.fetchInto(next);
      this.hold(next.version.revision);
      this.installed = await this.record(next);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.downloading = false;
    }
    log.info('the models were updated', { revision: next.version.revision });
    const installed = this.installed;
    for (const model of this.models) {
      if (model.files.every((file) => before.git_oids[file] === installed.git_oids[file])) continue;
      try {
        model.changed();
      } catch (err) {
        log.warn('could not render again with an updated model', { err: String(err) });
      }
    }
    return this.status();
  }

  /** A downloaded model's file, for a page to fetch; null unless `revision` is the one in use. */
  file(revision: string, name: string): string | null {
    if (this.installed?.revision !== revision || !this.files.includes(name)) return null;
    return path.join(this.home, revision, name);
  }

  private hold(revision: string): void {
    for (const model of this.models) model.hold(path.join(this.home, revision));
  }

  private newer(): HubModels | null {
    const next = this.latest;
    const current = this.installed ?? this.bundledModels;
    if (next == null || !isNewer(next.version, current)) return null;
    // A commit that only added a model the app doesn't use is nothing to download.
    return next.files.some((file) => current.git_oids[file.name] !== file.git_oid) ? next : null;
  }

  private async fetchLatest(): Promise<void> {
    try {
      this.latest = await latest(this.files);
      this.checkedAt = Date.now();
      this.error = null;
    } catch (err) {
      // `debug`: this runs hourly whether or not anybody asked, as the app's own check does.
      this.error = err instanceof Error ? err.message : String(err);
      log.debug('could not ask Hugging Face for the newest models', { err: this.error });
    }
  }

  /**
   * Into a directory of its own, named only once every file is checked. Recorded in
   * `installed.json` only once it is in use (`record`): a kill at any point leaves the models that
   * were in use.
   */
  private async fetchInto(next: HubModels): Promise<void> {
    const { revision } = next.version;
    const partial = path.join(this.home, `${revision}.partial`);
    await deleteModelFiles(this.home, partial);
    mkdirSync(partial, { recursive: true });
    try {
      for (const file of next.files) {
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

  /** The models as the ones in use at the next start, and every other in `home` dropped. */
  private async record(next: HubModels): Promise<Installed> {
    const { revision } = next.version;
    const installed: Installed = {
      ...next.version,
      git_oids: Object.fromEntries(next.files.map((file) => [file.name, file.git_oid])),
    };
    const written = path.join(this.home, `${INSTALLED}.partial`);
    await Bun.write(written, JSON.stringify(installed));
    renameSync(written, path.join(this.home, INSTALLED));
    for (const entry of readdirSync(this.home)) {
      if (entry === revision || entry === INSTALLED) continue;
      // The update is in use and recorded by now; a leftover is dropped at the next start.
      await deleteModelFiles(this.home, path.join(this.home, entry)).catch((err: unknown) =>
        log.warn('could not drop a superseded model download', { entry, err: String(err) }),
      );
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
    const complete = this.files.every((name) =>
      existsSync(path.join(this.home, parsed.data.revision, name)),
    );
    return complete ? parsed.data : null;
  }
}

function isNewer(candidate: { committed_at: string }, than: { committed_at: string }): boolean {
  return Date.parse(candidate.committed_at) > Date.parse(than.committed_at);
}
