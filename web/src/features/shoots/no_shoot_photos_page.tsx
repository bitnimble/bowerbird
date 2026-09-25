import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { usePresenters } from '../../app/stores_context';
import { Heading } from '../../ui/heading';
import { Page, PageHead } from '../../ui/page';
import { BulkBar } from '../photos/grid/bulk_bar';
import { GridControls } from '../photos/grid/grid_controls';
import { PhotoGrid } from '../photos/grid/photo_grid';
import { NoShootPhotosStrings } from './no_shoot_photos_page.strings';

export const NoShootPhotosPage = observer(function NoShootPhotosPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const { photos } = usePresenters();

  useEffect(() => {
    void photos.open({ kind: 'no_shoot', libraryId });
  }, [libraryId, photos]);

  return (
    <Page fill>
      <PageHead withSidebarButton>
        <Heading>{NoShootPhotosStrings.notInAnyShoot()}</Heading>
      </PageHead>

      <GridControls />
      <BulkBar />
      <PhotoGrid emptyHint={NoShootPhotosStrings.emptyHint()} />
    </Page>
  );
});
