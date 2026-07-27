import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAlbumsStore, usePresenters } from '../../app/stores_context';
import { Heading } from '../../ui/ui';
import { BulkBar } from '../photos/bulk_bar';
import { GridControls } from '../photos/grid_controls';
import { PhotoGrid } from '../photos/photo_grid';

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
    <div className="pad">
      <Heading>{album?.name ?? 'Album'}</Heading>

      <GridControls />
      <BulkBar removeFrom={album == null ? undefined : { kind: 'album', id: album.id, name: album.name }} />
      <PhotoGrid emptyHint="Select photos in the library view and add them to this album." />
    </div>
  );
});
