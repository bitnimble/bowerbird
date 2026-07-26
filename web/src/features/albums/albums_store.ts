import { computed, observable } from 'mobx';
import type { Album } from '../../api/client';

export class AlbumsStore {
  @observable.shallow accessor albums: Album[] = [];
  @observable accessor loading = false;
  @observable accessor error: string | null = null;

  @computed get byId(): Map<string, Album> {
    return new Map(this.albums.map((a) => [a.id, a]));
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.albums.length === 0;
  }
}
