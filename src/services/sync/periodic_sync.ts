import type { SyncService } from './sync_service';

// Runs a full syncAll on a fixed interval, the backstop for changes the watcher's
// scoped, event-driven syncs can miss (dropped/coalesced fs events, cross-dir
// moves, edits made while the server was down). Disabled when intervalMs <= 0.
export class PeriodicSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly sync: SyncService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer != null) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a prior full sync is still going; don't pile up
    this.running = true;
    try {
      await this.sync.syncAll();
    } catch (err) {
      // syncAll already isolates per-library failures; this only catches a failure
      // enumerating libraries, so the interval keeps firing.
      console.error(`periodic full sync failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
