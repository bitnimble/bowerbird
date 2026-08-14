import { Logger } from '../../logger';
import type { SyncService } from './sync_service';

const log = new Logger('daily-sync');

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
    private at = '',
  ) {}

  start(): void {
    if (this.at === '' || this.timer != null) return;
    this.schedule();
    log.info('daily full reconcile scheduled', { at: this.at });
  }

  /** Applies a changed setting (§15) without a restart. */
  configure(at: string): void {
    if (at === this.at && this.timer != null) return;
    this.stop();
    this.at = at;
    this.start();
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
    if (this.running) {
      log.warn('the previous full reconcile is still running; skipping this one');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    log.info('full reconcile start');
    try {
      await this.sync.syncAll();
      log.info('full reconcile done', { ms: Date.now() - startedAt });
    } catch (err) {
      // syncAll isolates per-library failures; this only catches a failure
      // enumerating libraries, so tomorrow's run still happens.
      log.error('full reconcile failed', { err });
    } finally {
      this.running = false;
    }
  }
}
