import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Bug, FolderOutput, GitMerge, Images, PanelLeftClose, Settings, Sun } from 'lucide-react';
import { PathSegment, route } from '../../../../src/schemas/route';
import { drawer } from '../../app/drawer.stylex';
import { useExportStore, usePresenters, useReplicationStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import { ProgressBar } from '../../ui/progress_bar';
import { DRAGS_WINDOW, HAS_TRAFFIC_LIGHTS } from '../../ui/title_bar';
import { color, font, size } from '../../ui/tokens.stylex';
import { AlbumsPageStrings } from '../albums/albums_page.strings';
import { ExportsPageStrings } from '../exports/exports_page.strings';
import { bugReporter } from '../feedback/report_bug';
import { ReportBugStrings } from '../feedback/report_bug_dialog.strings';
import { HdrPageStrings } from '../hdr/hdr_page.strings';
import { SettingsStrings } from '../settings/settings_page.strings';
import { UpdateBadge } from '../updates/update_badge';
import { LibraryNav } from './library_nav';
import { SidebarStrings } from './sidebar.strings';
import { SidebarAlbums } from './sidebar_albums';
import { SidebarButton, SidebarLink, SidebarText, sidebarStyles } from './sidebar_link';
import { SidebarRow, SidebarSection } from './sidebar_row';

const NARROW = '@media (max-width: 860px)';

const styles = stylex.create({
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
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    gap: '8px',
  },
  headWithBrand: {
    justifyContent: 'space-between',
  },
  foot: {
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
  sectionApp: {
    marginTop: 'auto',
    paddingBottom: '10px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    paddingTop: '8px',
  },
  running: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    display: 'grid',
    gap: '5px',
  },
});

export const sidebarWidth = (width: number | null): string => (width == null ? size.sidebar : `${width}px`);

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
      aria-label={SidebarStrings.sidebar()}
    >
      <div {...DRAGS_WINDOW} {...stylex.props(styles.head, !HAS_TRAFFIC_LIGHTS && styles.headWithBrand)}>
        {!HAS_TRAFFIC_LIGHTS && <Brand />}
        <Button iconOnly aria-label={SidebarStrings.hideSidebar()} aria-expanded onClick={onCollapse}>
          <PanelLeftClose size={ICON} />
        </Button>
      </div>

      <div {...stylex.props(styles.scroll)}>
        <LibraryNav />

        <SidebarSection>
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
        </SidebarSection>

        {/* About the app rather than the photos, so away from the catalogue. */}
        <SidebarSection style={styles.sectionApp}>
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
        </SidebarSection>

        {HAS_TRAFFIC_LIGHTS && (
          <div {...stylex.props(styles.foot)}>
            <Brand />
          </div>
        )}
      </div>
    </nav>
  );
}

// Absent until there is something to decide: a replica with no divergences - which
// is nearly always - should not carry a permanent reminder that they can happen.
const EditConflictsLink = observer(function EditConflictsLink(): JSX.Element | null {
  const store = useReplicationStore();
  const waiting = store.conflictedPhotos.length;
  if (waiting === 0) return null;

  return (
    <SidebarLink to={route(PathSegment.editConflicts())} icon={GitMerge}>
      <SidebarText>{SidebarStrings.editsToChoose()}</SidebarText>
      <span {...stylex.props(sidebarStyles.count)}>{waiting}</span>
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

function Brand(): JSX.Element {
  return (
    <div>
      <div {...stylex.props(styles.brandMark)}>{SidebarStrings.brand()}</div>
      <div {...stylex.props(styles.bower)} aria-hidden="true">
        <i {...stylex.props(styles.bowerBlue)} />
        <i {...stylex.props(styles.bowerGlass)} />
        <i {...stylex.props(styles.bowerSlate)} />
      </div>
    </div>
  );
}
