import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { CollectionRow } from '../../app/collection_row';
import { useAlbumsStore, usePresenters } from '../../app/stores_context';
import { Button, Heading, ICON, Text, TextField } from '../../ui/ui';

export const AlbumsPage = observer(function AlbumsPage(): JSX.Element {
  const store = useAlbumsStore();
  const { albums } = usePresenters();
  const [name, setName] = useState('');

  useEffect(() => {
    void albums.load();
  }, [albums]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (name.trim() === '') return;
    if (await albums.create(name.trim(), 'taken_desc')) setName('');
  }

  return (
    <div className="pad">
      <Heading>Albums</Heading>
      <Text variant="mono" as="p">
        Albums group photos without touching the files. A photo can sit in any number of them.
      </Text>

      {store.error != null && (
        <div className="error">
          <span>{store.error}</span>
          <Button onClick={albums.clearError}>Dismiss</Button>
        </div>
      )}

      <div className="panel">
        <form className="row" onSubmit={(e) => void submit(e)}>
          <TextField grow label="Album name" placeholder="Album name" value={name} onChange={setName} />
          <Button variant="primary" type="submit">
            <Plus size={ICON} />
            Create album
          </Button>
        </form>
      </div>

      {store.isEmpty ? (
        <div className="empty">
          <div className="empty__title">No albums yet</div>
          <Text as="p" variant="muted">
            Make an album to collect photos from across shoots and libraries.
          </Text>
        </div>
      ) : (
        <div className="list">
          {store.albums.map((album) => (
            <CollectionRow
              key={album.id}
              name={album.name}
              subtitle={album.ordering}
              photoCount={album.photo_count}
              bannerPhotoId={album.banner_photo_id}
              viewHref={`/albums/${album.id}`}
              onRename={(next) => void albums.rename(album.id, next)}
              onDelete={() => void albums.remove(album.id)}
              deleteWarning={`Delete the album "${album.name}"?\n\nThe photos themselves are untouched, but the album and its ${album.photo_count} membership(s) are removed and cannot be recovered.`}
            />
          ))}
        </div>
      )}
    </div>
  );
});
