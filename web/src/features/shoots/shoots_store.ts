import { computed, observable } from 'mobx';
import type { Shoot } from '../../api/client';

export interface ShootNode {
  shoot: Shoot;
  depth: number;
}

export class ShootsStore {
  @observable.shallow accessor shoots: Shoot[] = [];
  @observable accessor loading = false;
  @observable accessor error: string | null = null;

  @computed get byId(): Map<string, Shoot> {
    return new Map(this.shoots.map((s) => [s.id, s]));
  }

  // Flattened depth-first so the component can render the hierarchy without
  // recursing. The API already returns them ordered by folder_path, so a child
  // always follows its parent; depth comes from the path itself, which stays
  // correct even if a parent_id link is missing.
  @computed get tree(): ShootNode[] {
    return this.shoots.map((shoot) => ({ shoot, depth: shoot.folder_path.split('/').length - 1 }));
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.shoots.length === 0;
  }
}
