import { observer } from 'mobx-react-lite';
import { ArrowUpCircle } from 'lucide-react';
import { SidebarButton, SidebarText } from '../sidebar/sidebar_link';
import { usePresenters, useUpdatesStore } from '../../app/stores_context';
import { UpdatesStrings } from './updates.strings';

export const UpdateBadge = observer(function UpdateBadge(): JSX.Element | null {
  const store = useUpdatesStore();
  const { updates } = usePresenters();
  const available = store.available;
  return (
    <>
      {available != null && (
        <SidebarButton icon={ArrowUpCircle} tone="update" onClick={updates.openDialog}>
          <SidebarText>{UpdatesStrings.updateAvailable(available.version)}</SidebarText>
        </SidebarButton>
      )}
      {store.modelAvailable != null && !store.modelDownloading && (
        <SidebarButton icon={ArrowUpCircle} tone="update" onClick={updates.downloadModel}>
          <SidebarText>{UpdatesStrings.modelUpdateAvailable()}</SidebarText>
        </SidebarButton>
      )}
    </>
  );
});
