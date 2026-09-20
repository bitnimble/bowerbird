import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from 'hono/bun';
import { createDatabase } from './db/connection';
import { applyErrorHandler } from './api/error_handler';
import { LibrariesApi } from './api/libraries/libraries_api';
import { assertNoDataDirectoryOverlap, LibrariesService } from './services/libraries/libraries_service';
import { LibrariesRepository } from './services/libraries/libraries_repository';
import { RenderTimingsRepository } from './services/processing/renditions/render_timings_repository';
import { PhotosApi } from './api/photos/photos_api';
import { PhotoCompositesRepository } from './services/photos/composites/photo_composites_repository';
import { PhotoListingRepository } from './services/photos/listing/photo_listing_repository';
import { PhotoNavigationRepository } from './services/photos/listing/photo_navigation_repository';
import { PhotoReadService } from './services/photos/listing/photo_read_service';
import { PhotoMetadataRepository } from './services/photos/metadata/photo_metadata_repository';
import { PhotoMutationService } from './services/photos/mutations/photo_mutation_service';
import { PhotoStateRepository } from './services/photos/mutations/photo_state_repository';
import { PhotoPathsRepository } from './services/photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from './services/photos/renditions/photo_processing_repository';
import { PhotoRenditionService } from './services/photos/renditions/photo_rendition_service';
import { PhotoScanRepository } from './services/photos/scan/photo_scan_repository';
import { ShootsApi } from './api/shoots/shoots_api';
import { ShootsService } from './services/shoots/shoots_service';
import { FolderRulesRepository } from './services/shoots/folder_rules_repository';
import { ShootsRepository } from './services/shoots/shoots_repository';
import { AlbumsApi } from './api/albums/albums_api';
import { AlbumsService } from './services/albums/albums_service';
import { AlbumsRepository } from './services/albums/albums_repository';
import { AssembliesApi } from './api/assemblies/assemblies_api';
import { CompositesApi } from './api/composites/composites_api';
import { CompositesService } from './services/composites/composites_service';
import { RenditionsRepository } from './services/processing/renditions/renditions_repository';
import { StacksApi } from './api/stacks/stacks_api';
import { StacksService } from './services/stacks/stacks_service';
import { StacksRepository } from './services/stacks/stacks_repository';
import { StackMembership } from './services/stacks/stack_membership';
import { BlobsApi } from './api/blobs/blobs_api';
import { ReplicationApi } from './api/replication/replication_api';
import { BlobLocations } from './services/blobs/blob_locations';
import { TransferService } from './services/blobs/transfer_service';
import { RenditionFetchService } from './services/blobs/rendition_fetch_service';
import { extractMetadata } from './services/processing/analysis/metadata';
import { PairedPeers } from './services/replication/peer_transport';
import type { Library } from './schemas/libraries';
import { PathSegment, route } from './schemas/route';
import { forgetOrphanedLibraries } from './services/replication/gc';
import { ReplicationLifecycle } from './services/replication/library_lifecycle';
import { ReplicationService } from './services/replication/replication_service';
import { ReplicationRunner } from './services/replication/replication_runner';
import { PhotoEditsService } from './services/photo_edits/photo_edits_service';
import { PhotoEditsRepository } from './services/photo_edits/photo_edits_repository';
import { SidecarImportService } from './services/photo_edits/sidecar_import';
import { PhotoEditsApi } from './api/photo_edits/photo_edits_api';
import { EventsApi } from './api/events/events_api';
import { ExportApi } from './api/export/export_api';
import { ExportService } from './services/processing/exports/export_service';
import { ExportHistoryService } from './services/exports/export_history_service';
import { ImageApi } from './api/image/image_api';
import { OpenGraph } from './api/opengraph/opengraph';
import { QualityCheckApi } from './api/quality/quality_check_api';
import { SettingsApi } from './api/settings/settings_api';
import { UpdatesApi } from './api/updates/updates_api';
import { UpdateService } from './services/updates/update_service';
import { VERSION } from './version';
import { BrowseApi } from './api/browse/browse_api';
import { SettingsRepository } from './services/settings/settings_repository';
import { ScanService } from './services/sync/scan/scan_service';
import { SyncLocksRepository } from './services/sync/coordination/sync_locks_repository';
import { ScanPool } from './services/sync/scan/scan_pool';
import { LibraryWatcher } from './services/sync/watch/library_watcher';
import { DailyScan } from './services/sync/watch/daily_scan';
import { PruneService, ScheduledPrune } from './services/maintenance/prune_service';
import { BackupService, ScheduledBackup } from './services/maintenance/backup_service';
import { ProcessingService } from './services/processing/pipeline/processing_service';
import { shim } from './services/processing/rawshim/rawshim';
import { config } from './config';
import { Logger, setLogLevel } from './logger';
import type { Settings } from './schemas/settings';

const log = new Logger('server');
const requestLog = new Logger('http');

// Before the database is opened, because it needs nothing but `config`: every
// generated file in the install lands under here (§6), so a directory that
// cannot be made or written is a deployment that will 404 every rendition it
// ever builds.
mkdirSync(config.dataDir, { recursive: true });
try {
  accessSync(config.dataDir, constants.W_OK);
} catch {
  throw new Error(`DATA_DIR is not writable: ${config.dataDir}`);
}

// Here, and on this thread, because every pool starts its workers at once and a cold
// worker's first pixel call would otherwise be the *process's* first dlopen of this path:
// two threads racing that crashes bun outright, and the first sync after a restart is
// four of them together. Loaded once here, theirs is a refcount bump.
shim();

const db = createDatabase(config.dbPath);

const settingsRepo = new SettingsRepository(db);
const librariesRepo = new LibrariesRepository(db);
const renderTimingsRepo = new RenderTimingsRepository(db);
// After the repository exists, because it reads every library's root. `DATA_DIR`
// is an environment variable, so a catalogue that was valid yesterday can be
// started against a data directory that now swallows one of its roots (§6).
for (const library of librariesRepo.list()) assertNoDataDirectoryOverlap(library.root_path);
const stackMembership = new StackMembership(db);
const renditionsRepo = new RenditionsRepository(db);
const photoListingRepo = new PhotoListingRepository(db);
const photoNavigationRepo = new PhotoNavigationRepository(db);
const photoStateRepo = new PhotoStateRepository(db, stackMembership);
const photoPathsRepo = new PhotoPathsRepository(db, stackMembership);
const photoProcessingRepo = new PhotoProcessingRepository(db, renditionsRepo);
const photoScanRepo = new PhotoScanRepository(db, photoProcessingRepo);
const photoCompositesRepo = new PhotoCompositesRepository(db, stackMembership, photoPathsRepo);
const photoMetadataRepo = new PhotoMetadataRepository(db, photoProcessingRepo);
const shootsRepo = new ShootsRepository(db);
const folderRulesRepo = new FolderRulesRepository(db);
const albumsRepo = new AlbumsRepository(db);
const stacksRepo = new StacksRepository(db);
const syncLocksRepo = new SyncLocksRepository(db);
const photoEditsRepo = new PhotoEditsRepository(db);

// The composite resolver is set once `CompositesService` exists, which is built on this one: the
// queue asks it for a recipe with its frames resolved, and until then finds no composites.
const processingService: ProcessingService = new ProcessingService(
  photoProcessingRepo,
  photoPathsRepo,
  photoListingRepo,
  settingsRepo,
  (id) => photoEditsRepo.docFor(id),
  (libraryId) => librariesRepo.getById(libraryId),
  // Late-bound deliberately: `compositesService` is built on this one, so the reference has to be
  // a call at the moment the queue needs it rather than a value at construction.
  (photoId) => compositesService.renderable(photoId),
);
const eventsApi = new EventsApi(processingService);
const replicationChanged = (libraryId: string): void => eventsApi.announce('replication', { library_id: libraryId });

const librariesService = new LibrariesService(librariesRepo, photoScanRepo, photoPathsRepo);
// Moving the originals themselves (§7). The queue is durable, so a restart takes
// up whatever a kill interrupted rather than losing it.
const blobLocations = new BlobLocations(db);
const pairedPeers = new PairedPeers(db);
const renditionFetch = new RenditionFetchService(
  db,
  photoPathsRepo,
  photoProcessingRepo,
  librariesRepo,
  blobLocations,
  pairedPeers,
);
const photoRenditionService = new PhotoRenditionService(
  photoPathsRepo,
  photoListingRepo,
  photoMetadataRepo,
  photoProcessingRepo,
  librariesRepo,
  processingService,
  extractMetadata,
  renditionFetch,
);
const photoReadService = new PhotoReadService(
  photoListingRepo,
  photoNavigationRepo,
  photoPathsRepo,
  photoCompositesRepo,
  albumsRepo,
  shootsRepo,
  librariesRepo,
  settingsRepo,
  processingService,
  photoRenditionService,
);
const photoMutationService = new PhotoMutationService(photoStateRepo, photoPathsRepo, librariesRepo, photoReadService);
const albumsService = new AlbumsService(albumsRepo, photoPathsRepo);
const photoEditsService = new PhotoEditsService(
  db,
  photoEditsRepo,
  photoListingRepo,
  (ids) => processingService.rebuildEdited(ids),
  replicationChanged,
);
const shootsService = new ShootsService(shootsRepo, photoPathsRepo, photoStateRepo, librariesRepo, folderRulesRepo);
const scanConcurrency = (): number => settingsRepo.get().scan_concurrency;
const scanPool = new ScanPool(scanConcurrency);
const scanService = new ScanService(
  photoScanRepo,
  photoPathsRepo,
  photoMetadataRepo,
  photoProcessingRepo,
  librariesRepo,
  albumsRepo,
  shootsRepo,
  folderRulesRepo,
  syncLocksRepo,
  processingService,
  scanPool.read,
  new SidecarImportService(photoEditsRepo),
  scanConcurrency,
  (libraryId) => replicationRunner.materialise(libraryId),
  (libraryId) => replicationRunner.stillToMove(libraryId),
);
const stacksService = new StacksService(stacksRepo, photoListingRepo, librariesRepo, settingsRepo);
// A replica is born by the runner rather than by `LibrariesService.create`, so
// this is what tells everything that hangs off a library appearing (§9.1).
const replicaBorn = (library: Library): void => librariesService.announceCreated(library);
const rebuildEdited = (photoIds: readonly string[]): number => processingService.rebuildEdited(photoIds);
const replicationRunner = new ReplicationRunner(
  db,
  syncLocksRepo,
  librariesRepo,
  blobLocations,
  replicaBorn,
  rebuildEdited,
  replicationChanged,
);
const replicationService = new ReplicationService(db, blobLocations, Date.now, rebuildEdited, replicationChanged);
// An original that lands is a tile and a rendition owed, and asking for them here
// is what makes a badged placeholder heal into a picture without anyone rescanning
// (§7.8). Not awaited: it is minutes of GPU work behind a transfer that has
// finished.
const buildArrived = (photoIds: string[]): void => {
  void processingService.processUnprocessed({ photoIds }).catch((err: unknown) => {
    log.warn('could not build renditions for an original that arrived', { err: String(err) });
  });
};
const transferService = new TransferService(
  db,
  photoPathsRepo,
  photoMetadataRepo,
  librariesRepo,
  blobLocations,
  pairedPeers,
  buildArrived,
);
const blobsApi = new BlobsApi(
  photoPathsRepo,
  photoMetadataRepo,
  photoProcessingRepo,
  librariesRepo,
  blobLocations,
  transferService,
  buildArrived,
  (libraryId) => replicationService.syncsOriginals(libraryId),
  (target) => photoReadService.resolve(target),
);
// Prune scan's per-library in-memory state when a library is deleted (unbounded otherwise).
librariesService.addLifecycleListener(scanService);
// A deleted library's vectors and log outlive it otherwise: no foreign key
// reaches them, and a replica re-added under the same id would be told it
// already holds everything (§8.4).
librariesService.addLifecycleListener(new ReplicationLifecycle(db));

// A photo is described for stacking as its grid tile lands (§19.3). The
// descriptor is computed in the worker that already holds the pixels and rides
// back with the result, so this side only stores it. Registered here rather than
// inside ProcessingService so that building renditions keeps knowing nothing
// about stacks: it reports what it produced, and this is one more reader of it.
processingService.onDescribed((photoId, descriptor) => stacksService.storeDescriptor(photoId, descriptor));

// Detection runs when a sync settles, and only if that sync actually brought
// something in. Not an optimisation: watching is on by default with a two-second
// debounce, so saving a file starts a scoped scan, and re-cliquing the whole
// collection every couple of seconds while someone works in the folder is not
// something a library should do (§19.4.1).
scanService.onSettled((libraryId, changed) => {
  if (!changed) return;
  try {
    stacksService.detect(libraryId);
  } catch (error) {
    log.warn('stack detection failed', { library: libraryId, err: String(error) });
  }
});

const librariesApi = new LibrariesApi(
  librariesService,
  scanService,
  folderRulesRepo,
  shootsService,
  (libraryId) => stacksService.detect(libraryId),
  (libraryId, rendition) =>
    processingService.benchmarkRender(librariesService.get(libraryId), rendition, renderTimingsRepo),
);
const photosApi = new PhotosApi(photoReadService, photoMutationService, photoRenditionService, processingService);
const albumsApi = new AlbumsApi(albumsService, photoReadService);
const shootsApi = new ShootsApi(shootsService, photoReadService);
const stacksApi = new StacksApi(stacksService, photoReadService);
const compositesService: CompositesService = new CompositesService(
  photoCompositesRepo,
  photoPathsRepo,
  photoMetadataRepo,
  photoProcessingRepo,
  librariesRepo,
  renditionsRepo,
  processingService,
  photoEditsRepo,
);
compositesService.onProgress((progress) => eventsApi.announce('composite', progress));
const compositesApi = new CompositesApi(compositesService, photoReadService);
const assembliesApi = new AssembliesApi(compositesService);
const exportService = new ExportService(photoRenditionService, processingService, compositesService);
// The service itself rather than an arrow forwarding its arguments. TypeScript accepts a
// function that declares *fewer* parameters than the type it satisfies, so an arrow here silently
// drops whatever the route learns to send next - which is how the loupe's `levels` and
// `scenePeak` reached this line and went no further, leaving every tile measuring its own.
const imageApi = new ImageApi(photoReadService, photoRenditionService, renditionFetch, exportService, processingService);
const exportApi = new ExportApi(
  exportService,
  new ExportHistoryService(db, photoRenditionService, photoEditsRepo, settingsRepo),
  (progress) => eventsApi.announce('export', progress),
);

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
  route(PathSegment.any()),
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
app.use(route(PathSegment.any()), async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
});
// A read is only worth a line when it went wrong, or when it cost something: a grid
// scrolling through a shoot is hundreds of rendition GETs a minute, and burying the import
// that is actually running is how a log stops being read. Anything that changes state is
// worth one whatever it returns.
//
// A slow one is the exception, and by what it cost rather than by which route it is: an
// editor open is seconds of decoding and was invisible here, which is the wrong way round -
// it is the first thing anyone looks for when the app feels slow, and a list of routes
// would only have covered the one somebody thought of.
//
// Time rather than size, having tried both. Size is the better instinct and it cannot be
// had: `content-length` is not on `c.res` by the time this runs, so the test never fired
// once in 125 requests. It would also have been the wrong question - a large rendition read
// straight off disk is exactly the flood this stays quiet about, and what makes a read worth
// a line is that it kept someone waiting.
const SLOW_MS = 1_000;

app.use(route(PathSegment.any()), async (c, next) => {
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
app.route(route(PathSegment.api(), PathSegment.events()), eventsApi.routes);
app.route(route(PathSegment.api(), PathSegment.settings()), new SettingsApi(settingsRepo).routes);
app.route(route(PathSegment.api(), PathSegment.updates()), new UpdatesApi(new UpdateService()).routes);
app.route(route(PathSegment.api(), PathSegment.browse()), new BrowseApi().routes);
app.route(route(PathSegment.api(), PathSegment.libraries()), librariesApi.routes);
app.route(route(PathSegment.api()), photosApi.routes);
app.route(route(PathSegment.api()), new PhotoEditsApi(photoEditsService).routes);
app.route(route(PathSegment.api()), shootsApi.routes);
app.route(route(PathSegment.api(), PathSegment.albums()), albumsApi.routes);
app.route(route(PathSegment.api(), PathSegment.stacks()), stacksApi.routes);
app.route(route(PathSegment.api(), PathSegment.composites()), compositesApi.routes);
app.route(route(PathSegment.api(), PathSegment.assemblies()), assembliesApi.routes);
app.route(
  route(PathSegment.api(), PathSegment.replication()),
  new ReplicationApi(replicationService, replicationRunner, (libraryId) => transferService.cancelIncoming(libraryId))
    .routes,
);
app.route(route(PathSegment.api(), PathSegment.blobs()), blobsApi.routes);
app.route(route(PathSegment.api()), exportApi.routes);
app.route(route(PathSegment.image()), exportApi.imageRoutes);
app.route(route(PathSegment.image()), assembliesApi.imageRoutes);
app.route(route(PathSegment.image()), imageApi.routes);
// Served by the API rather than the web client because it has to be opened
// directly on an HDR machine, which may not be the one running the UI (§10.7).
// Which AVIF quality to ship at: a diagnostic, same reasoning as the HDR check.
app.route(
  route(PathSegment.qualityCheck()),
  new QualityCheckApi(photoReadService, photoRenditionService, librariesService, settingsRepo).routes,
);

// The web client, where a build of it sits beside this server (the container).
//
// **Load-bearing for replication, not a convenience.** A peer is dialled at the
// address a browser reaches it on (§9.1), and the deployment publishes one port -
// so the address the reader is told to type has to be a port that answers both
// the UI and `/api`. In development that is the vite server proxying to this one;
// here it is this one serving both. Without it the only published address is an
// API with no UI, and the pairing dialog would name an address that shows nothing.
const webRoot = process.env.WEB_DIST ?? './web/dist';
if (existsSync(webRoot)) {
  const index = path.join(webRoot, 'index.html');
  const openGraph = new OpenGraph(librariesService, shootsService, albumsService, photoReadService);
  app.use(route(PathSegment.any()), serveStatic({ root: webRoot }));
  // The client is a single-page app: every route it owns is a path this server
  // has never heard of, so a reload on one has to answer with the shell rather
  // than a 404. Last, so it can only catch what nothing above it claimed.
  app.get(route(PathSegment.any()), async (c) => {
    if (c.req.path.startsWith(route(PathSegment.api())) || c.req.path.startsWith(route(PathSegment.image()))) return c.notFound();
    return c.html(openGraph.inject(await Bun.file(index).text(), c));
  });
  log.info('serving the web client', { root: webRoot });
}

// Built once and re-configured on every edit, rather than read at startup: these
// are settings now (§15), and a knob on the settings page that only takes effect
// after a restart is a knob nobody trusts.
const watcher = new LibraryWatcher(
  librariesRepo,
  scanService,
  settingsRepo.get().watch_debounce_ms,
  settingsRepo.get().watch_poll_interval_ms,
);
librariesService.addLifecycleListener(watcher);
// An excluded folder is half of what the watcher decides what to watch by, and
// it is written from the settings page and from both halves of creating and
// deleting a shoot - none of which go through the library (§4.7).
folderRulesRepo.onChange((libraryId) => {
  const library = librariesRepo.getById(libraryId);
  if (library != null) watcher.onLibraryUpdated(library);
});
// The other half of what the watcher watches: a scan that followed a renamed bin
// folder wrote `bin_name` itself, and the ignore list is built from it.
scanService.onLibraryChanged((library) => watcher.onLibraryUpdated(library));
transferService.kick();
// Staged bytes from transfers that will never come back - a sender that died, one
// cancelled on the other side - sit inside the library root where nothing else
// looks. Swept once here, after the queue has taken back what it is still owed, so
// what is swept is only what nothing is waiting on.
void transferService.sweepAbandonedStages().catch((err: unknown) => {
  log.warn('could not sweep abandoned staged originals', { err: String(err) });
});
// The scan is what proves what is actually on disk, so it is also what corrects
// this peer's own claims about what it holds (§7.2).
//
// After every scan that changed something, not just one that rewrote the library
// row - which today means a renamed bin folder and nothing else. Hung there, a
// photograph imported on this device was never recorded as held here unless
// somebody happened to press push or fetch, so every other peer's catalogue
// showed it with no holder at all - and the count of originals that exist nowhere
// else, which is the whole of the warning before forgetting a peer (§8.4), was
// taken from that.
// After every scan, and deliberately not only the ones that added or changed a
// photograph: `changed` counts those two and not removals, and a file that has
// gone is precisely what the retraction half of this exists for. A row left
// claiming an original this peer no longer has is the one other peers read to
// decide whether a photograph exists anywhere else - so a library being culled
// rather than imported into would go on promising copies it does not hold, and
// the warning before forgetting a peer would undercount what goes with it.
//
// The cost is a stat per photograph, on the heels of a scan that just walked the
// whole tree anyway.
scanService.onSettled((libraryId) => {
  const library = librariesRepo.getById(libraryId);
  if (library != null) void blobLocations.reconcile(library);
});
const dailyScan = new DailyScan(scanService);
const scheduledPrune = new ScheduledPrune(new PruneService(librariesRepo, photoMetadataRepo));
const scheduledBackup = new ScheduledBackup(new BackupService(config.dbPath));

function applySettings(settings: Settings): void {
  setLogLevel(settings.log_level);
  watcher.configure(settings.watch_enabled, settings.watch_debounce_ms, settings.watch_poll_interval_ms);
  dailyScan.configure(settings.full_sync_at);
  scheduledPrune.configure(settings.prune_every_days);
  scheduledBackup.configure(settings.backup_every_days, settings.backup_keep);
}
settingsRepo.onChange(applySettings);
applySettings(settingsRepo.get());

// Photos edited by a session that never got to say it had finished: a tab closed, a
// navigation the client did not handle, a process killed between the save and the
// render. The editor asks for its rebuild when it closes, and this is what makes that
// an optimisation rather than the only chance - the queue is keyed on the edits being
// newer than the render, which is true however the photo came to be that way.
{
  const stale = processingService.rebuildEdited();
  if (stale > 0) log.info('queued edited photos whose renders were never rebuilt', { photos: stale });
}

// Replication state whose library is gone: the listener that clears it runs after
// the row is deleted and in its own transaction, so a kill between the two leaves
// it behind - and a re-add of the same library id would then be told this device
// already holds everything (§8.4).
{
  const orphaned = forgetOrphanedLibraries(db);
  if (orphaned > 0) log.info('cleared replication state for libraries that are gone', { libraries: orphaned });
}

// Catalogues catch up by themselves once a library has peers; the originals stay
// where they are until somebody asks (docs/replication.md §7.3).
replicationRunner.start();

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
  // Bun's default is 128MB, and a client's `max` rendition of a 61MP frame is 366MB of PQ samples
  // before gzip takes its share.
  maxRequestBodySize: 1024 * 1024 * 1024,
  // The server itself is handed to the routes, because 255 seconds is Bun's
  // ceiling and a replica being born legitimately runs past it: a whole
  // catalogue arrives before that request answers. Only the routes that know
  // they are that long lift it, per request (§9).
  fetch: (request, listening) => app.fetch(request, { server: listening }),
});
const settings = settingsRepo.get();
log.info(`listening on http://${config.host}:${server.port}`, {
  version: VERSION,
  db: config.dbPath,
  logLevel: settings.log_level,
  processingConcurrency: settings.processing_concurrency,
  libraries: librariesRepo.list().length,
});
