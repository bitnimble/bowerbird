import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { CollectionListStrings } from '../../app/collection_list.strings';
import { useAlbumsStore, usePresenters } from '../../app/stores_context';
import { EditableHeading } from '../../ui/editable_heading';
import { Page } from '../../ui/page';
import { BulkBar } from '../photos/grid/bulk_bar';
import { GridControls } from '../photos/grid/grid_controls';
import { PhotoGrid } from '../photos/grid/photo_grid';
import { PhotoGridStrings } from '../photos/grid/photo_grid.strings';
import { AlbumPhotosStrings } from './album_photos_page.strings';

export const AlbumPhotosPage = observer(function AlbumPhotosPage(): JSX.Element {
  const { albumId = '' } = useParams();
  const albumsStore = useAlbumsStore();
  const { photos, albums } = usePresenters();
  const album = albumsStore.byId.get(albumId);

  useEffect(() => {
    void photos.open({ kind: 'album', albumId });
    if (albumsStore.albums.length === 0) void albums.load();
  }, [albumId, photos, albums, albumsStore]);

  return (
    <Page fill>
      {/* No folder behind an album, so any name it can be called by will do. */}
      <EditableHeading
        lead
        value={album?.name ?? AlbumPhotosStrings.album()}
        label={CollectionListStrings.renameField(album?.name ?? '')}
        editable={album != null}
        onRename={(name) => {
          if (album != null) void albums.rename(album.id, name);
        }}
      />

      <GridControls />
      <BulkBar collection={album == null ? undefined : { kind: 'album', id: album.id, name: album.name }} />
      <PhotoGrid emptyHint={PhotoGridStrings.addFromLibraryHint()} />
    </Page>
  );
});
