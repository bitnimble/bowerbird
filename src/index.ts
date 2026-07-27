import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createDatabase } from './db/connection';
import { applyErrorHandler } from './api/error_handler';
import { LibrariesApi } from './api/libraries/libraries_api';
import { LibrariesService } from './services/libraries/libraries_service';
import { LibrariesRepository } from './services/libraries/libraries_repository';
import { PhotosApi } from './api/photos/photos_api';
import { PhotosService } from './services/photos/photos_service';
import { PhotosRepository } from './services/photos/photos_repository';
import { ShootsApi } from './api/shoots/shoots_api';
import { ShootsService } from './services/shoots/shoots_service';
import { ShootsRepository } from './services/shoots/shoots_repository';
import { AlbumsApi } from './api/albums/albums_api';
import { AlbumsService } from './services/albums/albums_service';
import { AlbumsRepository } from './services/albums/albums_repository';
import { ImageApi } from './api/image/image_api';
import { HdrTestApi } from './api/hdr/hdr_test_api';
import { QualityCheckApi } from './api/quality/quality_check_api';
import { ConfigApi } from './api/config/config_api';
import { SettingsApi } from './api/settings/settings_api';
import { SettingsRepository } from './services/settings/settings_repository';
import { SyncService } from './services/sync/sync_service';
import { LibraryWatcher } from './services/sync/library_watcher';
import { DailySync } from './services/sync/daily_sync';
import { PruneService, ScheduledPrune } from './services/maintenance/prune_service';
import { ProcessingService } from './services/processing/processing_service';
import { config } from './config';

const db = createDatabase(config.dbPath);

const librariesRepo = new LibrariesRepository(db);
const photosRepo = new PhotosRepository(db);
const shootsRepo = new ShootsRepository(db);
const albumsRepo = new AlbumsRepository(db);

const processingService = new ProcessingService(photosRepo, config);

const librariesService = new LibrariesService(librariesRepo);
const photosService = new PhotosService(photosRepo, albumsRepo, shootsRepo, librariesRepo, processingService);
const albumsService = new AlbumsService(albumsRepo, photosRepo);
const shootsService = new ShootsService(shootsRepo, photosRepo, librariesRepo);
const syncService = new SyncService(photosRepo, librariesRepo, albumsRepo, shootsRepo, processingService);
// Prune sync's per-library in-memory state when a library is deleted (unbounded otherwise).
librariesService.addLifecycleListener(syncService);

const librariesApi = new LibrariesApi(librariesService, syncService);
const photosApi = new PhotosApi(photosService, processingService);
const albumsApi = new AlbumsApi(albumsService, photosService);
const shootsApi = new ShootsApi(shootsService, photosService);
const imageApi = new ImageApi(photosService, librariesService);

// With no configured allowlist, mirror back any origin on the same host the
// request arrived at (plus loopback). That lets the web client work on
// localhost and over the LAN without knowing the server's address in advance,
// while still refusing an arbitrary site on the internet.
function sameHostOrigin(origin: string, c: Context): string | null {
  if (origin === '') return null;
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1') return origin;
  const requestHost = (c.req.header('host') ?? '').replace(/:\d+$/, '');
  return originHost === requestHost ? origin : null;
}

const app = new Hono();
// Before the routes so preflights are answered too. Expose the range/length
// headers the image endpoints set, else a cross-origin client can't read them.
app.use(
  '*',
  cors({
    origin: config.corsOrigins ?? sameHostOrigin,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
  }),
);
// Error bodies echo the id that was not found, and the diagnostic pages are
// served as HTML from the same origin. Both are safe as they stand - a JSON
// body is never parsed as markup - but only while the declared type is
// believed, so say it is not to be sniffed.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
});
app.route('/api/config', new ConfigApi(config).routes);
app.route('/api/settings', new SettingsApi(new SettingsRepository(db)).routes);
app.route('/api/libraries', librariesApi.routes);
app.route('/api', photosApi.routes);
app.route('/api', shootsApi.routes);
app.route('/api/albums', albumsApi.routes);
app.route('/image', imageApi.routes);
// Served by the API rather than the web client because it has to be opened
// directly on an HDR machine, which may not be the one running the UI (§10.7).
app.route('/hdr-check', new HdrTestApi(photosService, librariesService).routes);
// Which AVIF quality to ship at: a diagnostic, same reasoning as the HDR check.
app.route('/quality-check', new QualityCheckApi(photosService, librariesService, config).routes);

if (config.watchEnabled) {
  const watcher = new LibraryWatcher(librariesRepo, syncService, config.watchDebounceMs);
  librariesService.addLifecycleListener(watcher);
  watcher.start();
  console.log(`Filesystem watching enabled (debounce ${config.watchDebounceMs}ms)`);
}

if (config.fullSyncAt !== '') {
  new DailySync(syncService, config.fullSyncAt).start();
  console.log(`Daily full reconcile at ${config.fullSyncAt}`);
}

if (config.pruneEveryDays > 0) {
  new ScheduledPrune(new PruneService(librariesRepo, photosRepo), config.pruneEveryDays).start();
  console.log(`Orphaned-file prune every ${config.pruneEveryDays} day(s)`);
}

applyErrorHandler(app);

// Bun.serve idles a request out after 10s by default, which is shorter than the
// work some endpoints are synchronously waiting on: a full-resolution lossless
// render, and the six HDR renditions, both run to tens of seconds on a 60MP
// frame. The client sees the socket closed rather than an error, so this looks
// like a crash rather than a timeout. 255 is Bun's maximum.
const IDLE_TIMEOUT_SECONDS = 255;

export default { port: config.port, hostname: config.host, idleTimeout: IDLE_TIMEOUT_SECONDS, fetch: app.fetch };
