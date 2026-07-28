import { createContext, useContext, useState, type ReactNode } from 'react';
import { AlbumsPresenter } from '../features/albums/albums_presenter';
import { AlbumsStore } from '../features/albums/albums_store';
import { EventsPresenter } from '../features/events/events_presenter';
import { EventsStore } from '../features/events/events_store';
import { LibrariesPresenter } from '../features/libraries/libraries_presenter';
import { LibrariesStore } from '../features/libraries/libraries_store';
import { PhotosPresenter } from '../features/photos/photos_presenter';
import { PhotosStore } from '../features/photos/photos_store';
import { ShootsPresenter } from '../features/shoots/shoots_presenter';
import { ShootsStore } from '../features/shoots/shoots_store';
import { SyncPresenter } from '../features/sync/sync_presenter';
import { SyncStore } from '../features/sync/sync_store';
import { AppSettingsPresenter } from '../features/settings/app_settings_presenter';
import { AppSettingsStore } from '../features/settings/app_settings_store';
import { ServerConfigPresenter } from '../features/settings/server_config_presenter';
import { ServerConfigStore } from '../features/settings/server_config_store';
import { ToastsPresenter } from '../features/toasts/toasts_presenter';
import { ToastsStore } from '../features/toasts/toasts_store';

// Peer stores, each with its own context: components subscribe to the one domain
// they read, and nothing can reach a god-object of everything.
const LibrariesStoreContext = createContext<LibrariesStore | null>(null);
const PhotosStoreContext = createContext<PhotosStore | null>(null);
const ShootsStoreContext = createContext<ShootsStore | null>(null);
const AlbumsStoreContext = createContext<AlbumsStore | null>(null);
const SyncStoreContext = createContext<SyncStore | null>(null);
const ToastsStoreContext = createContext<ToastsStore | null>(null);
const ServerConfigStoreContext = createContext<ServerConfigStore | null>(null);
const AppSettingsStoreContext = createContext<AppSettingsStore | null>(null);
const EventsStoreContext = createContext<EventsStore | null>(null);

interface Presenters {
  libraries: LibrariesPresenter;
  photos: PhotosPresenter;
  shoots: ShootsPresenter;
  albums: AlbumsPresenter;
  sync: SyncPresenter;
  toasts: ToastsPresenter;
  serverConfig: ServerConfigPresenter;
  appSettings: AppSettingsPresenter;
  events: EventsPresenter;
}

const PresentersContext = createContext<Presenters | null>(null);

function build(): { stores: Stores; presenters: Presenters } {
  // The viewer's opening rendition is a setting, so the photos store reads it.
  const appSettingsStore = new AppSettingsStore();
  const stores: Stores = {
    libraries: new LibrariesStore(),
    photos: new PhotosStore(appSettingsStore),
    shoots: new ShootsStore(),
    albums: new AlbumsStore(),
    sync: new SyncStore(),
    toasts: new ToastsStore(),
    serverConfig: new ServerConfigStore(),
    appSettings: appSettingsStore,
    events: new EventsStore(),
  };

  // Wiring order encodes the dependency direction: shoots/albums presenters know
  // nothing of photos, photos calls into them, sync drives photos.
  const toasts = new ToastsPresenter(stores.toasts);
  const shoots = new ShootsPresenter(stores.shoots);
  const albums = new AlbumsPresenter(stores.albums);
  const appSettings = new AppSettingsPresenter(stores.appSettings);
  const events = new EventsPresenter(stores.events);
  const photos = new PhotosPresenter(stores.photos, shoots, albums, toasts, stores.appSettings, appSettings, events);
  const presenters: Presenters = {
    libraries: new LibrariesPresenter(stores.libraries),
    photos,
    shoots,
    albums,
    sync: new SyncPresenter(stores.sync, photos),
    toasts,
    serverConfig: new ServerConfigPresenter(stores.serverConfig),
    appSettings,
    events,
  };
  return { stores, presenters };
}

interface Stores {
  libraries: LibrariesStore;
  photos: PhotosStore;
  shoots: ShootsStore;
  albums: AlbumsStore;
  sync: SyncStore;
  toasts: ToastsStore;
  serverConfig: ServerConfigStore;
  appSettings: AppSettingsStore;
  events: EventsStore;
}

export function StoresProvider({ children }: { children: ReactNode }): JSX.Element {
  const [{ stores, presenters }] = useState(build);
  return (
    <PresentersContext.Provider value={presenters}>
      <LibrariesStoreContext.Provider value={stores.libraries}>
        <PhotosStoreContext.Provider value={stores.photos}>
          <ShootsStoreContext.Provider value={stores.shoots}>
            <AlbumsStoreContext.Provider value={stores.albums}>
              <SyncStoreContext.Provider value={stores.sync}>
                <ToastsStoreContext.Provider value={stores.toasts}>
                  <ServerConfigStoreContext.Provider value={stores.serverConfig}>
                    <AppSettingsStoreContext.Provider value={stores.appSettings}>
                      <EventsStoreContext.Provider value={stores.events}>{children}</EventsStoreContext.Provider>
                    </AppSettingsStoreContext.Provider>
                  </ServerConfigStoreContext.Provider>
                </ToastsStoreContext.Provider>
              </SyncStoreContext.Provider>
            </AlbumsStoreContext.Provider>
          </ShootsStoreContext.Provider>
        </PhotosStoreContext.Provider>
      </LibrariesStoreContext.Provider>
    </PresentersContext.Provider>
  );
}

function required<T>(value: T | null, name: string): T {
  if (value == null) throw new Error(`${name} used outside StoresProvider`);
  return value;
}

export const useLibrariesStore = (): LibrariesStore => required(useContext(LibrariesStoreContext), 'LibrariesStore');
export const usePhotosStore = (): PhotosStore => required(useContext(PhotosStoreContext), 'PhotosStore');
export const useShootsStore = (): ShootsStore => required(useContext(ShootsStoreContext), 'ShootsStore');
export const useAlbumsStore = (): AlbumsStore => required(useContext(AlbumsStoreContext), 'AlbumsStore');
export const useSyncStore = (): SyncStore => required(useContext(SyncStoreContext), 'SyncStore');
export const useToastsStore = (): ToastsStore => required(useContext(ToastsStoreContext), 'ToastsStore');
export const useServerConfigStore = (): ServerConfigStore => required(useContext(ServerConfigStoreContext), 'ServerConfigStore');
export const useAppSettingsStore = (): AppSettingsStore => required(useContext(AppSettingsStoreContext), 'AppSettingsStore');
export const useEventsStore = (): EventsStore => required(useContext(EventsStoreContext), 'EventsStore');
export const usePresenters = (): Presenters => required(useContext(PresentersContext), 'Presenters');
