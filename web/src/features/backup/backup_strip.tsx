import { observer } from 'mobx-react-lite';
import { PathSegment, route } from '../../../../src/schemas/route';
import { useBackupStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { TextLink } from '../../ui/link';
import { StatusDot, Strip, StripLabel } from '../../ui/strip';
import { BackupStrings } from './backup_panel.strings';
import { backupPresentation } from './backup_status';
import { BackupStatusStrings } from './backup_status.strings';

export const BackupStrip = observer(function BackupStrip({ libraryId }: { libraryId: string }): JSX.Element | null {
  const store = useBackupStore();
  const { backup } = usePresenters();
  const status = store.statusOf(libraryId);
  if (store.readError == null && status?.configured !== true) return null;
  const view = status?.configured === true ? backupPresentation(status) : null;
  return <div role="status" aria-label={BackupStrings.heading()} aria-live="polite">
    <Strip>
      <StatusDot state={view?.state} />
      <StripLabel tone={store.readError != null ? 'error' : view?.tone}>{store.readError ?? view?.label}</StripLabel>
      {store.readError == null && status?.configured === true && status.activity?.current != null && <StripLabel>
        {BackupStatusStrings.currentFile(status.activity.current)}
      </StripLabel>}
      {store.readError != null && <Button onClick={() => void backup.load()}>{BackupStatusStrings.retry()}</Button>}
      <TextLink to={route(PathSegment.settings(), PathSegment.libraries(), libraryId, PathSegment.backup())}>
        {BackupStatusStrings.viewBackup()}
      </TextLink>
    </Strip>
  </div>;
});
