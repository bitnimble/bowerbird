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

// Parses a local time-of-day env var as "HH:MM", or "" to disable. Fails fast
// rather than silently never firing.
function envTimeOfDay(name: string, fallback: string): string {
  const raw = process.env[name] ?? fallback;
  if (raw === '') return '';
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!(hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a time of day (expected HH:MM, or "" to disable)`);
  }
  return raw;
}

// Comma-separated allowlist, '*' for any origin, or unset for the same-host
// default (see corsOrigins below).
function envOrigins(name: string): string[] | '*' | null {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return null;
  if (raw === '*') return '*';
  const list = raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  return list.length === 0 ? null : list;
}

export const config = {
  port: envNumber('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './bowerbird.db',
  // The web client is a separate app on its own origin, so the API must opt it
  // in. Unset (null) means "any port on whatever host this request reached the
  // API by", which covers serving the client over loopback or the LAN without
  // hardcoding an address. An explicit CORS_ORIGINS list, or '*', overrides it.
  corsOrigins: envOrigins('CORS_ORIGINS'),
  // Filesystem watching: auto-sync a library when its files change on disk.
  watchEnabled: (process.env.WATCH_ENABLED ?? 'true') !== 'false',
  watchDebounceMs: envNumber('WATCH_DEBOUNCE_MS', 2000),
  // Daily full reconcile: the backstop that catches changes the watcher's
  // (scoped, lossy-event-driven) syncs missed; dropped events, cross-dir moves,
  // edits made while the server was down. Local "HH:MM"; "" disables. A full scan
  // holds the library mutex, so the default is overnight, out of the way.
  fullSyncAt: envTimeOfDay('SYNC_FULL_AT', '03:00'),
  processingConcurrency: envNumber('PROCESSING_CONCURRENCY', 4),
  smallThumbnailSize: envNumber('SMALL_THUMBNAIL_SIZE', 800),
  fullThumbnailSize: envNumber('FULL_THUMBNAIL_SIZE', 3840),
  smallThumbnailQuality: envNumber('SMALL_THUMBNAIL_QUALITY', 80),
  fullThumbnailQuality: envNumber('FULL_THUMBNAIL_QUALITY', 90),
} as const;

export type Config = typeof config;
