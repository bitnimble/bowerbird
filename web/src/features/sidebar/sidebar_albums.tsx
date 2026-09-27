import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { Images } from 'lucide-react';
import { PathSegment, route } from '../../../../src/schemas/route';
import { useAlbumsStore, usePresenters } from '../../app/stores_context';
import { SidebarRow } from './sidebar_row';

export const SidebarAlbums = observer(function SidebarAlbums(): JSX.Element {
  const store = useAlbumsStore();
  const { albums } = usePresenters();
  useEffect(() => void albums.load(), [albums]);

  return (
    <>
      {store.albums.map((album) => (
        <SidebarRow
          key={album.id}
          to={route(PathSegment.albums(), album.id)}
          icon={Images}
          name={album.name}
          count={album.photo_count}
          depth={1}
        />
      ))}
    </>
  );
});
