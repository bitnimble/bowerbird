import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Folder, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { type Shoot } from '../../../../src/schemas/shoots';
import { CollectionList } from '../../app/collection_list';
import { CollectionListStrings } from '../../app/collection_list.strings';
import type { CollectionRow } from '../../app/collection_list_store';
import { useLibrariesStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { MenuCheckItem } from '../../ui/check_menu';
import { EmptyState } from '../../ui/empty_state';
import { ErrorBanner } from '../../ui/error_banner';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import { menuSection } from '../../ui/menu_section';
import type { Option } from '../../ui/option';
import { OverflowMenu } from '../../ui/overflow_menu';
import { Page, PageHead } from '../../ui/page';
import { Spacer } from '../../ui/row';
import { SegmentedControl } from '../../ui/segmented_control';
import { Text } from '../../ui/text';
import { BulkBarStrings } from '../photos/grid/bulk_bar.strings';
import { ToastsStrings } from '../toasts/toasts.strings';
import { AddShootDialog } from './add_shoot_dialog';
import { AddShootStrings } from './add_shoot_dialog.strings';
import { DeleteShootDialog } from './delete_shoot_dialog';
import { ShootsPageStrings } from './shoots_page.strings';
import type { ShootView } from './shoots_store';

const VIEWS: Option<ShootView>[] = [
  { value: 'tree_full', label: ShootsPageStrings.viewAllFolders() },
  { value: 'flat', label: ShootsPageStrings.viewFlat() },
  { value: 'tree', label: ShootsPageStrings.viewTree() },
];

const createInSubfolder = (refusal: string | undefined): Option<string> => ({
  value: 'subfolder',
  label: ShootsPageStrings.createShootInSubfolder(),
  icon: <FolderPlus size={ICON} />,
  disabled: refusal != null,
  tooltip: refusal,
});

/**
 * What the page is drawn with, rather than an action on it: one statement, which stays ticked.
 *
 * Offered whether or not anything is hidden, since it is the only thing in here and a ⋮ that opens
 * on nothing is worse than a tick that reveals nothing.
 */
const ShootsOverflow = observer(function ShootsOverflow(): JSX.Element {
  const store = useShootsStore();
  const { shoots } = usePresenters();

  return (
    <OverflowMenu
      hotkey
      label={ShootsPageStrings.shootOptions()}
      sections={[
        menuSection({
          content: (
            <MenuCheckItem
              icon={<EyeOff size={ICON} />}
              label={ShootsPageStrings.showHiddenShoots()}
              checked={store.showHidden}
              onCheckedChange={shoots.setShowHidden}
            />
          ),
        }),
      ]}
    />
  );
});

// The library's folders, with the shoots among them, rather than the shoots
// alone (§18.3.2). An empty list beside a library full of subfolders was the
// catalogue lying by omission: the photographs had imported, the folders were
// right there on disk, and nothing on screen said so.
export const ShootsPage = observer(function ShootsPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const store = useShootsStore();
  const libraries = useLibrariesStore();
  const { shoots, libraries: librariesPresenter } = usePresenters();
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Shoot | null>(null);

  useEffect(() => {
    shoots.restoreView();
    void shoots.load(libraryId);
    // Whether the library is read-only, which the sidebar has usually loaded
    // already but a deep link has not.
    void librariesPresenter.load();
  }, [libraryId, shoots, librariesPresenter]);

  const library = libraries.byId.get(libraryId);
  const readOnlyRefusal =
    library?.read_only === true ? BulkBarStrings.notOnReadOnlyLibrary() : undefined;

  const actionsFor = useCallback(
    (row: CollectionRow): Option<string>[] | null => {
      if (row.tone === 'virtual') return null;
      const tracked = row.tone !== 'untracked';
      // The shoot's own flag, not whether it is out of sight: a shoot hidden by an ancestor cannot be
      // brought back on its own, so it is offered Hide - which is a real write, and what makes it stay
      // hidden if the ancestor is ever unhidden (§12.4).
      const hidden = store.shootByFolder.get(row.key)?.hidden_directly === true;
      return [
        ...(tracked
          ? []
          : [
              {
                value: 'adopt',
                label: ShootsPageStrings.addAsShoot(),
                icon: <Folder size={ICON} />,
              },
            ]),
        ...(tracked && store.renamingKey !== row.key
          ? [
              {
                value: 'rename',
                label: CollectionListStrings.rename(),
                icon: <Pencil size={ICON} />,
                disabled: readOnlyRefusal != null,
                tooltip: readOnlyRefusal,
              },
            ]
          : []),
        createInSubfolder(readOnlyRefusal),
        ...(tracked
          ? [
              {
                value: 'hide',
                label: hidden ? ShootsPageStrings.unhideShoot() : ShootsPageStrings.hideShoot(),
                icon: hidden ? <Eye size={ICON} /> : <EyeOff size={ICON} />,
              },
              {
                value: 'delete',
                label: CollectionListStrings.delete(),
                icon: <Trash2 size={ICON} />,
                destructive: true,
              },
            ]
          : []),
      ];
    },
    [store, readOnlyRefusal],
  );

  const onAction = useCallback(
    (row: CollectionRow, action: string): void => {
      if (action === 'subfolder') setCreatingIn(row.key);
      else if (action === 'adopt') void shoots.adopt(row.key);
      else if (action === 'rename') shoots.startRename(row.key, row.name);
      else if (action === 'hide') {
        const shoot = store.shootByFolder.get(row.key);
        if (shoot != null) void shoots.setHidden(shoot.id, !shoot.hidden_directly);
      } else setDeleting(store.shootByFolder.get(row.key) ?? null);
    },
    [shoots, store],
  );

  return (
    <Page fill>
      <PageHead withSidebarButton>
        <Heading>{ShootsPageStrings.shoots()}</Heading>
        <Spacer />
        <SegmentedControl
          label={ShootsPageStrings.howToShowFolders()}
          options={VIEWS}
          value={store.view}
          onChange={shoots.setView}
        />
        <Button
          variant="primary"
          disabled={readOnlyRefusal != null}
          tooltip={readOnlyRefusal}
          onClick={() => setCreatingIn('')}
        >
          <Plus size={ICON} />
          {AddShootStrings.createShoot()}
        </Button>
        <ShootsOverflow />
      </PageHead>

      {store.error != null && (
        <ErrorBanner>
          <span>{store.error}</span>
          <Button onClick={shoots.clearError}>{ToastsStrings.dismiss()}</Button>
        </ErrorBanner>
      )}

      <AddShootDialog
        libraryId={libraryId}
        parentPath={creatingIn ?? ''}
        open={creatingIn != null}
        onOpenChange={(open) => !open && setCreatingIn(null)}
      />
      <DeleteShootDialog
        shoot={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={(photos) => {
          const shoot = deleting;
          setDeleting(null);
          if (shoot != null) void shoots.remove(shoot.id, photos);
        }}
      />

      <CollectionList
        store={store}
        presenter={shoots}
        actionsFor={actionsFor}
        onAction={onAction}
        resetKey={`${libraryId}:${store.view}`}
      />

      {store.loading && store.rows.length === 0 && (
        <EmptyState title={ShootsPageStrings.readingFolders()} />
      )}

      {store.isEmpty && (
        <EmptyState title={ShootsPageStrings.noShootsYet()}>
          <Text as="p" variant="muted">
            {ShootsPageStrings.nothingHereHint()}
          </Text>
        </EmptyState>
      )}
    </Page>
  );
});
