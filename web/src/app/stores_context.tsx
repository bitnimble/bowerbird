import { createContext, useContext, useState, type ReactNode } from 'react';
import { AlbumsPresenter } from '../features/albums/albums_presenter';
import { AlbumsStore } from '../features/albums/albums_store';
import { EventsPresenter } from '../features/events/events_presenter';
import { ExportPresenter } from '../features/export/export_presenter';
import { ExportStore } from '../features/export/export_store';
import { ExportHistoryPresenter } from '../features/exports/export_history_presenter';
import { ExportHistoryStore } from '../features/exports/export_history_store';
import { LibrariesPresenter } from '../features/libraries/libraries_presenter';
import { LibrariesStore } from '../features/libraries/libraries_store';
import { PhotosPresenter } from '../features/photos/photos_presenter';
import { ListingStore } from '../features/photos/grid/listing_store';
import { MarksStore } from '../features/photos/grid/marks_store';
import { StacksStore } from '../features/photos/grid/stacks_store';
import { ViewerStore } from '../features/photos/viewer/viewer_store';
import { ReplicationPresenter } from '../features/replication/replication_presenter';
import { ReplicationStore } from '../features/replication/replication_store';
import { ShootsPresenter } from '../features/shoots/shoots_presenter';
import { ShootsStore } from '../features/shoots/shoots_store';
import { StackTriagePresenter } from '../features/photos/stack_triage/stack_triage_presenter';
import { StackTriageStore } from '../features/photos/stack_triage/stack_triage_store';
import { ScanPresenter } from '../features/scan/scan_presenter';
import { ScanStore } from '../features/scan/scan_store';
import { AppSettingsPresenter } from '../features/settings/app_settings_presenter';
import { AppSettingsStore } from '../features/settings/app_settings_store';
import { DeviceSettingsPresenter } from '../features/settings/device_settings_presenter';
import { DeviceSettingsStore } from '../features/settings/device_settings_store';
import { ToastsPresenter } from '../features/toasts/toasts_presenter';
import { ToastsStore } from '../features/toasts/toasts_store';
import { UpdatesPresenter } from '../features/updates/updates_presenter';
import { UpdatesStore } from '../features/updates/updates_store';
import { SidebarPresenter } from './sidebar_presenter';
import { SidebarStore } from './sidebar_store';

// Peer stores, each with its own context: components subscribe to the one domain
// they read, and nothing can reach a god-object of everything.
const LibrariesStoreContext = createContext<LibrariesStore | null>(null);
const ListingStoreContext = createContext<ListingStore | null>(null);
const MarksStoreContext = createContext<MarksStore | null>(null);
const StacksStoreContext = createContext<StacksStore | null>(null);
const ViewerStoreContext = createContext<ViewerStore | null>(null);
const ShootsStoreContext = createContext<ShootsStore | null>(null);
const AlbumsStoreContext = createContext<AlbumsStore | null>(null);
const ScanStoreContext = createContext<ScanStore | null>(null);
const ReplicationStoreContext = createContext<ReplicationStore | null>(null);
const ToastsStoreContext = createContext<ToastsStore | null>(null);
const AppSettingsStoreContext = createContext<AppSettingsStore | null>(null);
const DeviceSettingsStoreContext = createContext<DeviceSettingsStore | null>(null);
const StackTriageStoreContext = createContext<StackTriageStore | null>(null);
const ExportStoreContext = createContext<ExportStore | null>(null);
const ExportHistoryStoreContext = createContext<ExportHistoryStore | null>(null);
const UpdatesStoreContext = createContext<UpdatesStore | null>(null);
const SidebarStoreContext = createContext<SidebarStore | null>(null);

interface Presenters {
  libraries: LibrariesPresenter;
  photos: PhotosPresenter;
  shoots: ShootsPresenter;
  albums: AlbumsPresenter;
  scan: ScanPresenter;
  replication: ReplicationPresenter;
  toasts: ToastsPresenter;
  appSettings: AppSettingsPresenter;
  deviceSettings: DeviceSettingsPresenter;
  events: EventsPresenter;
  stackTriage: StackTriagePresenter;
  export: ExportPresenter;
  exportHistory: ExportHistoryPresenter;
  updates: UpdatesPresenter;
  sidebar: SidebarPresenter;
}

const PresentersContext = createContext<Presenters | null>(null);

function build(): { stores: Stores; presenters: Presenters } {
  const appSettingsStore = new AppSettingsStore();
  const librariesStore = new LibrariesStore();
  const stacksStore = new StacksStore();
  const listingStore = new ListingStore(stacksStore);
  const marksStore = new MarksStore(listingStore, stacksStore);
  const viewerStore = new ViewerStore(listingStore, stacksStore);
  const stores: Stores = {
    libraries: librariesStore,
    // One-way photo graph: listing reads stack expansions for layout; marks reads listing and
    // stacks for selection; viewer reads listing and stacks for the open run.
    listing: listingStore,
    marks: marksStore,
    stacks: stacksStore,
    viewer: viewerStore,
    shoots: new ShootsStore(),
    albums: new AlbumsStore(),
    scan: new ScanStore(),
    replication: new ReplicationStore(),
    toasts: new ToastsStore(),
    appSettings: appSettingsStore,
    deviceSettings: new DeviceSettingsStore(),
    // The setting and the library, for the same question the server answers per photo for
    // the viewer (`shown_rendition`): a triage session judges a whole tournament at one
    // fixed rendition rather than per photo, so it resolves its own instead (§20.4).
    stackTriage: new StackTriageStore(appSettingsStore, librariesStore),
    // No peers: the dialog is handed the photographs to export and the frame to size its
    // estimate against, so it reads nothing another store owns.
    export: new ExportStore(),
    // What those runs left behind, which the server holds and this only lists.
    exportHistory: new ExportHistoryStore(),
    updates: new UpdatesStore(),
    // Which sections are open is about this browser, and the shoots it lists arrive from
    // whoever read them last. The settings say whether the viewer hides it.
    sidebar: new SidebarStore(appSettingsStore),
  };

  // Wiring order encodes the dependency direction: shoots/albums presenters know
  // nothing of photos, photos calls into them, scan drives photos.
  const toasts = new ToastsPresenter(stores.toasts);
  // The sidebar lists every library's shoots, so it takes a copy of whatever the
  // Shoots page reads rather than fetching the same list a second time.
  const sidebar = new SidebarPresenter(stores.sidebar);
  const shoots = new ShootsPresenter(stores.shoots, sidebar);
  const albums = new AlbumsPresenter(stores.albums);
  const appSettings = new AppSettingsPresenter(stores.appSettings, toasts);
  // A finished scan moves the library's photo count, and sorting a grid edits
  // the collection it is of, so both write through the presenter that owns it.
  const libraries = new LibrariesPresenter(stores.libraries, toasts);
  const deviceSettings = new DeviceSettingsPresenter(stores.deviceSettings);
  const photos = new PhotosPresenter(
    stores.listing,
    stores.marks,
    stores.stacks,
    stores.viewer,
    libraries,
    shoots,
    albums,
    toasts,
    stores.appSettings,
    appSettings,
    stores.deviceSettings,
  );
  const replication = new ReplicationPresenter(stores.replication, stores.libraries, libraries, photos, toasts);
  // Writes every verdict through the photos presenter, so the gallery behind the session
  // keeps its rows correct.
  const stackTriage = new StackTriagePresenter(stores.stackTriage, photos);
  // Announcements land on the rows the views render from, so this writes through
  // the presenters that own them - a triage session included, whose members are rows
  // no other presenter is holding.
  // Reports through the toasts like every other action that finishes off screen, and shows
  // its progress there too while the sidebar that otherwise shows it is hidden.
  const exportPhotos = new ExportPresenter(stores.export, stores.sidebar, toasts);
  const events = new EventsPresenter(photos, replication, stackTriage, exportPhotos);
  const presenters: Presenters = {
    libraries,
    photos,
    shoots,
    albums,
    scan: new ScanPresenter(stores.scan, photos, libraries),
    replication,
    toasts,
    appSettings,
    deviceSettings,
    events,
    stackTriage,
    export: exportPhotos,
    exportHistory: new ExportHistoryPresenter(stores.exportHistory, toasts),
    updates: new UpdatesPresenter(stores.updates),
    sidebar,
  };
  return { stores, presenters };
}

interface Stores {
  libraries: LibrariesStore;
  listing: ListingStore;
  marks: MarksStore;
  stacks: StacksStore;
  viewer: ViewerStore;
  shoots: ShootsStore;
  albums: AlbumsStore;
  scan: ScanStore;
  replication: ReplicationStore;
  toasts: ToastsStore;
  appSettings: AppSettingsStore;
  deviceSettings: DeviceSettingsStore;
  stackTriage: StackTriageStore;
  export: ExportStore;
  exportHistory: ExportHistoryStore;
  updates: UpdatesStore;
  sidebar: SidebarStore;
}

export function StoresProvider({ children }: { children: ReactNode }): JSX.Element {
  const [{ stores, presenters }] = useState(build);
  return (
    <PresentersContext.Provider value={presenters}>
      <LibrariesStoreContext.Provider value={stores.libraries}>
        <ListingStoreContext.Provider value={stores.listing}>
          <MarksStoreContext.Provider value={stores.marks}>
            <StacksStoreContext.Provider value={stores.stacks}>
              <ViewerStoreContext.Provider value={stores.viewer}>
                <ShootsStoreContext.Provider value={stores.shoots}>
                  <AlbumsStoreContext.Provider value={stores.albums}>
                    <ScanStoreContext.Provider value={stores.scan}>
                      <ReplicationStoreContext.Provider value={stores.replication}>
                        <ToastsStoreContext.Provider value={stores.toasts}>
                          <AppSettingsStoreContext.Provider value={stores.appSettings}>
                            <DeviceSettingsStoreContext.Provider value={stores.deviceSettings}>
                              <StackTriageStoreContext.Provider value={stores.stackTriage}>
                                <ExportStoreContext.Provider value={stores.export}>
                                  <ExportHistoryStoreContext.Provider value={stores.exportHistory}>
                                    <UpdatesStoreContext.Provider value={stores.updates}>
                                      <SidebarStoreContext.Provider value={stores.sidebar}>
                                        {children}
                                      </SidebarStoreContext.Provider>
                                    </UpdatesStoreContext.Provider>
                                  </ExportHistoryStoreContext.Provider>
                                </ExportStoreContext.Provider>
                              </StackTriageStoreContext.Provider>
                            </DeviceSettingsStoreContext.Provider>
                          </AppSettingsStoreContext.Provider>
                        </ToastsStoreContext.Provider>
                      </ReplicationStoreContext.Provider>
                    </ScanStoreContext.Provider>
                  </AlbumsStoreContext.Provider>
                </ShootsStoreContext.Provider>
              </ViewerStoreContext.Provider>
            </StacksStoreContext.Provider>
          </MarksStoreContext.Provider>
        </ListingStoreContext.Provider>
      </LibrariesStoreContext.Provider>
    </PresentersContext.Provider>
  );
}

function required<T>(value: T | null, name: string): T {
  if (value == null) throw new Error(`${name} used outside StoresProvider`);
  return value;
}

export const useLibrariesStore = (): LibrariesStore => required(useContext(LibrariesStoreContext), 'LibrariesStore');
export const useListingStore = (): ListingStore => required(useContext(ListingStoreContext), 'ListingStore');
export const useMarksStore = (): MarksStore => required(useContext(MarksStoreContext), 'MarksStore');
export const useStacksStore = (): StacksStore => required(useContext(StacksStoreContext), 'StacksStore');
export const useViewerStore = (): ViewerStore => required(useContext(ViewerStoreContext), 'ViewerStore');
export const useShootsStore = (): ShootsStore => required(useContext(ShootsStoreContext), 'ShootsStore');
export const useAlbumsStore = (): AlbumsStore => required(useContext(AlbumsStoreContext), 'AlbumsStore');
export const useScanStore = (): ScanStore => required(useContext(ScanStoreContext), 'ScanStore');
export const useReplicationStore = (): ReplicationStore =>
  required(useContext(ReplicationStoreContext), 'ReplicationStore');
export const useToastsStore = (): ToastsStore => required(useContext(ToastsStoreContext), 'ToastsStore');
export const useAppSettingsStore = (): AppSettingsStore => required(useContext(AppSettingsStoreContext), 'AppSettingsStore');
export const useDeviceSettingsStore = (): DeviceSettingsStore =>
  required(useContext(DeviceSettingsStoreContext), 'DeviceSettingsStore');
export const useStackTriageStore = (): StackTriageStore => required(useContext(StackTriageStoreContext), 'StackTriageStore');
export const useExportStore = (): ExportStore => required(useContext(ExportStoreContext), 'ExportStore');
export const useExportHistoryStore = (): ExportHistoryStore => required(useContext(ExportHistoryStoreContext), 'ExportHistoryStore');
export const useUpdatesStore = (): UpdatesStore => required(useContext(UpdatesStoreContext), 'UpdatesStore');
export const useSidebarStore = (): SidebarStore => required(useContext(SidebarStoreContext), 'SidebarStore');
export const usePresenters = (): Presenters => required(useContext(PresentersContext), 'Presenters');
