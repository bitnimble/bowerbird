import type { Database } from '../../db/driver';

// Which originals this device is in the middle of removing (docs/replication.md §7.6).
//
// Eviction asks the peer "do you hold this *now*" and deletes on a yes. That
// question is a read: it takes nothing and promises nothing about the moment after
// it is answered. So two devices each removing their copy of the same photograph,
// each keeping it "on the other", both hear yes - because neither has deleted yet -
// and both delete. The original is then on no device, the row says `is_missing` on
// every one of them, and it is the one thing here that cannot be rebuilt.
//
// A device says it holds nothing it is about to unlink, so the pair refuse each
// other instead of racing.
//
// Keyed by the catalogue, as the clock is (`stamps.ts`), because that is what one
// device *is*: the peer's question arrives on the server and has to be answered
// against what this device is doing, whichever request began it - while a suite
// running two peers in one process must not have one answer for the other.
const evicting = new WeakMap<Database, Set<string>>();

function marks(db: Database): Set<string> {
  const existing = evicting.get(db);
  if (existing != null) return existing;
  const made = new Set<string>();
  evicting.set(db, made);
  return made;
}

/**
 * Runs `act` with this photograph marked as going, or answers `busy` if something
 * else is already removing it.
 *
 * Both peers refusing is the right outcome: nothing is lost, and the person is
 * told, where a copy deleted twice cannot be told to anybody.
 */
export async function whileEvicting<T>(
  db: Database,
  libraryId: string,
  photoId: string,
  act: () => Promise<T>,
): Promise<T | 'busy'> {
  const held = marks(db);
  const at = `${libraryId}/${photoId}`;
  if (held.has(at)) return 'busy';
  held.add(at);
  try {
    return await act();
  } finally {
    held.delete(at);
  }
}

/** Whether this device is removing it, which is a device that does not hold it. */
export function isEvicting(db: Database, libraryId: string, photoId: string): boolean {
  return evicting.get(db)?.has(`${libraryId}/${photoId}`) === true;
}
