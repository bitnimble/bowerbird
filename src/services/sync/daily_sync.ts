import type { SyncService } from './sync_service';

// Milliseconds until the next local-time occurrence of "HH:MM".
export function msUntil(at: string, now = new Date()): number {
  const [hours, minutes] = at.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours!, minutes!, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// Runs a full syncAll once a day at a configured local time: the backstop for
// changes the watcher's scoped, event-driven syncs missed (dropped fs events,
// cross-directory moves, edits made while the server was down). A full scan holds
// the library mutex for its duration, so scheduling it overnight keeps it out of
// the way of interactive requests. Disabled when `at` is empty.
export class DailySync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly sync: SyncService,
    private readonly at: string,
  ) {}

  start(): void {
    if (this.at === '' || this.timer != null) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Re-computed each day rather than a fixed 24h interval, so it stays on the
  // wall-clock time across DST shifts.
  private schedule(): void {
    this.timer = setTimeout(() => void this.fire(), msUntil(this.at));
  }

  private async fire(): Promise<void> {
    this.schedule(); // book tomorrow first, so a long sync can't skip a day
    if (this.running) return;
    this.running = true;
    try {
      await this.sync.syncAll();
    } catch (err) {
      // syncAll isolates per-library failures; this only catches a failure
      // enumerating libraries, so tomorrow's run still happens.
      console.error(`daily full sync failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
