import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { usePresenters } from '../../app/stores_context';
import { Heading } from '../../ui/heading';
import { Text } from '../../ui/text';
import { BulkBar } from './bulk_bar';
import { GridControls } from './grid_controls';
import { PhotoGrid } from './photo_grid';

export const BinPage = observer(function BinPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const { photos } = usePresenters();

  useEffect(() => {
    void photos.open({ kind: 'bin', libraryId });
  }, [libraryId, photos]);

  return (
    <div className="pad pad--fill">
      <Heading>Bin</Heading>
      <Text variant="mono" as="p">
        Soft-deleted photos. The RAW files still exist, moved into a Bin folder on disk.
      </Text>

      <GridControls />
      <BulkBar />
      <PhotoGrid emptyHint="Nothing has been deleted from this library." />
    </div>
  );
});
