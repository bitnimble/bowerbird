import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { DailySync, msUntil } from '../daily_sync';
import type { SyncService } from '../sync_service';

const at = (iso: string) => new Date(iso);
const withSync = (syncAll: () => Promise<void>) => ({ syncAll }) as unknown as SyncService;

describe('msUntil', () => {
  it('returns the wait until today when the time is still ahead', () => {
    expect(msUntil('03:00', at('2026-07-18T01:00:00'))).toBe(2 * 60 * 60 * 1000);
  });

  it('rolls over to tomorrow once the time has passed', () => {
    expect(msUntil('03:00', at('2026-07-18T05:00:00'))).toBe(22 * 60 * 60 * 1000);
  });

  it('treats exactly-now as tomorrow, so it never fires twice', () => {
    expect(msUntil('03:00', at('2026-07-18T03:00:00'))).toBe(24 * 60 * 60 * 1000);
  });
});

describe('DailySync', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does nothing when disabled', () => {
    const syncAll = jest.fn(() => Promise.resolve());
    new DailySync(withSync(syncAll), '').start();
    jest.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(syncAll).not.toHaveBeenCalled();
  });

  it('fires at the configured time and again the next day, until stopped', () => {
    jest.setSystemTime(at('2026-07-18T02:00:00'));
    const syncAll = jest.fn(() => Promise.resolve());
    const daily = new DailySync(withSync(syncAll), '03:00');
    daily.start();

    jest.advanceTimersByTime(60 * 60 * 1000); // 03:00
    expect(syncAll).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(24 * 60 * 60 * 1000); // next 03:00
    expect(syncAll).toHaveBeenCalledTimes(2);

    daily.stop();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(syncAll).toHaveBeenCalledTimes(2);
  });
});
