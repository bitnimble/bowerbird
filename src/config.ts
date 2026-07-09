// Server configuration from environment variables (DESIGN §15).
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './bowerbird.db',
  processingConcurrency: Number(process.env.PROCESSING_CONCURRENCY ?? 4),
  // Filesystem watching: auto-sync a library when its files change on disk.
  watchEnabled: (process.env.WATCH_ENABLED ?? 'true') !== 'false',
  watchDebounceMs: Number(process.env.WATCH_DEBOUNCE_MS ?? 2000),
  smallThumbnailSize: Number(process.env.SMALL_THUMBNAIL_SIZE ?? 800),
  fullThumbnailSize: Number(process.env.FULL_THUMBNAIL_SIZE ?? 3840),
  smallThumbnailQuality: Number(process.env.SMALL_THUMBNAIL_QUALITY ?? 80),
  fullThumbnailQuality: Number(process.env.FULL_THUMBNAIL_QUALITY ?? 90),
} as const;

export type Config = typeof config;
