// Server configuration from environment variables (DESIGN §15).

// Parses a numeric env var, failing fast (rather than propagating NaN, which
// silently breaks e.g. the processing pool's Math.min bound).
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a number`);
  }
  return value;
}

export const config = {
  port: envNumber('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './bowerbird.db',
  // Filesystem watching: auto-sync a library when its files change on disk.
  watchEnabled: (process.env.WATCH_ENABLED ?? 'true') !== 'false',
  watchDebounceMs: envNumber('WATCH_DEBOUNCE_MS', 2000),
  // Periodic full reconcile: the backstop that catches changes the watcher's
  // (scoped, lossy-event-driven) syncs missed; dropped events, cross-dir moves,
  // external edits. 0 disables it. Default 15 min.
  fullSyncIntervalMs: envNumber('SYNC_FULL_INTERVAL_MS', 15 * 60 * 1000),
  // Full-scan optimization: skip stat-ing files in directories whose mtime is
  // unchanged since the last full scan. Big speedup on large libraries, but a
  // pruned scan detects add/remove/rename (which bump dir mtime), NOT an in-place
  // content edit of an existing file (which doesn't). Live edits are still caught
  // by the watcher; only enable if RAWs are effectively immutable. Default off.
  syncPruneUnchangedDirs: (process.env.SYNC_PRUNE_UNCHANGED_DIRS ?? 'false') === 'true',
  processingConcurrency: envNumber('PROCESSING_CONCURRENCY', 4),
  smallThumbnailSize: envNumber('SMALL_THUMBNAIL_SIZE', 800),
  fullThumbnailSize: envNumber('FULL_THUMBNAIL_SIZE', 3840),
  smallThumbnailQuality: envNumber('SMALL_THUMBNAIL_QUALITY', 80),
  fullThumbnailQuality: envNumber('FULL_THUMBNAIL_QUALITY', 90),
} as const;

export type Config = typeof config;
