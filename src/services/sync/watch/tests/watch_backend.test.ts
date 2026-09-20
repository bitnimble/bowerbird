import { describe, it, expect, mock } from 'bun:test';

// The stand-in, not parcel: this machine has the addon, the desktop bundle that
// actually runs the stand-in does not, and it is the stand-in that got this wrong.
mock.module('@parcel/watcher', () => {
  throw new Error('no addon here');
});
const { subscribe } = await import('../watch_backend');

describe('watching a root that is not there', () => {
  // Armed off the rejection: a resolved subscription watching nothing is one the
  // watcher holds, and holding one is what makes it skip every retry after.
  it('rejects rather than resolving with a subscription', async () => {
    await expect(subscribe('/definitely/not/a/real/root', () => {})).rejects.toThrow();
  });
});
