import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { createDatabase } from './db/connection';
import { applyErrorHandler } from './api/error_handler';
import { LibrariesApi } from './api/libraries/libraries_api';
import { assertNoDataDirectoryOverlap, LibrariesService } from './services/libraries/libraries_service';
import { LibrariesRepository } from './services/libraries/libraries_repository';
import { PhotosApi } from './api/photos/photos_api';
import { PhotosService } from './services/photos/photos_service';
import { PhotosRepository } from './services/photos/photos_repository';
import { ShootsApi } from './api/shoots/shoots_api';
import { ShootsService } from './services/shoots/shoots_service';
import { FolderRulesRepository } from './services/shoots/folder_rules_repository';
import { ShootsRepository } from './services/shoots/shoots_repository';
import { AlbumsApi } from './api/albums/albums_api';
import { AlbumsService } from './services/albums/albums_service';
import { AlbumsRepository } from './services/albums/albums_repository';
import { StacksApi } from './api/stacks/stacks_api';
import { StacksService } from './services/stacks/stacks_service';
import { StacksRepository } from './services/stacks/stacks_repository';
import { EventsApi } from './api/events/events_api';
import { ImageApi } from './api/image/image_api';
import { QualityCheckApi } from './api/quality/quality_check_api';
import { SettingsApi } from './api/settings/settings_api';
import { BrowseApi } from './api/browse/browse_api';
import { SettingsRepository } from './services/settings/settings_repository';
import { SyncService } from './services/sync/sync_service';
import { SyncLocksRepository } from './services/sync/sync_locks_repository';
import { LibraryWatcher } from './services/sync/library_watcher';
import { DailySync } from './services/sync/daily_sync';
import { PruneService, ScheduledPrune } from './services/maintenance/prune_service';
import { ProcessingService } from './services/processing/processing_service';
import { config } from './config';
import { Logger, setLogLevel } from './logger';
import type { Settings } from './schemas/settings';

const log = new Logger('server');
const requestLog = new Logger('http');

// Before the database is opened, because it needs nothing but `config`: every
// generated file in the install lands under here (§3), so a directory that
// cannot be made or written is a deployment that will 404 every rendition it
// ever builds.
mkdirSync(config.dataDir, { recursive: true });
try {
  accessSync(config.dataDir, constants.W_OK);
} catch {
  throw new Error(`DATA_DIR is not writable: ${config.dataDir}`);
}

const db = createDatabase(config.dbPath);

const settingsRepo = new SettingsRepository(db);
const librariesRepo = new LibrariesRepository(db);
// After the repository exists, because it reads every library's root. `DATA_DIR`
// is an environment variable, so a catalogue that was valid yesterday can be
// started against a data directory that now swallows one of its roots (§3.1).
for (const library of librariesRepo.list()) assertNoDataDirectoryOverlap(library.root_path);
const photosRepo = new PhotosRepository(db);
const shootsRepo = new ShootsRepository(db);
const folderRulesRepo = new FolderRulesRepository(db);
const albumsRepo = new AlbumsRepository(db);
const stacksRepo = new StacksRepository(db);
const syncLocksRepo = new SyncLocksRepository(db);

const processingService = new ProcessingService(photosRepo, settingsRepo);

const librariesService = new LibrariesService(librariesRepo);
const photosService = new PhotosService(photosRepo, albumsRepo, shootsRepo, librariesRepo, processingService);
const albumsService = new AlbumsService(albumsRepo, photosRepo);
const shootsService = new ShootsService(shootsRepo, photosRepo, librariesRepo, folderRulesRepo);
const syncService = new SyncService(
  photosRepo,
  librariesRepo,
  albumsRepo,
  shootsRepo,
  folderRulesRepo,
  syncLocksRepo,
  processingService,
);
const stacksService = new StacksService(stacksRepo, photosRepo, librariesRepo);
// Prune sync's per-library in-memory state when a library is deleted (unbounded otherwise).
librariesService.addLifecycleListener(syncService);

// A photo is described for stacking as its grid tile lands (§19.3). The
// descriptor is computed in the worker that already holds the pixels and rides
// back with the result, so this side only stores it. Registered here rather than
// inside ProcessingService so that building renditions keeps knowing nothing
// about stacks: it reports what it produced, and this is one more reader of it.
processingService.onDescribed((photoId, descriptor) => stacksService.storeDescriptor(photoId, descriptor));

// Detection runs when a sync settles, and only if that sync actually brought
// something in. Not an optimisation: watching is on by default with a two-second
// debounce, so saving a file starts a scoped sync, and re-cliquing the whole
// collection every couple of seconds while someone works in the folder is not
// something a library should do (§19.4.1).
syncService.onSettled((libraryId, changed) => {
  if (!changed) return;
  try {
    stacksService.detect(libraryId);
  } catch (error) {
    log.warn('stack detection failed', { library: libraryId, err: String(error) });
  }
});

const librariesApi = new LibrariesApi(librariesService, syncService, folderRulesRepo);
const photosApi = new PhotosApi(photosService, processingService);
const albumsApi = new AlbumsApi(albumsService, photosService);
const shootsApi = new ShootsApi(shootsService, photosService);
const stacksApi = new StacksApi(stacksService, photosService);
const imageApi = new ImageApi(photosService, settingsRepo);

// With no configured allowlist, mirror back any origin on the same host the
// request arrived at (plus loopback). That lets the web client work on
// localhost and over the LAN without knowing the server's address in advance,
// while still refusing an arbitrary site on the internet.
function allowedOrigin(origin: string, c: Context): string | null {
  const configured = settingsRepo
    .get()
    .cors_origins.split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  if (configured.includes('*')) return origin;
  if (configured.length > 0) return configured.includes(origin) ? origin : null;
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
    origin: allowedOrigin,
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
// A read is only worth a line when it went wrong, or when it cost something: a grid
// scrolling through a shoot is hundreds of rendition GETs a minute, and burying the import
// that is actually running is how a log stops being read. Anything that changes state is
// worth one whatever it returns.
//
// A slow one is the exception, and by what it cost rather than by which route it is: an
// editor open is seconds of LibRaw and was invisible here, which is the wrong way round -
// it is the first thing anyone looks for when the app feels slow, and a list of routes
// would only have covered the one somebody thought of.
//
// Time rather than size, having tried both. Size is the better instinct and it cannot be
// had: `content-length` is not on `c.res` by the time this runs, so the test never fired
// once in 125 requests. It would also have been the wrong question - a large rendition read
// straight off disk is exactly the flood this stays quiet about, and what makes a read worth
// a line is that it kept someone waiting.
const SLOW_MS = 1_000;

app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  const status = c.res.status;
  const ms = Date.now() - started;
  const level =
    status >= 500 ? 'error'
    : status >= 400 ? 'warn'
    : c.req.method !== 'GET' || ms >= SLOW_MS ? 'info'
    : 'debug';
  requestLog[level](`${c.req.method} ${c.req.path}`, { status, ms });
});
app.route('/api/events', new EventsApi(processingService).routes);
app.route('/api/settings', new SettingsApi(settingsRepo).routes);
app.route('/api/browse', new BrowseApi().routes);
app.route('/api/libraries', librariesApi.routes);
app.route('/api', photosApi.routes);
app.route('/api', shootsApi.routes);
app.route('/api/albums', albumsApi.routes);
app.route('/api/stacks', stacksApi.routes);
app.route('/image', imageApi.routes);
// Served by the API rather than the web client because it has to be opened
// directly on an HDR machine, which may not be the one running the UI (§10.7).
// Which AVIF quality to ship at: a diagnostic, same reasoning as the HDR check.
app.route('/quality-check', new QualityCheckApi(photosService, librariesService, settingsRepo).routes);

// Built once and re-configured on every edit, rather than read at startup: these
// are settings now (§15), and a knob on the settings page that only takes effect
// after a restart is a knob nobody trusts.
const watcher = new LibraryWatcher(librariesRepo, syncService, settingsRepo.get().watch_debounce_ms);
librariesService.addLifecycleListener(watcher);
// An excluded folder is half of what the watcher decides what to watch by, and
// it is written from the settings page and from both halves of creating and
// deleting a shoot - none of which go through the library (§4.7).
folderRulesRepo.onChange((libraryId) => {
  const library = librariesRepo.getById(libraryId);
  if (library != null) watcher.onLibraryUpdated(library);
});
const dailySync = new DailySync(syncService);
const scheduledPrune = new ScheduledPrune(new PruneService(librariesRepo, photosRepo));

function applySettings(settings: Settings): void {
  setLogLevel(settings.log_level);
  watcher.configure(settings.watch_enabled, settings.watch_debounce_ms);
  dailySync.configure(settings.full_sync_at);
  scheduledPrune.configure(settings.prune_every_days);
}
settingsRepo.onChange(applySettings);
applySettings(settingsRepo.get());

applyErrorHandler(app);

// Bun.serve idles a request out after 10s by default, which is shorter than the
// work some endpoints are waiting on: a full-resolution lossless render, and the
// editor's open, both run to tens of seconds on a 60MP frame. The client sees the
// socket closed rather than an error, so this looks like a crash rather than a
// timeout. 255 is Bun's maximum.
const IDLE_TIMEOUT_SECONDS = 255;

// Served explicitly rather than by default export, because with the default
// port of 0 the assigned port is only knowable from the started server.
const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: IDLE_TIMEOUT_SECONDS,
  fetch: app.fetch,
});
const settings = settingsRepo.get();
log.info(`listening on http://${config.host}:${server.port}`, {
  db: config.dbPath,
  logLevel: settings.log_level,
  processingConcurrency: settings.processing_concurrency,
  libraries: librariesRepo.list().length,
});
