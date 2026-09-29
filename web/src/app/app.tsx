import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { PathSegment, route } from '../../../src/schemas/route';
import { AlbumPhotosPage } from '../features/albums/album_photos_page';
import { AlbumsPage } from '../features/albums/albums_page';
import { HdrPage } from '../features/hdr/hdr_page';
import { BinPage } from '../features/photos/grid/bin_page';
import { LibraryPhotosPage } from '../features/photos/grid/library_photos_page';
import { MergePage } from '../features/photos/merge/merge_page';
import { PhotoDetailPage } from '../features/photos/viewer/photo_detail_page';
import { StackTriagePage } from '../features/photos/stack_triage/stack_triage_page';
import { ConflictsPage } from '../features/replication/conflicts_page';
import { SettingsPage } from '../features/settings/settings_page';
import { OnboardingPage } from '../features/onboarding/onboarding_page';
import { NoShootPhotosPage } from '../features/shoots/no_shoot_photos_page';
import { ShootPhotosPage } from '../features/shoots/shoot_photos_page';
import { ShootsPage } from '../features/shoots/shoots_page';
import { ExportDialog } from '../features/export/export_dialog';
import { ExportsPage } from '../features/exports/exports_page';
import { ReportBugDialog } from '../features/feedback/report_bug_dialog';
import { EditLabelsDialog } from '../features/labels/edit_labels_dialog';
import { Sidebar, sidebarWidth } from '../features/sidebar/sidebar';
import { SidebarResizer } from '../features/sidebar/sidebar_resizer';
import { Toasts } from '../features/toasts/toasts';
import { ConfirmDialog } from '../features/confirm/confirm_dialog';
import { UpdateDialog } from '../features/updates/update_dialog';
import { ShowSidebar } from '../ui/page';
import { drawer } from './drawer.stylex';
import { HdrOutput } from './hdr_output';
import {
  useAppSettingsStore,
  useLibrariesStore,
  usePresenters,
  useSidebarStore,
} from './stores_context';
import { useIsMobile, useIsTouch } from './device';
import { useDrawerSwipe } from './drawer_swipe';

const NARROW = '@media (max-width: 860px)';

const drawerOut = stylex.createTheme(drawer, { progress: '1' });

const styles = stylex.create({
  shell: {
    display: 'grid',
    height: '100%',
    // The resize handle hangs off the sidebar's edge from here rather than from inside the
    // sidebar, which scrolls.
    position: 'relative',
  },
  columns: (columns: string) => ({
    gridTemplateColumns: { default: columns, [NARROW]: '1fr' },
  }),
  collapsed: {
    gridTemplateColumns: '1fr',
  },
  scrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 30,
    backgroundColor: 'rgb(0 0 0 / 55%)',
    opacity: drawer.progress,
    transition: 'opacity 180ms ease',
  },
  // Nothing to ease while the finger is the thing moving it.
  following: {
    transition: { default: null, [NARROW]: 'none' },
  },
  main: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
  },
  content: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'auto',
    minHeight: 0,
  },
});

// Library-scoped routes are reachable by deep link, and the sidebar lists libraries
// on every screen, so the list must load regardless of where the user landed.
const EnsureLibraries = observer(function EnsureLibraries(): null {
  const libraries = useLibrariesStore();
  const { libraries: presenter } = usePresenters();
  useEffect(() => {
    if (libraries.libraries.length === 0) void presenter.load();
  }, [libraries, presenter]);
  return null;
});

function EnsureLabels(): null {
  const { labels } = usePresenters();
  useEffect(() => void labels.load(), [labels]);
  return null;
}

// Which libraries have peers gates every piece of replication UI, and a
// divergence is announced in the sidebar from wherever the reader is.
const EnsureReplication = observer(function EnsureReplication(): null {
  const { replication } = usePresenters();
  useEffect(() => {
    replication.follow();
    return () => replication.unfollow();
  }, [replication]);
  return null;
});

// On launch and hourly, for the session. Mounted at the root rather than on the settings
// page, because the point of it is the reader who never opens that page.
function CheckForUpdates(): null {
  const { updates } = usePresenters();
  useEffect(() => {
    updates.start();
    return () => updates.stop();
  }, [updates]);
  return null;
}

// One stream for the session rather than one per view: what it carries is about
// photos, not about whichever collection happens to be open, and a grid the user
// steps away from and back to would otherwise miss what landed in between.
function ServerEvents(): null {
  const { events } = usePresenters();
  useEffect(() => {
    events.connect();
    return () => events.disconnect();
  }, [events]);
  return null;
}

// Every grid a photo can be opened from. `collectionPath` builds the concrete
// path for one, and `sourceOfPath` reads it back, so the three stay in step.
const COLLECTIONS = [
  route(PathSegment.libraries(), PathSegment.param('libraryId')),
  route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.bin()),
  route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.noShoot()),
  route(PathSegment.shoots(), PathSegment.param('shootId')),
  route(PathSegment.albums(), PathSegment.param('albumId')),
];

const PHOTO_ROUTE = route(PathSegment.photos(), PathSegment.param('photoId'));
const TRIAGE_ROUTE = route(
  PathSegment.stacks(),
  PathSegment.param('stackId'),
  PathSegment.triage(),
);
const MERGE_ROUTE = route(PathSegment.photos(), PathSegment.merge(), PathSegment.param('jobId'));
const MERGE_EDIT_ROUTE = route(
  PathSegment.photos(),
  PathSegment.param('photoId'),
  PathSegment.merge(),
);
const MOCKUP_ROUTE = route(
  PathSegment.photos(),
  PathSegment.param('photoId'),
  PathSegment.mockup(),
);
const EDIT_ROUTE = route(PathSegment.photos(), PathSegment.param('photoId'), PathSegment.edit());

// Nothing to land on until the libraries and settings are known: a fresh install
// starts in the welcome wizard, and after it the first library's photographs are
// the home screen, or Settings where there is none.
const Home = observer(function Home(): JSX.Element | null {
  const libraries = useLibrariesStore();
  const settings = useAppSettingsStore();
  if (libraries.loading || settings.loading) return null;
  if (settings.onboardingComplete === false)
    return <Navigate to={route(PathSegment.welcome())} replace />;
  const first = libraries.libraries[0];
  return (
    <Navigate
      to={first == null ? route(PathSegment.settings()) : route(PathSegment.libraries(), first.id)}
      replace
    />
  );
});

export const App = observer(function App(): JSX.Element {
  const touch = useIsTouch();
  const sidebar = useSidebarStore();
  const { mobile, drawerOpen, open: sidebarOpen } = sidebar;
  // Mid-swipe, where the drawer is neither open nor shut but wherever the finger has it.
  const [dragging, setDragging] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const { appSettings, sidebar: sidebarPresenter } = usePresenters();

  // The sidebar decides what to do on the first photo opened, so the settings cannot
  // wait for the page that reads the rest of them.
  useEffect(() => void appSettings.load(), [appSettings]);

  // Layout effects, so the first paint is already the phone's drawer or the viewer's hidden sidebar.
  const isMobile = useIsMobile();
  useLayoutEffect(() => sidebarPresenter.setMobile(isMobile), [sidebarPresenter, isMobile]);
  useLayoutEffect(() => sidebarPresenter.navigated(pathname), [sidebarPresenter, pathname]);

  useDrawerSwipe({
    active: mobile,
    open: drawerOpen,
    setOpen: sidebarPresenter.setDrawerOpen,
    setDragging,
    shell,
  });
  const toggleSidebar = sidebarPresenter.toggleOpen;

  if (pathname === route(PathSegment.welcome())) {
    return (
      <>
        <Toasts />
        <ConfirmDialog />
        <OnboardingPage />
      </>
    );
  }

  return (
    <div
      ref={shell}
      {...stylex.props(
        styles.shell,
        styles.columns(`${sidebarWidth(sidebar.width)} 1fr`),
        (!sidebarOpen || mobile) && styles.collapsed,
        mobile && drawerOpen && drawerOut,
      )}
    >
      <HdrOutput />
      <EnsureLibraries />
      <EnsureReplication />
      <EnsureLabels />
      <ServerEvents />
      <CheckForUpdates />
      {mobile && (drawerOpen || dragging) && (
        <div
          {...stylex.props(styles.scrim, dragging && styles.following)}
          onClick={toggleSidebar}
        />
      )}
      {/* Mounted throughout on a phone, where it is a drawer positioned by a transform: a
          swipe has to have something to pull in, and something to push back out. Off screen
          it is `visibility: hidden`, so it is neither tabbable nor in the way of a tap. */}
      {(mobile || sidebarOpen) && (
        <Sidebar
          onCollapse={toggleSidebar}
          shown={(mobile && drawerOpen) || dragging}
          following={dragging}
        />
      )}
      {sidebarOpen && !mobile && !touch && <SidebarResizer />}
      <div {...stylex.props(styles.main)}>
        <Toasts />
        <ConfirmDialog />
        {/* Mounted at the root rather than beside the menu that opens it: the bulk bar's
            export is the same dialog over a selection, on a different screen. */}
        <ExportDialog />
        {/* Opened from the sidebar's badge and from Settings, so it hangs off neither. */}
        <UpdateDialog />
        {/* The same, for the sidebar's entry and the photo menu's: only one of the two knows
            a photograph, and the form is the same form either way. */}
        <ReportBugDialog />
        {/* Opened from the grid's filter menu, the bulk bar and the photo viewer. */}
        <EditLabelsDialog />
        <main {...stylex.props(styles.content)}>
          <ShowSidebar.Provider value={sidebarOpen ? null : toggleSidebar}>
            <Routes>
              <Route path={route()} element={<Home />} />
              <Route
                path={route(
                  PathSegment.settings(),
                  PathSegment.optionalParam('tab'),
                  PathSegment.optionalParam('libraryId'),
                  PathSegment.optionalParam('section'),
                )}
                element={<SettingsPage />}
              />
              <Route path={route(PathSegment.exports())} element={<ExportsPage />} />
              <Route path={route(PathSegment.hdr())} element={<HdrPage />} />
              <Route
                path={route(PathSegment.libraries(), PathSegment.param('libraryId'))}
                element={<LibraryPhotosPage />}
              />
              <Route
                path={route(
                  PathSegment.libraries(),
                  PathSegment.param('libraryId'),
                  PathSegment.shoots(),
                )}
                element={<ShootsPage />}
              />
              <Route
                path={route(
                  PathSegment.libraries(),
                  PathSegment.param('libraryId'),
                  PathSegment.bin(),
                )}
                element={<BinPage />}
              />
              <Route
                path={route(
                  PathSegment.libraries(),
                  PathSegment.param('libraryId'),
                  PathSegment.noShoot(),
                )}
                element={<NoShootPhotosPage />}
              />
              <Route
                path={route(PathSegment.shoots(), PathSegment.param('shootId'))}
                element={<ShootPhotosPage />}
              />
              <Route path={route(PathSegment.albums())} element={<AlbumsPage />} />
              <Route
                path={route(PathSegment.albums(), PathSegment.param('albumId'))}
                element={<AlbumPhotosPage />}
              />
              <Route path={route(PathSegment.editConflicts())} element={<ConflictsPage />} />
              {/* Both hang off the collection they were opened from, so which grid
                  the reader is in survives a reload. The bare pair below is still a
                  valid deep link, and falls back to the photo's own library. */}
              {COLLECTIONS.map((prefix) => (
                <Fragment key={prefix}>
                  <Route path={`${prefix}${PHOTO_ROUTE}`} element={<PhotoDetailPage />} />
                  <Route path={`${prefix}${MOCKUP_ROUTE}`} element={<PhotoDetailPage />} />
                  <Route path={`${prefix}${EDIT_ROUTE}`} element={<PhotoDetailPage />} />
                  <Route path={`${prefix}${TRIAGE_ROUTE}`} element={<StackTriagePage />} />
                  <Route path={`${prefix}${MERGE_ROUTE}`} element={<MergePage />} />
                  <Route path={`${prefix}${MERGE_EDIT_ROUTE}`} element={<MergePage />} />
                </Fragment>
              ))}
              <Route path={PHOTO_ROUTE} element={<PhotoDetailPage />} />
              <Route path={MOCKUP_ROUTE} element={<PhotoDetailPage />} />
              <Route path={EDIT_ROUTE} element={<PhotoDetailPage />} />
              <Route path={TRIAGE_ROUTE} element={<StackTriagePage />} />
              <Route path={MERGE_ROUTE} element={<MergePage />} />
              <Route path={MERGE_EDIT_ROUTE} element={<MergePage />} />
            </Routes>
          </ShowSidebar.Provider>
        </main>
      </div>
    </div>
  );
});
