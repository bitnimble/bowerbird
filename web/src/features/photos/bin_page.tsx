import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useLibrariesStore, usePresenters } from '../../app/stores_context';
import { Heading } from '../../ui/heading';
import { Text } from '../../ui/text';
import { BulkBar } from './bulk_bar';
import { GridControls } from './grid_controls';
import { PhotoGrid } from './photo_grid';

export const BinPage = observer(function BinPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const { photos } = usePresenters();
  const libraries = useLibrariesStore();

  useEffect(() => {
    void photos.open({ kind: 'bin', libraryId });
  }, [libraryId, photos]);

  // Read off the library rather than stated: a library the app never writes to
  // has no bin folder, and the photographs it holds have not moved at all.
  const binName = libraries.byId.get(libraryId)?.bin_name;

  return (
    <div className="pad pad--fill">
      <Heading>Bin</Heading>
      <Text variant="mono" as="p">
        {binName == null
          ? 'Deleted photos. The RAW files still exist, left exactly where they were on disk.'
          : `Deleted photos. The RAW files still exist, moved into a ${binName} folder on disk.`}
      </Text>

      <GridControls />
      <BulkBar />
      <PhotoGrid emptyHint="Nothing has been deleted from this library." />
    </div>
  );
});
