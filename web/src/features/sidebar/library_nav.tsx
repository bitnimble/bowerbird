import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { Image, Layers, Library, Settings, Trash2, TriangleAlert } from 'lucide-react';
import type { PairedPeer } from '../../../../src/schemas/replication';
import { PathSegment, route } from '../../../../src/schemas/route';
import { useLibrariesStore, useReplicationStore } from '../../app/stores_context';
import { isThinShell } from '../../app/thin_shell';
import { Text } from '../../ui/text';
import { libraryLabel } from '../libraries/library_label';
import { BinPageStrings } from '../photos/grid/bin_page.strings';
import { AddReplicaStrings } from '../replication/add_replica_dialog.strings';
import { SettingsStrings } from '../settings/settings_page.strings';
import { ShootsPageStrings } from '../shoots/shoots_page.strings';
import { LibraryNavStrings } from './library_nav.strings';
import { SidebarLink } from './sidebar_link';
import { SidebarRow, SidebarSection } from './sidebar_row';
import { SidebarShoots } from './sidebar_shoots';

const COARSE = '@media (pointer: coarse)';

const styles = stylex.create({
  sectionLabel: {
    paddingTop: 0,
    paddingInline: { default: '6px', [COARSE]: '10px' },
    paddingBottom: { default: '5px', [COARSE]: '6px' },
  },
});

// Every registered library is always listed, with its sections. There is no
// "pick a library first" screen: adding a library is a setup step, not something
// you navigate through on every visit.
export const LibraryNav = observer(function LibraryNav(): JSX.Element {
  const libraries = useLibrariesStore();
  const replication = useReplicationStore();
  const thin = isThinShell();

  if (libraries.libraries.length === 0) {
    return (
      <SidebarSection>
        <SectionLabel>{SettingsStrings.libraries()}</SectionLabel>
        <SidebarLink to={route(PathSegment.settings())} icon={Settings}>
          {thin ? AddReplicaStrings.title() : LibraryNavStrings.addALibrary()}
        </SidebarLink>
      </SidebarSection>
    );
  }

  return (
    <SidebarSection>
      <SectionLabel>{SettingsStrings.libraries()}</SectionLabel>
      {libraries.libraries.map((library) => (
        <div key={library.id} role="group" aria-label={libraryLabel(library)}>
          <SidebarRow
            end
            to={route(PathSegment.libraries(), library.id)}
            tooltip={thin ? undefined : library.root_path}
            icon={Library}
            name={libraryLabel(library)}
            count={library.photo_count}
            readOnly={library.read_only}
            originalsElsewhere={replication.originalsElsewhere(library.id)}
            depth={0}
            sectionKey={`library:${library.id}`}
          >
            {/* One picture, because Albums is the stacked icon. */}
            <SidebarRow
              end
              to={route(PathSegment.libraries(), library.id)}
              icon={Image}
              name={LibraryNavStrings.photos()}
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
            {replication.hasSyncErrors(library.id) && (
              <SidebarRow
                to={route(
                  PathSegment.settings(),
                  PathSegment.libraries(),
                  library.id,
                  PathSegment.sync(),
                )}
                icon={TriangleAlert}
                name={syncTroubleName(replication.outdatedPeerOf(library.id))}
                tone="warning"
                depth={1}
              />
            )}
          </SidebarRow>
        </div>
      ))}
    </SidebarSection>
  );
});

function syncTroubleName(outdated: PairedPeer | null): string {
  if (outdated == null) return LibraryNavStrings.syncErrors();
  return outdated.outdated === 'this_device'
    ? LibraryNavStrings.updateThisDevice()
    : LibraryNavStrings.updateDevice(outdated.name);
}

function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text variant="label" as="div" style={styles.sectionLabel}>
      {children}
    </Text>
  );
}
