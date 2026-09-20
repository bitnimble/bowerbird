import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { CollectionList } from '../../app/collection_list';
import { CollectionListStrings } from '../../app/collection_list.strings';
import type { CollectionRow } from '../../app/collection_list_store';
import { useAlbumsStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty_state';
import { ErrorBanner } from '../../ui/error_banner';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { Page, PageHead } from '../../ui/page';
import { Spacer } from '../../ui/row';
import { Text } from '../../ui/text';
import { ToastsStrings } from '../toasts/toasts.strings';
import { AddAlbumDialog } from './add_album_dialog';
import { AlbumsPageStrings } from './albums_page.strings';

export const AlbumsPage = observer(function AlbumsPage(): JSX.Element {
  const store = useAlbumsStore();
  const { albums } = usePresenters();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void albums.load();
  }, [albums]);

  const actionsFor = useCallback(
    (row: CollectionRow): Option<string>[] => [
      ...(store.renamingKey === row.key ?
        []
      : [{ value: 'rename', label: CollectionListStrings.rename(), icon: <Pencil size={ICON} /> }]),
      { value: 'delete', label: CollectionListStrings.delete(), icon: <Trash2 size={ICON} />, destructive: true },
    ],
    [store],
  );

  const onAction = useCallback(
    (row: CollectionRow, action: string): void => {
      if (action === 'rename') {
        albums.startRename(row.key, row.name);
        return;
      }
      const album = store.byId.get(row.key);
      if (album == null) return;
      // Native confirm: this delete cannot be undone, and the platform dialog is
      // modal, accessible and keyboard-safe for free.
      if (window.confirm(AlbumsPageStrings.deleteWarning(album.name, album.photo_count))) void albums.remove(row.key);
    },
    [albums, store],
  );

  return (
    <Page fill>
      <PageHead lead>
        <Heading>{AlbumsPageStrings.albums()}</Heading>
        <Spacer />
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={ICON} />
          {AlbumsPageStrings.createAlbum()}
        </Button>
      </PageHead>

      {store.error != null && (
        <ErrorBanner>
          <span>{store.error}</span>
          <Button onClick={albums.clearError}>{ToastsStrings.dismiss()}</Button>
        </ErrorBanner>
      )}

      <AddAlbumDialog open={creating} onOpenChange={setCreating} />

      {store.isEmpty ? (
        <EmptyState title={AlbumsPageStrings.noAlbumsYet()}>
          <Text as="p" variant="muted">
            {AlbumsPageStrings.noAlbumsHint()}
          </Text>
        </EmptyState>
      ) : (
        <CollectionList store={store} presenter={albums} actionsFor={actionsFor} onAction={onAction} />
      )}
    </Page>
  );
});
