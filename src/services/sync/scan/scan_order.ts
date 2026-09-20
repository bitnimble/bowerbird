import type { Stats } from 'node:fs';

/**
 * Runs `work` over `items` with at most `width` of them in the air, handing each
 * outcome to `use` in the order the items arrived.
 *
 * In order, rather than as they land, because a scan's meaning depends on it: `present`
 * grows one file at a time and a stopped run is defined by how far it got, so results
 * arriving in whatever order the disk answered would make what a stop kept depend on
 * which reads were slow.
 */
export async function eachInOrder<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R>,
  use: (item: T, outcome: { value: R } | { error: unknown }) => void,
  stopped: () => boolean,
): Promise<void> {
  const settled = (item: T): Promise<{ value: R } | { error: unknown }> =>
    work(item).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  const running: Promise<{ value: R } | { error: unknown }>[] = [];
  let next = 0;
  const fill = (): void => {
    while (running.length < Math.max(1, width) && next < items.length && !stopped()) {
      running.push(settled(items[next++]!));
    }
  };

  fill();
  for (const item of items) {
    const first = running.shift();
    if (first == null) return;
    use(item, await first);
    fill();
  }
}

/**
 * The order to open a scan's files in, which is not the order the directories listed
 * them.
 *
 * A listing comes back in whatever order the filesystem indexes names in - hash order
 * on ext4 and XFS - which has nothing to do with where the photographs are. Sorting is
 * free: the stat pass has already collected dev and ino to collapse hardlink pairs.
 *
 * It buys something only where the inode number is itself a coarse physical address.
 * ext4 puts inode N in a computable block group and prefers that group for its data,
 * and XFS encodes the allocation group in the number. **ZFS does neither** - `st_ino`
 * there is a dnode number, and a file's blocks sit wherever the allocator put them - so
 * on a ZFS pool the only gain is whatever the copy happened to lay down in order. That
 * turns out to be a good deal. A year of this library - 3914 frames, 257GB - read cold
 * over NFS goes a quarter to a third faster in this order than in the one the walk hands
 * them over in, and the gap holds whichever order is read first, which is the test that
 * matters: whichever runs second is worth ~25% on its own and has manufactured this
 * result twice.
 *
 * Warm, the two are identical, because there is no seek left to order. An import is the
 * cold case.
 *
 * By device first: a library spanning two mounts has two heads to keep sweeping.
 */
export function inodeOrder<T extends { stats: Stats }>(files: T[]): T[] {
  return files.sort((a, b) => a.stats.dev - b.stats.dev || a.stats.ino - b.stats.ino);
}
