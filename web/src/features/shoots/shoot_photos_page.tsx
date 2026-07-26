import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { usePhotosStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { ErrorBanner, Heading, Text } from '../../ui/ui';
import { BulkBar } from '../photos/bulk_bar';
import { GridControls } from '../photos/grid_controls';
import { PhotoGrid } from '../photos/photo_grid';

export const ShootPhotosPage = observer(function ShootPhotosPage(): JSX.Element {
  const { shootId = '' } = useParams();
  const store = usePhotosStore();
  const shootsStore = useShootsStore();
  const { photos, shoots } = usePresenters();
  const shoot = shootsStore.byId.get(shootId);

  useEffect(() => {
    void photos.open({ kind: 'shoot', shootId });
    void shoots.openShoot(shootId);
  }, [shootId, photos, shoots]);

  return (
    <div className="pad">
      <Heading>{shoot?.name ?? 'Shoot'}</Heading>
      <Text variant="mono" as="p">
        {shoot?.folder_path ?? shootId}
      </Text>

      <ErrorBanner message={store.error} onDismiss={photos.clearError} />
      <GridControls />
      <BulkBar removeFrom={shoot == null ? undefined : { kind: 'shoot', id: shoot.id, name: shoot.name }} />
      <PhotoGrid emptyHint="Select photos in the library view and add them to this shoot." />
    </div>
  );
});
