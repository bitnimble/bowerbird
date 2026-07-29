import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { CollectionRow } from '../../app/collection_row';
import { usePresenters, useShootsStore } from '../../app/stores_context';
import { Button, Heading, ICON, Text } from '../../ui/ui';
import { AddShootDialog } from './add_shoot_dialog';

export const ShootsPage = observer(function ShootsPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const store = useShootsStore();
  const { shoots, libraries } = usePresenters();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void shoots.load(libraryId);
    // The picker names the library root after the library, which the rail has
    // usually loaded already but a deep link has not.
    void libraries.load();
  }, [libraryId, shoots, libraries]);

  return (
    <div className="pad">
      <div className="row page__head">
        <Heading>Shoots</Heading>
        <span className="spacer" />
        <Button variant="primary" onClick={() => setAdding(true)}>
          <FolderPlus size={ICON} />
          Add shoot
        </Button>
      </div>
      <Text variant="mono" as="p">
        A shoot is a real folder on disk. Creating one makes the folder, and adding photos moves the files.
      </Text>

      {store.error != null && (
        <div className="error">
          <span>{store.error}</span>
          <Button onClick={shoots.clearError}>Dismiss</Button>
        </div>
      )}

      <AddShootDialog libraryId={libraryId} open={adding} onOpenChange={setAdding} />

      {store.isEmpty ? (
        <div className="empty">
          <div className="empty__title">No shoots yet</div>
          <Text as="p" variant="muted">
            Group a library into shoots to organise the files on disk, not just in the catalogue.
          </Text>
        </div>
      ) : (
        <div className="list">
          {store.tree.map(({ shoot, depth }) => (
            <CollectionRow
              key={shoot.id}
              name={shoot.name}
              subtitle={shoot.folder_path}
              photoCount={shoot.photo_count}
              bannerPhotoId={shoot.banner_photo_id}
              viewHref={`/shoots/${shoot.id}`}
              indent={depth}
              onRename={(next) => void shoots.rename(shoot.id, next)}
              onDelete={() => void shoots.remove(shoot.id)}
              deleteWarning={`Delete the shoot "${shoot.name}"?\n\nThe folder and its ${shoot.photo_count} photo(s) stay on disk, but the grouping is removed from the catalogue and cannot be undone.`}
            />
          ))}
        </div>
      )}
    </div>
  );
});
