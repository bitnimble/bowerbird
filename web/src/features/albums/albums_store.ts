import { computed, observable } from 'mobx';
import { type Album } from '../../../../src/schemas/albums';
import { CollectionListStrings } from '../../app/collection_list.strings';
import { CollectionListStore, type CollectionRow } from '../../app/collection_list_store';
import { GridControlsStrings } from '../photos/grid/grid_controls.strings';
import { collectionPath } from '../photos/photos_store';

export interface AlbumRow extends CollectionRow {
  album: Album;
}

export class AlbumsStore extends CollectionListStore<AlbumRow> {
  @observable.shallow accessor albums: Album[] = [];

  @computed get byId(): Map<string, Album> {
    return new Map(this.albums.map((a) => [a.id, a]));
  }

  @computed get rows(): AlbumRow[] {
    return this.albums.map((album) => ({
      key: album.id,
      album,
      name: album.name,
      meta: CollectionListStrings.subtitle(GridControlsStrings.ordering(album.ordering), album.photo_count),
      bannerPhotoId: album.banner_photo_id,
      href: collectionPath({ kind: 'album', albumId: album.id }),
      depth: 0,
      expandable: false,
    }));
  }
}
