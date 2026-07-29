import { createContext, useContext, useState, type ReactNode } from 'react';
import { AlbumsPresenter } from '../features/albums/albums_presenter';
import { AlbumsStore } from '../features/albums/albums_store';
import { EventsPresenter } from '../features/events/events_presenter';
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
const AppSettingsStoreContext = createContext<AppSettingsStore | null>(null);

interface Presenters {
  libraries: LibrariesPresenter;
  photos: PhotosPresenter;
  shoots: ShootsPresenter;
  albums: AlbumsPresenter;
  sync: SyncPresenter;
  toasts: ToastsPresenter;
  appSettings: AppSettingsPresenter;
  events: EventsPresenter;
}

const PresentersContext = createContext<Presenters | null>(null);

function build(): { stores: Stores; presenters: Presenters } {
  // Which rendition the viewer opens at is the setting's answer, bounded by what
  // the library builds, so the photos store reads both.
  const appSettingsStore = new AppSettingsStore();
  const librariesStore = new LibrariesStore();
  const stores: Stores = {
    libraries: librariesStore,
    photos: new PhotosStore(appSettingsStore, librariesStore),
    shoots: new ShootsStore(),
    albums: new AlbumsStore(),
    sync: new SyncStore(),
    toasts: new ToastsStore(),
    appSettings: appSettingsStore,
  };

  // Wiring order encodes the dependency direction: shoots/albums presenters know
  // nothing of photos, photos calls into them, sync drives photos.
  const toasts = new ToastsPresenter(stores.toasts);
  const shoots = new ShootsPresenter(stores.shoots);
  const albums = new AlbumsPresenter(stores.albums);
  const appSettings = new AppSettingsPresenter(stores.appSettings);
  // A finished sync moves the library's photo count, and sorting a gallery edits
  // the collection it is of, so both write through the presenter that owns it.
  const libraries = new LibrariesPresenter(stores.libraries);
  const photos = new PhotosPresenter(stores.photos, libraries, shoots, albums, toasts, stores.appSettings, appSettings);
  // Announcements land on the rows the views render from, so this writes through
  // the presenter that owns them.
  const events = new EventsPresenter(photos);
  const presenters: Presenters = {
    libraries,
    photos,
    shoots,
    albums,
    sync: new SyncPresenter(stores.sync, photos, libraries),
    toasts,
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
  appSettings: AppSettingsStore;
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
                  <AppSettingsStoreContext.Provider value={stores.appSettings}>{children}</AppSettingsStoreContext.Provider>
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
export const useAppSettingsStore = (): AppSettingsStore => required(useContext(AppSettingsStoreContext), 'AppSettingsStore');
export const usePresenters = (): Presenters => required(useContext(PresentersContext), 'Presenters');
