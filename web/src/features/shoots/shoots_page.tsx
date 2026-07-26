import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { CollectionRow } from '../../app/collection_row';
import { usePresenters, useShootsStore } from '../../app/stores_context';
import { Button, Heading, ICON, type Option, Select, Text, TextField } from '../../ui/ui';

export const ShootsPage = observer(function ShootsPage(): JSX.Element {
  const { libraryId = '' } = useParams();
  const store = useShootsStore();
  const { shoots } = usePresenters();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');

  useEffect(() => {
    void shoots.load(libraryId);
  }, [libraryId, shoots]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (name.trim() === '') return;
    if (await shoots.create(libraryId, name.trim(), parentId === '' ? null : parentId, 'taken_desc')) {
      setName('');
      setParentId('');
    }
  }

  const parents: Option<string>[] = [
    { value: '', label: 'Top level' },
    ...store.shoots.map((s) => ({ value: s.id, label: `inside ${s.folder_path}` })),
  ];

  return (
    <div className="pad">
      <Heading>Shoots</Heading>
      <Text variant="mono" as="p">
        A shoot is a real folder on disk. Creating one makes the folder; adding photos moves the files.
      </Text>

      {store.error != null && (
        <div className="error">
          <span>{store.error}</span>
          <Button onClick={shoots.clearError}>Dismiss</Button>
        </div>
      )}

      <div className="panel">
        <form className="row" onSubmit={(e) => void submit(e)}>
          <TextField grow label="Shoot name" placeholder="Shoot name" value={name} onChange={setName} />
          <Select label="Parent shoot" options={parents} value={parentId} onChange={setParentId} />
          <Button variant="primary" type="submit">
            <FolderPlus size={ICON} />
            Create shoot
          </Button>
        </form>
      </div>

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
