import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { usePresenters } from '../../../app/stores_context';
import { isThinShell } from '../../../app/thin_shell';
import { Page } from '../../../ui/page';
import { BackupStrip } from '../../backup/backup_strip';
import { BulkBar } from './bulk_bar';
import { GridControls } from './grid_controls';
import { LibraryPhotosPageStrings } from './library_photos_page.strings';
import { PhotoGrid } from './photo_grid';

export const LibraryPhotosPage = observer(function LibraryPhotosPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const { photos, shoots, albums, scan } = usePresenters();

  useEffect(() => {
    void photos.open({ kind: 'library', libraryId });
    // Shoots and albums load here too: the bulk bar offers them as destinations.
    void shoots.load(libraryId);
    void albums.load();
    // Still watches the scan status so the grid fills in as renditions land, but
    // the controls for starting one live in Settings.
    void scan.watch(libraryId);
    return () => scan.stop();
  }, [libraryId, photos, shoots, albums, scan]);

  return (
    <Page fill>
      <GridControls withSidebarButton />
      <BackupStrip libraryId={libraryId} />
      <BulkBar />
      <PhotoGrid
        emptyHint={
          isThinShell()
            ? LibraryPhotosPageStrings.emptySyncedHint()
            : LibraryPhotosPageStrings.emptyHint()
        }
      />
    </Page>
  );
});
