import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, type NavLinkProps } from 'react-router-dom';
import {
  Bug,
  ChevronDown,
  ChevronRight,
  CloudOff,
  Folder,
  FolderOutput,
  GitMerge,
  Image,
  Images,
  Layers,
  Library,
  PanelLeftClose,
  PencilOff,
  Settings,
  Sun,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { PathSegment, route } from '../../../src/schemas/route';
import { AlbumPhotosPage } from '../features/albums/album_photos_page';
import { AlbumsPage } from '../features/albums/albums_page';
import { AlbumsPageStrings } from '../features/albums/albums_page.strings';
import { HdrPage } from '../features/hdr/hdr_page';
import { HdrPageStrings } from '../features/hdr/hdr_page.strings';
import { libraryLabel } from '../features/libraries/library_label';
import { BinPage } from '../features/photos/grid/bin_page';
import { BinPageStrings } from '../features/photos/grid/bin_page.strings';
import { LibraryPhotosPage } from '../features/photos/grid/library_photos_page';
import { MergePage } from '../features/photos/merge/merge_page';
import { PhotoDetailPage } from '../features/photos/viewer/photo_detail_page';
import { StackTriagePage } from '../features/photos/stack_triage/stack_triage_page';
import { ConflictsPage } from '../features/replication/conflicts_page';
import { SettingsPage } from '../features/settings/settings_page';
import { SettingsStrings } from '../features/settings/settings_page.strings';
import { OnboardingPage } from '../features/onboarding/onboarding_page';
import { NoShootPhotosPage } from '../features/shoots/no_shoot_photos_page';
import { ShootPhotosPage } from '../features/shoots/shoot_photos_page';
import { ShootsPage } from '../features/shoots/shoots_page';
import { ShootsPageStrings } from '../features/shoots/shoots_page.strings';
import { ExportDialog } from '../features/export/export_dialog';
import { ExportsPage } from '../features/exports/exports_page';
import { ExportsPageStrings } from '../features/exports/exports_page.strings';
import { bugReporter } from '../features/feedback/report_bug';
import { ReportBugDialog } from '../features/feedback/report_bug_dialog';
import { ReportBugStrings } from '../features/feedback/report_bug_dialog.strings';
import { Toasts } from '../features/toasts/toasts';
import { UpdateBadge } from '../features/updates/update_badge';
import { UpdateDialog } from '../features/updates/update_dialog';
import { Button } from '../ui/button';
import { focusRing } from '../ui/focus_ring';
import { ICON } from '../ui/icon';
import { Tooltip } from '../ui/tooltip';
import { ShowSidebar } from '../ui/page';
import { ProgressBar } from '../ui/progress_bar';
import { Text } from '../ui/text';
import { DRAGS_WINDOW } from '../ui/title_bar';
import { color, derivedSize, font, size } from '../ui/tokens.stylex';
import { AppStrings } from './app.strings';
import { CollectionListStrings } from './collection_list.strings';
import { drawer } from './drawer.stylex';
import { HdrOutput } from './hdr_output';
import { SidebarButton, SidebarIcon, SidebarLink, SidebarText, sidebarStyles } from './sidebar_link';
import type { ShootNode } from './sidebar_store';
import {
  useAlbumsStore,
  useAppSettingsStore,
  useExportStore,
  useLibrariesStore,
  usePresenters,
  useSidebarStore,
  useReplicationStore,
} from './stores_context';
import { useIsMobile, useIsTouch } from './device';
import { useDrawerSwipe } from './drawer_swipe';

const COARSE = '@media (pointer: coarse)';
const FINE = '@media (pointer: fine)';
const NARROW = '@media (max-width: 860px)';
// A tree row reaches out past the section's padding to the sidebar's edges: a stuck parent paints
// only its own box, and any gutter beside it is a strip the rows below scroll up through.
const SECTION_PAD = '8px';
// Also where a guide rule stands in the icon column of the row it belongs to.
const ROW_INSET = `calc(${size.sidebarStep} - 2px)`;
const COARSE_CHEV_SLOT = `calc(${size.controlH} + 14px)`;

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
  sidebar: {
    backgroundColor: color.bower,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: color.slate,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    // The tree's sticky rows count down from a depth no folder reaches, which the resize handle
    // and the drawer's scrim must not be compared against.
    isolation: 'isolate',
    // On a phone, over the photographs rather than beside them, and always mounted so a swipe
    // has something to pull in. Hidden only once the slide is over, hence the delay.
    position: { default: null, [NARROW]: 'fixed' },
    top: { default: null, [NARROW]: 0 },
    bottom: { default: null, [NARROW]: 0 },
    left: { default: null, [NARROW]: 0 },
    zIndex: { default: null, [NARROW]: 40 },
    width: { default: null, [NARROW]: size.sidebarW },
    transform: { default: null, [NARROW]: `translateX(calc((${drawer.progress} - 1) * 100%))` },
    visibility: { default: null, [NARROW]: 'hidden' },
    transition: { default: null, [NARROW]: 'transform 180ms ease, visibility 0s 180ms' },
  },
  sidebarShown: {
    visibility: { default: null, [NARROW]: 'visible' },
    transition: { default: null, [NARROW]: 'transform 180ms ease, visibility 0s' },
  },
  // Nothing to ease while the finger is the thing moving it.
  following: {
    transition: { default: null, [NARROW]: 'none' },
  },
  // Outside the scroll, which would otherwise carry the tree up under the traffic lights.
  scroll: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minHeight: 0,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  // Same height as a page's first row, so the traffic lights sit centred in either.
  head: {
    paddingTop: '12px',
    paddingInline: '12px',
    paddingBottom: '10px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
    display: 'flex',
    justifyContent: 'flex-end',
  },
  brand: {
    paddingTop: '10px',
    paddingInline: '12px',
    paddingBottom: '12px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
  },
  brandMark: {
    fontFamily: font.display,
    fontSize: '17px',
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
  bower: {
    display: 'flex',
    gap: '3px',
    marginTop: '5px',
  },
  bowerBlue: {
    width: '12px',
    height: '3px',
    backgroundColor: color.satin,
  },
  bowerGlass: {
    width: '6px',
    height: '3px',
    backgroundColor: color.glass,
  },
  bowerSlate: {
    width: '20px',
    height: '3px',
    backgroundColor: color.slate,
  },
  section: {
    paddingTop: '10px',
    paddingInline: SECTION_PAD,
    paddingBottom: '2px',
  },
  sectionApp: {
    marginTop: 'auto',
    paddingBottom: '10px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    paddingTop: '8px',
  },
  sectionLabel: {
    paddingTop: 0,
    paddingInline: { default: '6px', [COARSE]: '10px' },
    paddingBottom: { default: '5px', [COARSE]: '6px' },
  },
  running: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    display: 'grid',
    gap: '5px',
  },
  badge: {
    color: color.boneDim,
  },
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    height: derivedSize.sidebarRow,
    marginBlock: 0,
    marginInline: `calc(-1 * ${SECTION_PAD})`,
    // One rule per ancestor, drawn as the image over the sticky backdrop's colour so a stuck
    // parent keeps them. Rows abut, so what each draws stacks into a continuous rule.
    backgroundImage: `repeating-linear-gradient(to right, ${color.slate} 0 1px, transparent 1px ${size.sidebarStep})`,
    backgroundRepeat: 'no-repeat',
    // A pixel in from the icon box's edge: flush, the rule reads as leaning left of the glyph.
    backgroundPositionX: `calc(${ROW_INSET} + 1px)`,
  },
  // The open row's bar stands where its parent's rule would, so the row on it drops that rule.
  guides: (all: string, besideBar: string) => ({
    backgroundSize: { default: all, ':has(> [aria-current="page"])': besideBar },
  }),
  sticky: (top: string, zIndex: number) => ({
    position: 'sticky',
    top,
    // Shallower over deeper, counted down from further than a tree nests: a child pushed up by the
    // end of its parent's block would otherwise paint over the parent it slides under.
    zIndex,
    // Colour, not the shorthand, which would take the guide rules with it.
    backgroundColor: color.bower,
  }),
  rowLink: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    height: '100%',
    paddingLeft: ROW_INSET,
    // Where the count's right edge lands. On a fine pointer the chevron lies over the count; on a
    // finger nothing hovers, so the chevron stays shown and every row holds its slot, leaf rows
    // too, so counts line up.
    paddingRight: { default: '12px', [COARSE]: COARSE_CHEV_SLOT },
    // The chevron lies over the link, so without this the row drops its hover on reaching it.
    backgroundColor: { default: null, ':hover': color.slateSoft, [stylex.when.ancestor(':hover')]: color.slateSoft },
    color: { default: color.boneDim, ':hover': color.bone, [stylex.when.ancestor(':hover')]: color.bone },
  },
  // With no count to hold the chevron's slot open, the name holds it.
  rowLinkUncounted: {
    paddingRight: { default: '34px', [COARSE]: COARSE_CHEV_SLOT },
  },
  indent: (marginLeft: string) => ({ marginLeft }),
  // The count holds the slot the chevron lies over, never narrower than it, so the swap cannot
  // move the name.
  rowCount: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    minWidth: '20px',
    textAlign: 'right',
  },
  // A fine pointer's alone: a tap moves focus, so under a finger this would blank the count on
  // the way to opening a section.
  countSwapped: {
    visibility: {
      default: null,
      [FINE]: {
        default: null,
        [stylex.when.ancestor(':hover')]: 'hidden',
        [stylex.when.ancestor(':has(:focus-visible)')]: 'hidden',
      },
    },
  },
  chev: {
    position: 'absolute',
    right: { default: '12px', [COARSE]: '8px' },
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: { default: '20px', [COARSE]: size.controlH },
    height: { default: '20px', [COARSE]: size.controlH },
    padding: 0,
    borderWidth: 0,
    borderRadius: size.radius,
    backgroundColor: { default: 'transparent', ':hover': color.slate },
    color: { default: color.boneDim, ':hover': color.bone },
    cursor: 'pointer',
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':has(:focus-visible)')]: 1,
      [COARSE]: 1,
    },
  },
  // Wider than the line it draws, so the edge can be caught without landing on the scrollbar.
  resizer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '6px',
    zIndex: 40,
    cursor: 'col-resize',
    touchAction: 'none',
    backgroundImage: `linear-gradient(${color.satin}, ${color.satin})`,
    backgroundPosition: 'center',
    backgroundSize: { default: '0 100%', ':hover': '3px 100%', ':focus-visible': '3px 100%' },
    backgroundRepeat: 'no-repeat',
    transition: 'background-size 150ms ease',
    outline: 'none',
  },
  resizerAt: (left: string) => ({ left }),
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

const sidebarWidth = (width: number | null): string => (width == null ? size.sidebar : `${width}px`);

// One row of the sidebar's tree, and whatever hangs under it. `sectionKey` is what
// makes it a section: it earns the chevron, it earns a place the children are
// drawn, and it earns the sticky, so a tree deep enough to fill the sidebar can
// still be closed from wherever the reader has scrolled to.
const SidebarRow = observer(function SidebarRow({
  to,
  end,
  tooltip,
  icon,
  name,
  count,
  readOnly = false,
  depth,
  sectionKey,
  children,
}: {
  to: string;
  end?: boolean;
  tooltip?: string;
  icon: LucideIcon;
  name: string;
  count?: number;
  readOnly?: boolean;
  depth: number;
  /** What its chevron opens, absent for a row with nothing under it. */
  sectionKey?: string;
  children?: ReactNode;
}): JSX.Element {
  const store = useSidebarStore();
  const { sidebar } = usePresenters();
  const open = sectionKey != null && store.isOpen(sectionKey);
  const guides = (levels: number): string => `calc(${size.sidebarStep} * ${levels}) 100%`;
  const link = (isActive: boolean): ReturnType<typeof stylex.props> =>
    stylex.props(
      sidebarStyles.link,
      styles.rowLink,
      sectionKey != null && count == null && styles.rowLinkUncounted,
      isActive && sidebarStyles.active,
      styles.indent(`calc(${size.sidebarStep} * ${depth})`),
      focusRing.ring,
    );
  const linkClass: NavLinkProps['className'] = ({ isActive }) => link(isActive).className;
  const linkStyle: NavLinkProps['style'] = ({ isActive }) => link(isActive).style;

  return (
    <div>
      <div
        {...stylex.props(
          styles.row,
          styles.guides(guides(depth), guides(Math.max(0, depth - 1))),
          sectionKey != null && styles.sticky(`calc(${derivedSize.sidebarRow} * ${depth})`, 999 - depth),
          stylex.defaultMarker(),
        )}
      >
        {/* The count is inside the link, so the row lights up as one thing under the
            pointer. The chevron cannot be - a button inside an anchor is not markup -
            so it is laid over the count's own place instead.
            Named rather than left to the two spans: adjacent inline text is read as one
            run-on word, so a library of twelve announces as "Reef12". */}
        <Tooltip label={tooltip}>
          <NavLink
            end={end}
            to={to}
            className={linkClass}
            style={linkStyle}
            aria-label={
              count == null ? undefined : AppStrings.rowHolding(readOnly ? AppStrings.readOnlyName(name) : name, count)
            }
          >
            <SidebarIcon icon={icon} />
            <SidebarText fit={readOnly}>{name}</SidebarText>
            {readOnly && (
              <PencilOff size={12} {...stylex.props(styles.badge)} aria-hidden>
                <title>{AppStrings.readOnly()}</title>
              </PencilOff>
            )}
            {count != null && (
              <span {...stylex.props(sidebarStyles.count, styles.rowCount, sectionKey != null && styles.countSwapped)}>
                {count}
              </span>
            )}
          </NavLink>
        </Tooltip>
        {sectionKey != null && (
          <button
            type="button"
            {...stylex.props(styles.chev, focusRing.ring)}
            aria-expanded={open}
            aria-label={open ? CollectionListStrings.collapse(name) : CollectionListStrings.expand(name)}
            onClick={() => sidebar.toggle(sectionKey)}
          >
            {open ? <ChevronDown size={ICON} /> : <ChevronRight size={ICON} />}
          </button>
        )}
      </div>
      {open && children}
    </div>
  );
});

const SidebarShoot = observer(function SidebarShoot({ node, depth }: { node: ShootNode; depth: number }): JSX.Element {
  return (
    <SidebarRow
      to={route(PathSegment.shoots(), node.shoot.id)}
      icon={Folder}
      name={node.shoot.name}
      count={node.shoot.photo_count}
      depth={depth}
      sectionKey={node.children.length === 0 ? undefined : `shoot:${node.shoot.id}`}
    >
      {node.children.map((child) => (
        <SidebarShoot key={child.shoot.id} node={child} depth={depth + 1} />
      ))}
    </SidebarRow>
  );
});

// Mounted only while the section is open, which is what makes the read lazy: a
// library whose shoots nobody asks for costs no request.
const SidebarShoots = observer(function SidebarShoots({ libraryId }: { libraryId: string }): JSX.Element {
  const store = useSidebarStore();
  const { sidebar } = usePresenters();
  useEffect(() => void sidebar.loadShoots(libraryId), [sidebar, libraryId]);

  return (
    <>
      {(store.shootTrees.get(libraryId) ?? []).map((node) => (
        <SidebarShoot key={node.shoot.id} node={node} depth={2} />
      ))}
    </>
  );
});

const SidebarAlbums = observer(function SidebarAlbums(): JSX.Element {
  const store = useAlbumsStore();
  const { albums } = usePresenters();
  useEffect(() => void albums.load(), [albums]);

  return (
    <>
      {store.albums.map((album) => (
        <SidebarRow
          key={album.id}
          to={route(PathSegment.albums(), album.id)}
          icon={Images}
          name={album.name}
          count={album.photo_count}
          depth={1}
        />
      ))}
    </>
  );
});

// Every registered library is always listed, with its sections. There is no
// "pick a library first" screen: adding a library is a setup step, not something
// you navigate through on every visit.
const LibraryNav = observer(function LibraryNav(): JSX.Element {
  const libraries = useLibrariesStore();

  if (libraries.libraries.length === 0) {
    return (
      <div {...stylex.props(styles.section)}>
        <SectionLabel>{SettingsStrings.libraries()}</SectionLabel>
        <SidebarLink to={route(PathSegment.settings())} icon={Settings}>
          {AppStrings.addALibrary()}
        </SidebarLink>
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.section)}>
      <SectionLabel>{SettingsStrings.libraries()}</SectionLabel>
      {libraries.libraries.map((library) => (
        <div key={library.id} role="group" aria-label={libraryLabel(library)}>
          <SidebarRow
            end
            to={route(PathSegment.libraries(), library.id)}
            tooltip={library.root_path}
            icon={Library}
            name={libraryLabel(library)}
            count={library.photo_count}
            readOnly={library.read_only}
            depth={0}
            sectionKey={`library:${library.id}`}
          >
            {/* One picture, because Albums is the stacked icon. */}
            <SidebarRow
              end
              to={route(PathSegment.libraries(), library.id)}
              icon={Image}
              name={AppStrings.photos()}
              depth={1}
            />
            <SidebarRow
              to={route(PathSegment.libraries(), library.id, PathSegment.shoots())}
              icon={Layers}
              name={ShootsPageStrings.shoots()}
              depth={1}
              sectionKey={`shoots:${library.id}`}
            >
              <SidebarShoots libraryId={library.id} />
            </SidebarRow>
            <SidebarRow
              to={route(PathSegment.libraries(), library.id, PathSegment.bin())}
              icon={Trash2}
              name={BinPageStrings.bin()}
              depth={1}
            />
          </SidebarRow>
        </div>
      ))}
    </div>
  );
});

// Absent until there is something to decide: a replica with no divergences - which
// is nearly always - should not carry a permanent reminder that they can happen.
const EditConflictsLink = observer(function EditConflictsLink(): JSX.Element | null {
  const store = useReplicationStore();
  const waiting = store.conflictedPhotos.length;
  if (waiting === 0) return null;

  return (
    <SidebarLink to={route(PathSegment.editConflicts())} icon={GitMerge}>
      <SidebarText>{AppStrings.editsToChoose()}</SidebarText>
      <span {...stylex.props(sidebarStyles.count)}>{waiting}</span>
    </SidebarLink>
  );
});

// Replication that has stopped working must not be a timestamp buried in
// Settings (§8.6): a laptop out of touch for a fortnight is exactly the failure
// a trip depends on noticing.
const ReplicationTroubleLink = observer(function ReplicationTroubleLink(): JSX.Element | null {
  const store = useReplicationStore();
  const failing = store.failingPeers;
  if (failing === 0) return null;

  return (
    <SidebarLink to={route(PathSegment.settings())} icon={CloudOff}>
      <SidebarText>{AppStrings.notSyncing()}</SidebarText>
      <span {...stylex.props(sidebarStyles.count)}>{failing}</span>
    </SidebarLink>
  );
});

// A run is minutes of work started from a dialog that closes on the click, so the entry it
// would be listed under says how it is going instead - counting every queued run, since one
// waiting behind another is still a photograph the reader is waiting for.
const ExportsLink = observer(function ExportsLink(): JSX.Element {
  const store = useExportStore();
  const queued = store.queued;

  return (
    <SidebarLink to={route(PathSegment.exports())} icon={FolderOutput}>
      {queued === 0 ?
        ExportsPageStrings.exports()
        // Label over bar, so the bar spans the entry rather than competing with the words for width.
      : <span {...stylex.props(styles.running)}>
          <SidebarText>{ExportsPageStrings.exporting(queued)}</SidebarText>
          <ProgressBar label={ExportsPageStrings.exporting(queued)} value={store.written} max={queued} />
        </span>
      }
    </SidebarLink>
  );
});

// The sidebar's own edge, dragged. Pointer x is the width outright, the sidebar being
// the first column of the shell; a fine pointer only, since a finger has the
// whole drawer to pull instead.
export const SidebarResizer = observer(function SidebarResizer(): JSX.Element {
  const store = useSidebarStore();
  const { sidebar } = usePresenters();

  return (
    <div
      {...stylex.props(styles.resizer, styles.resizerAt(`calc(${sidebarWidth(store.width)} - 3px)`))}
      role="separator"
      aria-orientation="vertical"
      aria-label={AppStrings.resizeSidebar()}
      tabIndex={0}
      onPointerDown={(e) => {
        // Without this the drag selects the sidebar's text instead of moving the edge.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        sidebar.setWidth(e.clientX);
      }}
      onDoubleClick={sidebar.toggleOpen}
      onKeyDown={(e) => {
        const steps = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (steps === 0) return;
        e.preventDefault();
        sidebar.nudgeWidth(steps);
      }}
    />
  );
});

// Absent in a build with no DSN, which has nowhere to send a report (§18.8).
function ReportBugEntry(): JSX.Element | null {
  const { feedback } = usePresenters();
  if (!bugReporter.canSend()) return null;
  return (
    <SidebarButton icon={Bug} onClick={feedback.open}>
      {ReportBugStrings.reportABug()}
    </SidebarButton>
  );
}

function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text variant="label" as="div" style={styles.sectionLabel}>
      {children}
    </Text>
  );
}

export function Sidebar({
  onCollapse,
  shown = false,
  following = false,
}: {
  onCollapse: () => void;
  /** On a phone, whether the drawer is out or on its way. */
  shown?: boolean;
  /** On a phone, whether a finger has hold of the drawer. */
  following?: boolean;
}): JSX.Element {
  return (
    <nav
      {...stylex.props(styles.sidebar, shown && styles.sidebarShown, following && styles.following)}
      aria-label={AppStrings.sidebar()}
    >
      <div {...DRAGS_WINDOW} {...stylex.props(styles.head)}>
        <Button iconOnly aria-label={AppStrings.hideSidebar()} aria-expanded onClick={onCollapse}>
          <PanelLeftClose size={ICON} />
        </Button>
      </div>

      <div {...stylex.props(styles.scroll)}>
        <LibraryNav />

        <div {...stylex.props(styles.section)}>
          <SectionLabel>{AppStrings.catalogue()}</SectionLabel>
          <SidebarRow
            to={route(PathSegment.albums())}
            icon={Images}
            name={AlbumsPageStrings.albums()}
            depth={0}
            sectionKey="albums"
          >
            <SidebarAlbums />
          </SidebarRow>
          <EditConflictsLink />
          <ReplicationTroubleLink />
        </div>

        {/* About the app rather than the photos, so away from the catalogue. */}
        <div {...stylex.props(styles.section, styles.sectionApp)}>
          <ExportsLink />
          <SidebarLink to={route(PathSegment.settings())} icon={Settings}>
            {SettingsStrings.settings()}
          </SidebarLink>
          {/* Beside Settings because it is what the HDR setting there is asking about:
              the case for turning it on, made in pictures. */}
          <SidebarLink to={route(PathSegment.hdr())} icon={Sun}>
            {HdrPageStrings.title()}
          </SidebarLink>
          <ReportBugEntry />
          <UpdateBadge />
        </div>

        <div {...stylex.props(styles.brand)}>
          <div {...stylex.props(styles.brandMark)}>{AppStrings.brand()}</div>
          <div {...stylex.props(styles.bower)} aria-hidden="true">
            <i {...stylex.props(styles.bowerBlue)} />
            <i {...stylex.props(styles.bowerGlass)} />
            <i {...stylex.props(styles.bowerSlate)} />
          </div>
        </div>
      </div>
    </nav>
  );
}

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
const TRIAGE_ROUTE = route(PathSegment.stacks(), PathSegment.param('stackId'), PathSegment.triage());
const MERGE_ROUTE = route(PathSegment.photos(), PathSegment.merge(), PathSegment.param('jobId'));
const MERGE_EDIT_ROUTE = route(PathSegment.photos(), PathSegment.param('photoId'), PathSegment.merge());
const MOCKUP_ROUTE = route(PathSegment.photos(), PathSegment.param('photoId'), PathSegment.mockup());
const EDIT_ROUTE = route(PathSegment.photos(), PathSegment.param('photoId'), PathSegment.edit());

// Nothing to land on until the libraries and settings are known: a fresh install
// starts in the welcome wizard, and after it the first library's photographs are
// the home screen, or Settings where there is none.
const Home = observer(function Home(): JSX.Element | null {
  const libraries = useLibrariesStore();
  const settings = useAppSettingsStore();
  if (libraries.loading || settings.loading) return null;
  if (settings.onboardingComplete === false) return <Navigate to={route(PathSegment.welcome())} replace />;
  const first = libraries.libraries[0];
  return <Navigate to={first == null ? route(PathSegment.settings()) : route(PathSegment.libraries(), first.id)} replace />;
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

  useDrawerSwipe({ active: mobile, open: drawerOpen, setOpen: sidebarPresenter.setDrawerOpen, setDragging, shell });
  const toggleSidebar = sidebarPresenter.toggleOpen;

  if (pathname === route(PathSegment.welcome())) {
    return (
      <>
        <Toasts />
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
      <ServerEvents />
      <CheckForUpdates />
      {mobile && (drawerOpen || dragging) && (
        <div {...stylex.props(styles.scrim, dragging && styles.following)} onClick={toggleSidebar} />
      )}
      {/* Mounted throughout on a phone, where it is a drawer positioned by a transform: a
          swipe has to have something to pull in, and something to push back out. Off screen
          it is `visibility: hidden`, so it is neither tabbable nor in the way of a tap. */}
      {(mobile || sidebarOpen) && (
        <Sidebar onCollapse={toggleSidebar} shown={(mobile && drawerOpen) || dragging} following={dragging} />
      )}
      {sidebarOpen && !mobile && !touch && <SidebarResizer />}
      <div {...stylex.props(styles.main)}>
        <Toasts />
        {/* Mounted at the root rather than beside the menu that opens it: the bulk bar's
            export is the same dialog over a selection, on a different screen. */}
        <ExportDialog />
        {/* Opened from the sidebar's badge and from Settings, so it hangs off neither. */}
        <UpdateDialog />
        {/* The same, for the sidebar's entry and the photo menu's: only one of the two knows
            a photograph, and the form is the same form either way. */}
        <ReportBugDialog />
        <main {...stylex.props(styles.content)}>
          <ShowSidebar.Provider value={sidebarOpen ? null : toggleSidebar}>
            <Routes>
              <Route path={route()} element={<Home />} />
              <Route path={route(PathSegment.settings(), PathSegment.optionalParam('tab'))} element={<SettingsPage />} />
              <Route path={route(PathSegment.exports())} element={<ExportsPage />} />
              <Route path={route(PathSegment.hdr())} element={<HdrPage />} />
              <Route path={route(PathSegment.libraries(), PathSegment.param('libraryId'))} element={<LibraryPhotosPage />} />
              <Route
                path={route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.shoots())}
                element={<ShootsPage />}
              />
              <Route
                path={route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.bin())}
                element={<BinPage />}
              />
              <Route
                path={route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.noShoot())}
                element={<NoShootPhotosPage />}
              />
              <Route path={route(PathSegment.shoots(), PathSegment.param('shootId'))} element={<ShootPhotosPage />} />
              <Route path={route(PathSegment.albums())} element={<AlbumsPage />} />
              <Route path={route(PathSegment.albums(), PathSegment.param('albumId'))} element={<AlbumPhotosPage />} />
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
