import { jest } from '@jest/globals';
import { PeriodicSync } from '../periodic_sync';
import type { SyncService } from '../sync_service';

const withSync = (syncAll: () => Promise<void>) => ({ syncAll }) as unknown as SyncService;

describe('PeriodicSync', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not schedule anything when the interval is <= 0', () => {
    const syncAll = jest.fn(() => Promise.resolve());
    new PeriodicSync(withSync(syncAll), 0).start();
    jest.advanceTimersByTime(100_000);
    expect(syncAll).not.toHaveBeenCalled();
  });

  it('runs a full syncAll each interval, and stop() halts it', async () => {
    const syncAll = jest.fn(() => Promise.resolve());
    const periodic = new PeriodicSync(withSync(syncAll), 1000);
    periodic.start();
    await jest.advanceTimersByTimeAsync(3000);
    expect(syncAll).toHaveBeenCalledTimes(3);
    periodic.stop();
    await jest.advanceTimersByTimeAsync(3000);
    expect(syncAll).toHaveBeenCalledTimes(3);
  });

  it('does not overlap: a tick is skipped while a prior full sync is still running', async () => {
    let release!: () => void;
    const syncAll = jest.fn(() => new Promise<void>((r) => (release = r)));
    const periodic = new PeriodicSync(withSync(syncAll), 1000);
    periodic.start();

    await jest.advanceTimersByTimeAsync(1000); // tick 1 starts, stays pending
    await jest.advanceTimersByTimeAsync(1000); // tick 2 sees it running -> skip
    expect(syncAll).toHaveBeenCalledTimes(1);

    release(); // tick 1 completes
    await jest.advanceTimersByTimeAsync(1000); // tick 3 runs
    expect(syncAll).toHaveBeenCalledTimes(2);
    periodic.stop();
  });
});
