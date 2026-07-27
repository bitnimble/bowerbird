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
  // Sweep for generated files whose photo no longer exists (§10.6). Weekly
  // because it only has anything to do after a library is removed or a
  // catalogue is rebuilt, and it reads every thumbnail directory. 0 disables.
  pruneEveryDays: envNumber('PRUNE_EVERY_DAYS', 7),
  // Full-resolution export (§10.5). libjxl butteraugli distance: 0 is
  // mathematically lossless but ~50s and 80MB on a 24MP frame, where 0.3 is
  // half a second and 9MB. Deliberately tighter than libjxl's "visually
  // lossless" 1.0, because this view exists to be pixel-peeped.
  // Full-resolution export (§10.5), AVIF. `quality` is sharp's 1-100 scale for
  // the SDR path; `quantizer` is avifenc's 0-63 (lower is better) for the HDR
  // one. Both are set tight rather than "visually lossless", because this is the
  // view that exists to be pixel-peeped, and kept inside a ~20MB budget on a
  // 60MP frame.
  losslessQuality: envNumber('LOSSLESS_QUALITY', 88),
  losslessQuantizer: envNumber('LOSSLESS_QUANTIZER', 8),
  // Display peak the BT.2390 roll-off targets, and what the file declares as its
  // mastering peak. No longer the exposure control: the grade anchors diffuse
  // white independently, so this only sets how much headroom sits above it.
  hdrPeakNits: envNumber('HDR_PEAK_NITS', 1000),
  // ITU-R BT.2408 HDR Reference White, and the quantile of the frame taken to be
  // diffuse white. Between them these decide how bright a photo renders, so they
  // are the pair to reach for if a library comes out consistently dark or hot.
  //
  // A lower quantile renders *brighter*: it places diffuse white further down the
  // histogram, so everything above it scales up. 0.99 was too high on a landscape
  // - half sky means the brightest 1% is sky and speculars rather than a lit white
  // surface - and capped a daylight frame at 470 nits with its greenery at 40.
  // 0.90 puts the same frame's peak at 823 and its greenery at 70.
  hdrReferenceWhiteNits: envNumber('HDR_REFERENCE_WHITE_NITS', 203),
  hdrWhiteQuantile: envNumber('HDR_WHITE_QUANTILE', 0.9),
  // SVT-AV1 quality and speed. A still is looked at rather than streamed, so
  // this is tighter than a video default; 24MP takes about 2.5s at preset 8.
  hdrCrf: envNumber('HDR_CRF', 20),
  hdrPreset: envNumber('HDR_PRESET', 8),
  // AV1 cannot encode a current sensor at native size (SVT-AV1 refuses a 60MP
  // frame), and this still is for judging HDR on a monitor rather than for
  // pixel-peeping, which the lossless export already covers. 4K shows 1:1 on
  // the displays that do HDR.
  hdrMaxEdge: envNumber('HDR_MAX_EDGE', 3840),
  processingConcurrency: envNumber('PROCESSING_CONCURRENCY', 4),
  smallThumbnailSize: envNumber('SMALL_THUMBNAIL_SIZE', 800),
  fullThumbnailSize: envNumber('FULL_THUMBNAIL_SIZE', 3840),
  // AVIF quality, which is not WebP's scale: on a 24MP frame the full-size
  // rendition is 375 kB at q60 against 1019 kB for the WebP q90 it replaces, and
  // q90 here would be 2551 kB. The full preview is the one actually looked at,
  // so it gets the headroom.
  // q60 and q70 visibly lose shadow detail on real frames, which is where a RAW
  // has the most to give. q80 is 1361 kB on a 24MP frame against the 1019 kB of
  // the WebP q90 it replaces, and encodes in 713ms at effort 0.
  smallThumbnailQuality: envNumber('SMALL_THUMBNAIL_QUALITY', 80),
  fullThumbnailQuality: envNumber('FULL_THUMBNAIL_QUALITY', 80),
  // sharp's AVIF effort, 0-9, and 0 because speed matters more here than size.
  // The default of 4 is pathological either way: 13.6s for a 3840px frame
  // against 0.6s at effort 0, for a file only ~15% smaller. This is also what
  // the quality-check page encodes at, so what gets judged there is what ships.
  thumbnailEffort: envNumber('THUMBNAIL_EFFORT', 0),
  // Give a render the camera's own colour treatment, by fitting the transform that
  // takes it to the JPEG embedded in the same RAW (`jpeg_match.ts`). Applies to SDR
  // renditions built from a render: an embedded-sourced grid already has the look,
  // and an 8-bit SDR JPEG cannot teach the HDR path what to do above diffuse white.
  //
  // Off by default because it is not free - the fit costs seconds on a body that
  // recorded no lens correction, where the geometry has to be searched rather than
  // read. Turn it on for a catalogue where matching the camera matters more than
  // import throughput.
  matchEmbeddedJpeg: (process.env.MATCH_EMBEDDED_JPEG ?? 'false') !== 'false',
} as const;

export type Config = typeof config;
