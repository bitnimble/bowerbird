import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { usePresenters } from '../../../app/stores_context';
import { Heading } from '../../../ui/heading';
import { Page, PageLead } from '../../../ui/page';
import { BinPageStrings } from './bin_page.strings';
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
    <Page fill>
      <Heading>
        <PageLead />
        {BinPageStrings.bin()}
      </Heading>

      <GridControls />
      <BulkBar />
      <PhotoGrid emptyHint={BinPageStrings.emptyHint()} />
    </Page>
  );
});
