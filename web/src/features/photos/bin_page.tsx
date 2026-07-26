import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { usePhotosStore, usePresenters } from '../../app/stores_context';
import { ErrorBanner, Heading, Text } from '../../ui/ui';
import { BulkBar } from './bulk_bar';
import { GridControls } from './grid_controls';
import { PhotoGrid } from './photo_grid';

export const BinPage = observer(function BinPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const store = usePhotosStore();
  const { photos } = usePresenters();

  useEffect(() => {
    void photos.open({ kind: 'bin', libraryId });
  }, [libraryId, photos]);

  return (
    <div className="pad">
      <Heading>Bin</Heading>
      <Text variant="mono" as="p">
        Soft-deleted photos. The RAW files still exist, moved into a Bin folder on disk.
      </Text>

      <ErrorBanner message={store.error} onDismiss={photos.clearError} />
      <GridControls />
      <PhotoGrid emptyHint="Nothing has been deleted from this library." />
      <BulkBar />
    </div>
  );
});
