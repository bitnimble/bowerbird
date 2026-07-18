import { Hono } from 'hono';
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
import { SyncService } from './services/sync/sync_service';
import { LibraryWatcher } from './services/sync/library_watcher';
import { PeriodicSync } from './services/sync/periodic_sync';
import { ProcessingService } from './services/processing/processing_service';
import { config } from './config';

const db = createDatabase(config.dbPath);

const librariesRepo = new LibrariesRepository(db);
const photosRepo = new PhotosRepository(db);
const shootsRepo = new ShootsRepository(db);
const albumsRepo = new AlbumsRepository(db);

const processingService = new ProcessingService(photosRepo, config);

const librariesService = new LibrariesService(librariesRepo);
const photosService = new PhotosService(photosRepo, albumsRepo, shootsRepo, librariesRepo);
const albumsService = new AlbumsService(albumsRepo, photosRepo);
const shootsService = new ShootsService(shootsRepo, photosRepo, librariesRepo);
const syncService = new SyncService(photosRepo, librariesRepo, albumsRepo, shootsRepo, processingService);
// Prune sync's per-library in-memory state when a library is deleted (unbounded otherwise).
librariesService.addLifecycleListener(syncService);

const librariesApi = new LibrariesApi(librariesService, syncService);
const photosApi = new PhotosApi(photosService);
const albumsApi = new AlbumsApi(albumsService, photosService);
const shootsApi = new ShootsApi(shootsService, photosService);
const imageApi = new ImageApi(photosService, librariesService);

const app = new Hono();
app.route('/api/libraries', librariesApi.routes);
app.route('/api', photosApi.routes);
app.route('/api', shootsApi.routes);
app.route('/api/albums', albumsApi.routes);
app.route('/image', imageApi.routes);

if (config.watchEnabled) {
  const watcher = new LibraryWatcher(librariesRepo, syncService, config.watchDebounceMs);
  librariesService.addLifecycleListener(watcher);
  watcher.start();
  console.log(`Filesystem watching enabled (debounce ${config.watchDebounceMs}ms)`);
}

if (config.fullSyncIntervalMs > 0) {
  new PeriodicSync(syncService, config.fullSyncIntervalMs).start();
  console.log(`Periodic full reconcile every ${Math.round(config.fullSyncIntervalMs / 1000)}s`);
}

applyErrorHandler(app);

export default { port: config.port, hostname: config.host, fetch: app.fetch };
