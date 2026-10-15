import { observer } from 'mobx-react-lite';
import { ImagePlus, Images, Settings, ShieldCheck } from 'lucide-react';
import { useDevicePhotosStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import { Text } from '../../ui/text';
import { AddLibraryDialog } from '../libraries/add_library_dialog';
import { DevicePhotosActionsStrings } from './device_photos_actions.strings';

export const DevicePhotosActions = observer(function DevicePhotosActions({
  primary,
}: {
  primary: boolean;
}): JSX.Element | null {
  const store = useDevicePhotosStore();
  const { devicePhotos } = usePresenters();
  const { access, library, asking } = store;
  if (access == null) return null;

  return (
    <>
      {store.canAddLibrary && (
        <Button
          variant={primary ? 'primary' : 'default'}
          disabled={asking}
          onClick={() => void devicePhotos.addLibrary()}
        >
          <ImagePlus size={ICON} />
          {DevicePhotosActionsStrings.addLibrary()}
        </Button>
      )}
      {library != null && access.photos === 'none' && !store.refused && (
        <Button disabled={asking} onClick={() => void devicePhotos.choosePhotos()}>
          <ShieldCheck size={ICON} />
          {DevicePhotosActionsStrings.allowAccess()}
        </Button>
      )}
      {library != null && access.photos === 'selected' && (
        <Button disabled={asking} onClick={() => void devicePhotos.choosePhotos()}>
          <Images size={ICON} />
          {DevicePhotosActionsStrings.choosePhotos()}
        </Button>
      )}
      {library != null && access.manageable && !access.managed && (
        <Button disabled={asking} onClick={() => void devicePhotos.allowChanges()}>
          <ShieldCheck size={ICON} />
          {DevicePhotosActionsStrings.allowChanges()}
        </Button>
      )}
      {store.refused && (
        <>
          <Text variant="muted">{DevicePhotosActionsStrings.noAccess()}</Text>
          <Button disabled={asking} onClick={() => void devicePhotos.openSettings()}>
            <Settings size={ICON} />
            {DevicePhotosActionsStrings.openSettings()}
          </Button>
        </>
      )}
      {store.newLibrary != null && (
        <AddLibraryDialog
          open={store.adding}
          onOpenChange={devicePhotos.setAdding}
          preset={store.newLibrary}
        />
      )}
    </>
  );
});
