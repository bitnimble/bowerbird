import { computed, observable } from 'mobx';
import type { Library } from '../../../../src/schemas/libraries';
import type { PhotoAccess } from '../../api/transport';
import type { LibrariesStore } from '../libraries/libraries_store';

// Data only: observables + computeds. Every mutation lives on DevicePhotosPresenter.
export class DevicePhotosStore {
  /** Null in a browser, on a desktop, and until the shell answers. */
  @observable.ref accessor access: PhotoAccess | null = null;
  /** Whether the shell has answered yet, so a phone library is not taken for a synced one before. */
  @observable accessor read = false;
  @observable accessor asking = false;
  /** The reader was asked for access and allowed none. */
  @observable accessor refused = false;

  constructor(private readonly libraries: LibrariesStore) {}

  @computed get library(): Library | null {
    return this.libraries.libraries.find((library) => this.holds(library)) ?? null;
  }

  @computed get canAddLibrary(): boolean {
    return this.access != null && this.library == null;
  }

  holds(library: Pick<Library, 'root_path'>): boolean {
    const camera = this.access?.cameraFolder;
    if (camera == null) return false;
    return library.root_path === camera || library.root_path.startsWith(`${camera}/`);
  }
}
