import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Image, Images, Keyboard, Layers, Library, PanelLeftClose, PanelLeftOpen, Settings, Trash2 } from 'lucide-react';
import { AlbumPhotosPage } from '../features/albums/album_photos_page';
import { AlbumsPage } from '../features/albums/albums_page';
import { libraryLabel } from '../features/libraries/library_label';
import { BinPage } from '../features/photos/bin_page';
import { LibraryPhotosPage } from '../features/photos/library_photos_page';
import { PhotoDetailPage } from '../features/photos/photo_detail_page';
import { StackTriagePage } from '../features/photos/stack_triage_page';
import { SettingsPage } from '../features/settings/settings_page';
import { ShootPhotosPage } from '../features/shoots/shoot_photos_page';
import { ShootsPage } from '../features/shoots/shoots_page';
import { Toasts } from '../features/toasts/toasts';
import { Button, ICON, Modal, Text } from '../ui/ui';
import { readSetting, writeSetting } from './local_setting';
import { useLibrariesStore, usePhotosStore, usePresenters, useShootsStore, useStackTriageStore } from './stores_context';
import { useIsMobile } from './use_is_mobile';

// Which library the user is inside. Only /libraries/* names it in the URL; shoot
// and photo routes resolve it from the loaded entity, so the rail keeps its
// context instead of blanking out as soon as you open a shoot or a photo.
function useCurrentLibraryId(): string | null {
  const { pathname } = useLocation();
  const shoots = useShootsStore();
  const photos = usePhotosStore();
  const triage = useStackTriageStore();

  const library = /^\/libraries\/([^/]+)/.exec(pathname);
  if (library?.[1] != null) return library[1];

  const shoot = /^\/shoots\/([^/]+)/.exec(pathname);
  if (shoot?.[1] != null) return shoots.byId.get(shoot[1])?.library_id ?? null;

  // detailLibraryId is a computed, so navigating between photos in one library
  // produces the same value and re-renders nothing here.
  if (pathname.includes('/photos/')) return photos.detailLibraryId;

  // A triage session is inside the library its stack belongs to, so the rail
  // keeps its context for the length of it rather than blanking out.
  if (pathname.includes('/stacks/')) return triage.members.values().next().value?.library_id ?? null;

  return null;
}

const railClass = ({ isActive }: { isActive: boolean }): string => `rail__link${isActive ? ' rail__link--active' : ''}`;

// Every registered library is always listed, and the active one expands to its
// sections. There is no "pick a library first" screen: adding a library is a
// setup step, not something you navigate through on every visit.
const LibraryNav = observer(function LibraryNav({ activeId }: { activeId: string | null }): JSX.Element {
  const libraries = useLibrariesStore();

  if (libraries.libraries.length === 0) {
    return (
      <div className="rail__section">
        <Text variant="label" as="div">
          Libraries
        </Text>
        <NavLink to="/settings" className={railClass}>
          <Settings size={ICON} />
          Add a library
        </NavLink>
      </div>
    );
  }

  return (
    <div className="rail__section">
      <Text variant="label" as="div">
        Libraries
      </Text>
      {libraries.libraries.map((library) => {
        const active = library.id === activeId;
        return (
          <div key={library.id}>
            <NavLink end to={`/libraries/${library.id}`} className={railClass} title={library.root_path}>
              <Library size={ICON} />
              <span className="rail__text">{libraryLabel(library)}</span>
              <span className="rail__count">{library.photo_count}</span>
            </NavLink>
            {active && (
              <div className="rail__sub">
                {/* One picture, because Albums is the stacked icon. */}
                <NavLink end to={`/libraries/${library.id}`} className={railClass}>
                  <Image size={ICON} />
                  Photos
                </NavLink>
                <NavLink to={`/libraries/${library.id}/shoots`} className={railClass}>
                  <Layers size={ICON} />
                  Shoots
                </NavLink>
                <NavLink to={`/libraries/${library.id}/bin`} className={railClass}>
                  <Trash2 size={ICON} />
                  Bin
                </NavLink>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

const Rail = observer(function Rail({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const libraryId = useCurrentLibraryId();
  // Sections stay open on the library you were last in. Collapsing them the
  // moment you visit Albums or Settings means losing your place in the rail and
  // having to click back into the library to get it back.
  const [lastLibraryId, setLastLibraryId] = useState<string | null>(libraryId);
  useEffect(() => {
    if (libraryId != null) setLastLibraryId(libraryId);
  }, [libraryId]);

  return (
    <nav className="rail">
      <div className="brand">
        <div>
          <div className="brand__mark">Bowerbird</div>
          <div className="brand__bower" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </div>
        <Button iconOnly aria-label="Hide sidebar" aria-expanded onClick={onCollapse}>
          <PanelLeftClose size={ICON} />
        </Button>
      </div>

      <LibraryNav activeId={libraryId ?? lastLibraryId} />

      <div className="rail__section">
        <Text variant="label" as="div">
          Catalogue
        </Text>
        <NavLink to="/albums" className={railClass}>
          <Images size={ICON} />
          Albums
        </NavLink>
      </div>

      {/* Settings and the shortcut sheet are both "about the app" rather than
          about the photographs, so they sit together, away from the catalogue. */}
      <div className="rail__section rail__section--app">
        <NavLink to="/settings" className={railClass}>
          <Settings size={ICON} />
          Settings
        </NavLink>
        <ShortcutHelp />
      </div>
    </nav>
  );
});

// Library-scoped routes are reachable by deep link, and the rail lists libraries
// on every screen, so the list must load regardless of where the user landed.
const EnsureLibraries = observer(function EnsureLibraries(): null {
  const libraries = useLibrariesStore();
  const { libraries: presenter } = usePresenters();
  useEffect(() => {
    if (libraries.libraries.length === 0) void presenter.load();
  }, [libraries, presenter]);
  return null;
});

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

// One place that states the cull keybindings, reachable with ? from anywhere.
// C and X are neighbours so the left hand can pick and reject without moving
// while the right hand drives the arrow keys.
const SHORTCUTS: [string, string][] = [
  ['← → ↑ ↓', 'Move between photos'],
  ['0 – 5', 'Set rating'],
  ['C', 'Pick / clear'],
  ['X', 'Reject'],
  ['Del', 'Move to Bin'],
  ['Space', 'Add to selection'],
  ['Enter', 'Open the photo (or the stack)'],
  ['F', 'Fullscreen (photo view)'],
  ['I', "Show the camera's JPEG (photo view)"],
  ['O', 'Show the render from RAW (photo view)'],
  ['Esc', 'Clear selection, or leave a photo'],
  ['← →', 'Prefer the left / right photo (Triage stack)'],
  ['↓ / Space', 'Keep both (Triage stack)'],
  ['Shift (hold)', 'Peek at the other photo (Triage stack, Flip)'],
  ['⌘Z / Backspace', 'Undo the last round (Triage stack)'],
  ['V', 'Switch Flip and Split (Triage stack)'],
  ['↑ ↓', 'Move between folders (Shoots)'],
  ['→ ←', 'Open / close a folder (Shoots)'],
  ['Home / End', 'First / last folder (Shoots)'],
];

function ShortcutHelp(): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === '?') setOpen((v) => !v);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button className="rail__link rail__help" onClick={() => setOpen(true)}>
        <Keyboard size={ICON} />
        Shortcuts
        <span className="rail__count">?</span>
      </button>
      <Modal open={open} onOpenChange={setOpen} title="Keyboard shortcuts">
        <dl className="meta">
          {SHORTCUTS.map(([keys, what]) => (
            <Fragment key={keys}>
              <dt>{keys}</dt>
              <dd>{what}</dd>
            </Fragment>
          ))}
        </dl>
      </Modal>
    </>
  );
}

// Every grid a photo can be opened from. `collectionPath` builds the concrete
// path for one, and `sourceOfPath` reads it back, so the three stay in step.
const COLLECTIONS = ['/libraries/:libraryId', '/libraries/:libraryId/bin', '/shoots/:shootId', '/albums/:albumId'];

const RAIL_KEY = 'bowerbird.rail.collapsed';

// Nothing to land on until the libraries are known: with one registered the
// photographs are the home screen, and only a fresh install starts in Settings.
const Home = observer(function Home(): JSX.Element | null {
  const libraries = useLibrariesStore();
  if (libraries.loading) return null;
  const first = libraries.libraries[0];
  return <Navigate to={first == null ? '/settings' : `/libraries/${first.id}`} replace />;
});

export function App(): JSX.Element {
  // Where the rail overlays the content, its open state is a different thing:
  // transient, closed by default, rather than the remembered chrome preference
  // it is on a desktop.
  const mobile = useIsMobile();
  // Remembered, because the rail is chrome: having to re-hide it on every visit
  // is the same annoyance as it never collapsing at all.
  const [collapsed, setCollapsed] = useState(() => readSetting(RAIL_KEY) === '1');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();

  // Tapping a link asked for the page, not for the drawer to stay over it.
  useEffect(() => setDrawerOpen(false), [pathname]);

  function toggleRail(): void {
    if (mobile) {
      setDrawerOpen((was) => !was);
      return;
    }
    setCollapsed((was) => {
      const next = !was;
      writeSetting(RAIL_KEY, next ? '1' : '0');
      return next;
    });
  }

  const railOpen = mobile ? drawerOpen : !collapsed;

  return (
    <div className={`shell${railOpen && !mobile ? '' : ' shell--collapsed'}`}>
      <EnsureLibraries />
      <ServerEvents />
      {mobile && drawerOpen && <div className="rail__scrim" onClick={toggleRail} />}
      {railOpen && <Rail onCollapse={toggleRail} />}
      <div className="main">
        {/* Only the expand button floats over the content; collapsing is done
            from inside the rail, where there is a row to put it in. */}
        {!railOpen && (
          <Button className="rail__toggle" iconOnly aria-label="Show sidebar" aria-expanded={false} onClick={toggleRail}>
            <PanelLeftOpen size={ICON} />
          </Button>
        )}
        <Toasts />
        <div className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/libraries/:libraryId" element={<LibraryPhotosPage />} />
            <Route path="/libraries/:libraryId/shoots" element={<ShootsPage />} />
            <Route path="/libraries/:libraryId/bin" element={<BinPage />} />
            <Route path="/shoots/:shootId" element={<ShootPhotosPage />} />
            <Route path="/albums" element={<AlbumsPage />} />
            <Route path="/albums/:albumId" element={<AlbumPhotosPage />} />
            {/* Both hang off the collection they were opened from, so which grid
                the reader is in survives a reload. The bare pair below is still a
                valid deep link, and falls back to the photo's own library. */}
            {COLLECTIONS.map((prefix) => (
              <Fragment key={prefix}>
                <Route path={`${prefix}/photos/:photoId`} element={<PhotoDetailPage />} />
                <Route path={`${prefix}/stacks/:stackId/triage`} element={<StackTriagePage />} />
              </Fragment>
            ))}
            <Route path="/photos/:photoId" element={<PhotoDetailPage />} />
            <Route path="/stacks/:stackId/triage" element={<StackTriagePage />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
