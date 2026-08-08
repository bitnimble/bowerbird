// Serializes a library's sync against the user mutations that move its files
// (shoot add/remove/rename, photo delete). Sync snapshots the DB then scans
// asynchronously, so a mutation landing mid-scan makes that snapshot stale; this
// closes that whole race class instead of guarding each symptom. Mutations queue
// rather than fail, since they're interactive requests.
//
// ponytail: one process-global instance. The coordination is inherently
// process-wide, and threading it through three service constructors (plus every
// test that builds them) buys nothing. Cross-process would instead need the sync
// lease to wait rather than fail.
class LibraryMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(libraryId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(libraryId) ?? Promise.resolve();
    const result = prev.then(fn);
    // The tail must never reject, or one failure poisons everything queued behind it.
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(libraryId, tail);
    void tail.then(() => {
      if (this.tails.get(libraryId) === tail) this.tails.delete(libraryId); // don't grow unbounded
    });
    return result;
  }
}

export const libraryMutex = new LibraryMutex();
