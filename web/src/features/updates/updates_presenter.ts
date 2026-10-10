import { action, runInAction } from 'mobx';
import { type ModelsStatus } from '../../../../src/schemas/models';
import { type UpdateStatus } from '../../../../src/schemas/updates';
import { modelsApi } from '../../api/models';
import { ApiError } from '../../api/request';
import { updatesApi } from '../../api/updates';
import { fileSizeLabel } from '../../ui/format';
import type { ConfirmPresenter } from '../confirm/confirm_presenter';
import { UpdatesStrings } from './updates.strings';
import type { UpdatesStore } from './updates_store';

/**
 * Hourly, and once on launch.
 *
 * The server caches its answer for ten minutes, so this is a request that usually costs
 * nothing and never reaches GitHub more than six times an hour however many devices are
 * watching the same library.
 */
const CHECK_EVERY_MS = 60 * 60 * 1000;

/** How often the page asks whether the new version is up, once one is being installed. */
const RESTART_POLL_MS = 2000;

/**
 * Long enough for a container to pull its payload onto a slow disk and come back; short
 * enough that a page which will never be answered eventually says so rather than
 * spinning for the rest of the session.
 */
const RESTART_TIMEOUT_MS = 5 * 60 * 1000;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

/**
 * The two things about the restart that cannot be exercised as they stand: the page
 * reload, and a five-minute wait. Defaulted, so nothing but a test ever passes them.
 */
export interface RestartHooks {
  reload: () => void;
  pollMs: number;
  timeoutMs: number;
}

export class UpdatesPresenter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: UpdatesStore,
    private readonly confirm: ConfirmPresenter,
    private readonly restart: RestartHooks = {
      reload: () => window.location.reload(),
      pollMs: RESTART_POLL_MS,
      timeoutMs: RESTART_TIMEOUT_MS,
    },
  ) {}

  /** On launch, and every hour after it, for as long as the app is open. */
  start(): void {
    if (this.timer != null) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  /** `force` skips the server's cache, which is what the button in Settings asks for. */
  @action.bound
  async check(force = false): Promise<void> {
    this.store.checking = true;
    try {
      await Promise.all([this.checkApp(force), this.checkModels(force)]);
    } finally {
      runInAction(() => (this.store.checking = false));
    }
  }

  /** Asks first, since every photo rendered with the upscaler is rendered again with the new model. */
  @action.bound
  async downloadModel(): Promise<void> {
    const available = this.store.modelAvailable;
    if (this.store.modelDownloading || available == null) return;
    const confirmed = await this.confirm.ask({
      title: UpdatesStrings.modelUpdateTitle(),
      body: UpdatesStrings.modelUpdateBody(fileSizeLabel(available.bytes)),
      action: UpdatesStrings.modelUpdate(),
    });
    if (!confirmed) return;
    runInAction(() => {
      this.store.modelDownloading = true;
      this.store.modelFailure = null;
    });
    try {
      this.putModels(await modelsApi.download());
    } catch (err) {
      runInAction(() => (this.store.modelFailure = message(err)));
    } finally {
      runInAction(() => (this.store.modelDownloading = false));
    }
  }

  /**
   * Downloads the new version, then waits for it to be the one answering.
   *
   * The server exits as soon as it has replied, so every request after this one fails
   * until the updater has started the new one - which is what the poll is for, and
   * why the reload is at the end rather than at the click: a page reloaded into a server
   * that is not there yet is a blank screen with no way to tell it was working.
   */
  @action.bound
  async install(): Promise<void> {
    if (this.store.install !== 'idle') return;
    this.store.install = 'downloading';
    this.store.failure = null;
    const target = this.store.available?.version ?? null;
    try {
      this.put(await updatesApi.apply());
    } catch (err) {
      runInAction(() => {
        this.store.install = 'idle';
        this.store.failure = message(err);
      });
      return;
    }
    runInAction(() => (this.store.install = 'restarting'));
    await this.waitForRestart(target);
  }

  @action.bound
  openDialog(): void {
    this.store.dialogOpen = true;
  }

  @action.bound
  setDialogOpen(open: boolean): void {
    this.store.dialogOpen = open;
  }

  private async waitForRestart(target: string | null): Promise<void> {
    const deadline = Date.now() + this.restart.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.restart.pollMs));
      try {
        const status = await updatesApi.get();
        if (target == null || status.current === target) {
          // Everything on screen was read from the old version, and there is no partial
          // version of "this is a different build of the app".
          this.restart.reload();
          return;
        }
      } catch {
        // Expected, and most of the wait: the server is down between exiting and being
        // started again.
      }
    }
    runInAction(() => {
      this.store.install = 'idle';
      this.store.failure = UpdatesStrings.restartTookTooLong();
    });
  }

  private async checkApp(force: boolean): Promise<void> {
    try {
      this.put(force ? await updatesApi.check() : await updatesApi.get());
    } catch (err) {
      // Recorded rather than toasted: this runs hourly whether or not anybody asked
      // (§23.5). Settings shows it; the sidebar simply has no badge.
      runInAction(() => (this.store.failure = message(err)));
    }
  }

  private async checkModels(force: boolean): Promise<void> {
    try {
      this.putModels(force ? await modelsApi.check() : await modelsApi.get());
    } catch (err) {
      runInAction(() => (this.store.modelFailure = message(err)));
    }
  }

  private put(status: UpdateStatus): void {
    runInAction(() => {
      this.store.status = status;
      this.store.failure = status.error;
    });
  }

  private putModels(status: ModelsStatus): void {
    runInAction(() => {
      this.store.models = status;
      this.store.modelFailure = status.error;
    });
  }
}
