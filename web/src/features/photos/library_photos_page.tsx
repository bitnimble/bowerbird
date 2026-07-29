import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { usePresenters } from '../../app/stores_context';
import { BulkBar } from './bulk_bar';
import { GridControls } from './grid_controls';
import { PhotoGrid } from './photo_grid';

export const LibraryPhotosPage = observer(function LibraryPhotosPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const { photos, shoots, albums, sync } = usePresenters();

  useEffect(() => {
    void photos.open({ kind: 'library', libraryId });
    // Shoots and albums load here too: the bulk bar offers them as destinations.
    void shoots.load(libraryId);
    void albums.load();
    // Still watches the sync status so the grid fills in as renditions land, but
    // the controls for starting one live in Settings.
    void sync.watch(libraryId);
    return () => sync.stop();
  }, [libraryId, photos, shoots, albums, sync]);

  return (
    <div className="pad pad--fill">
      <GridControls />
      <BulkBar />
      <PhotoGrid emptyHint="Sync this library from Settings to index the RAW files in its folder." />
    </div>
  );
});
