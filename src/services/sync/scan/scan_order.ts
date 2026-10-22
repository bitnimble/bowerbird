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
