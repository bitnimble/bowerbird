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
import { SettingsPage } from '../features/settings/settings_page';
import { ShootPhotosPage } from '../features/shoots/shoot_photos_page';
import { ShootsPage } from '../features/shoots/shoots_page';
import { Toasts } from '../features/toasts/toasts';
import { Button, ICON, Modal, Text } from '../ui/ui';
import { useLibrariesStore, usePhotosStore, usePresenters, useShootsStore } from './stores_context';

// Which library the user is inside. Only /libraries/* names it in the URL; shoot
// and photo routes resolve it from the loaded entity, so the rail keeps its
// context instead of blanking out as soon as you open a shoot or a photo.
function useCurrentLibraryId(): string | null {
  const { pathname } = useLocation();
  const shoots = useShootsStore();
  const photos = usePhotosStore();

  const library = /^\/libraries\/([^/]+)/.exec(pathname);
  if (library?.[1] != null) return library[1];

  const shoot = /^\/shoots\/([^/]+)/.exec(pathname);
  if (shoot?.[1] != null) return shoots.byId.get(shoot[1])?.library_id ?? null;

  // detailLibraryId is a computed, so navigating between photos in one library
  // produces the same value and re-renders nothing here.
  if (/^\/photos\//.test(pathname)) return photos.detailLibraryId;

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
  ['F', 'Fullscreen (photo view)'],
  ['I', "Show the camera's JPEG (photo view)"],
  ['O', 'Show the render from RAW (photo view)'],
  ['Esc', 'Clear selection, or leave a photo'],
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

const RAIL_KEY = 'bowerbird.rail.collapsed';

export function App(): JSX.Element {
  // Remembered, because the rail is chrome: having to re-hide it on every visit
  // is the same annoyance as it never collapsing at all.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RAIL_KEY) === '1');

  function toggleRail(): void {
    setCollapsed((was) => {
      const next = !was;
      localStorage.setItem(RAIL_KEY, next ? '1' : '0');
      return next;
    });
  }

  return (
    <div className={`shell${collapsed ? ' shell--collapsed' : ''}`}>
      <EnsureLibraries />
      <ServerEvents />
      {!collapsed && <Rail onCollapse={toggleRail} />}
      <div className="main">
        {/* Only the expand button floats over the content; collapsing is done
            from inside the rail, where there is a row to put it in. */}
        {collapsed && (
          <Button className="rail__toggle" iconOnly aria-label="Show sidebar" aria-expanded={false} onClick={toggleRail}>
            <PanelLeftOpen size={ICON} />
          </Button>
        )}
        <Toasts />
        <div className="content">
          <Routes>
            <Route path="/" element={<Navigate to="/settings" replace />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/libraries/:libraryId" element={<LibraryPhotosPage />} />
            <Route path="/libraries/:libraryId/shoots" element={<ShootsPage />} />
            <Route path="/libraries/:libraryId/bin" element={<BinPage />} />
            <Route path="/shoots/:shootId" element={<ShootPhotosPage />} />
            <Route path="/albums" element={<AlbumsPage />} />
            <Route path="/albums/:albumId" element={<AlbumPhotosPage />} />
            <Route path="/photos/:photoId" element={<PhotoDetailPage />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
