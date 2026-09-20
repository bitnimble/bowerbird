import { existsSync, watch } from 'node:fs';
import path from 'node:path';

// Who actually watches the tree, and what to do where the good one cannot be had.
//
// `@parcel/watcher` is the one worth having, for two measured reasons (§9.8): it
// names the *destination* of a move, which a bare recursive watch never does, and
// it takes one inotify watch per directory rather than one per file, which is what
// put chokidar 40x over a real library's watch budget. Nothing here replaces it.
//
// It is a native addon, though, and a compiled single-file server cannot carry one:
// the bundle holds the JavaScript and the `.node` beside it is simply not there. So
// it is *asked for* rather than imported, and where the answer is no - which is the
// desktop app's own bundled server, and nothing else - the platform's own recursive
// watch stands in.

export interface WatchEvent {
  type: string;
  path: string;
}

export interface Subscription {
  unsubscribe: () => Promise<void>;
}

export type WatchCallback = (error: Error | null, events: WatchEvent[]) => void;

export interface WatchOptions {
  /** Subtrees not worth watching. Absolute paths. */
  ignore?: string[];
}

/** How long the fallback gathers events before handing them over, as one batch. */
const BATCH_MS = 50;

type Parcel = {
  subscribe: (root: string, callback: WatchCallback, options: WatchOptions) => Promise<Subscription>;
};

let parcel: Parcel | null | undefined;

async function preferred(): Promise<Parcel | null> {
  if (parcel !== undefined) return parcel;
  try {
    parcel = (await import('@parcel/watcher')) as unknown as Parcel;
  } catch {
    parcel = null;
  }
  return parcel;
}

export async function subscribe(
  root: string,
  callback: WatchCallback,
  options: WatchOptions = {},
): Promise<Subscription> {
  const best = await preferred();
  if (best != null) return best.subscribe(root, callback, options);
  return fallback(root, callback, options);
}

/**
 * The platform's own recursive watch, wearing the same shape.
 *
 * Two things it does not do, both of them optimisations rather than correctness:
 * an ignored subtree is filtered after the event rather than never watched, so it
 * costs a watch descriptor; and a move arrives as two unrelated paths rather than
 * as one event naming both. The second matters less than it reads - the scan
 * detects a move by hash rather than by being told about it (§9), and both paths
 * land in the same debounce window, so the scoped sync covers the pair either way.
 */
function fallback(root: string, callback: WatchCallback, options: WatchOptions): Subscription {
  const ignored = (options.ignore ?? []).map((entry) => path.resolve(entry));
  let batch: WatchEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    const sending = batch;
    batch = [];
    if (sending.length > 0) callback(null, sending);
  };

  // Thrown, so `subscribe` rejects as parcel's does for an unmounted root: the
  // caller re-attempts off that rejection. Reporting it to the callback instead
  // resolves with a subscription watching nothing, which the caller then holds -
  // and holding one is what makes it skip every retry from there on.
  const watcher = watch(root, { recursive: true, persistent: true });

  watcher.on('error', (error) => callback(error, []));
  watcher.on('change', (event, name) => {
    if (name == null) return;
    const absolute = path.resolve(root, name.toString());
    if (ignored.some((entry) => absolute === entry || absolute.startsWith(`${entry}${path.sep}`))) return;
    // 'rename' covers both arrival and departure and does not say which, so the
    // answer comes from the tree rather than from the event.
    const type = event === 'rename' ? (existsSync(absolute) ? 'create' : 'delete') : 'update';
    batch.push({ type, path: absolute });
    timer ??= setTimeout(flush, BATCH_MS);
  });

  return {
    unsubscribe: async () => {
      if (timer != null) clearTimeout(timer);
      watcher.close();
    },
  };
}
