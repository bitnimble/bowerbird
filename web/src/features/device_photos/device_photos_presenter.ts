import { action } from 'mobx';
import {
  CreateLibraryRequestSchema,
  type CreateLibraryRequest,
} from '../../../../src/schemas/libraries';
import type { PhotoAccess, PhotoAsk } from '../../api/transport';
import { describe } from '../../errors';
import type { ScanPresenter } from '../scan/scan_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { DevicePhotosPresenterStrings } from './device_photos_presenter.strings';
import type { DevicePhotosStore } from './device_photos_store';

export interface PhotoShell {
  access(): Promise<PhotoAccess | null>;
  ask(ask: PhotoAsk): Promise<PhotoAccess | null>;
}

export class DevicePhotosPresenter {
  constructor(
    private readonly store: DevicePhotosStore,
    private readonly shell: PhotoShell,
    private readonly scan: Pick<ScanPresenter, 'scanLibrary'>,
    private readonly toasts: Pick<ToastsPresenter, 'showError'>,
  ) {}

  /** Rereads on return to the app, since system settings can change access meanwhile. */
  follow(): () => void {
    const changed = (): void => {
      if (document.visibilityState === 'visible') void this.load();
    };
    void this.load();
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }

  async load(): Promise<void> {
    let access: PhotoAccess | null = null;
    try {
      access = await this.shell.access();
    } catch (err) {
      this.toasts.showError(DevicePhotosPresenterStrings.couldNotReadAccess(), describe(err));
    }
    this.answered(access, null);
  }

  addLibrary(): Promise<void> {
    return this.whileAsking(async () => {
      const access =
        this.store.access?.photos === 'none' ? await this.ask('read') : this.store.access;
      if (access == null || access.photos === 'none') return;
      this.openNewLibrary(
        CreateLibraryRequestSchema.parse({
          root_path: access.cameraFolder,
          name: DevicePhotosPresenterStrings.libraryName(),
          ordering: 'taken_desc',
          include_non_raw: true,
          rendition_source: 'embedded',
          render_skip_full: ['dust'],
          render_skip_max: ['dust'],
        }),
      );
    });
  }

  @action.bound
  setAdding(adding: boolean): void {
    this.store.adding = adding;
  }

  @action.bound
  private openNewLibrary(request: CreateLibraryRequest): void {
    this.store.newLibrary = request;
    this.store.adding = true;
  }

  choosePhotos(): Promise<void> {
    return this.whileAsking(async () => {
      await this.ask('read');
      await this.rescan();
    });
  }

  allowChanges(): Promise<void> {
    return this.whileAsking(async () => void (await this.ask('management')));
  }

  openSettings(): Promise<void> {
    return this.whileAsking(async () => {
      await this.ask('settings');
      await this.rescan();
    });
  }

  private async whileAsking(work: () => Promise<void>): Promise<void> {
    if (this.store.asking) return;
    this.setAsking(true);
    try {
      await work();
    } finally {
      this.setAsking(false);
    }
  }

  private async rescan(): Promise<void> {
    const library = this.store.library;
    const photos = this.store.access?.photos;
    if (library != null && (photos === 'all' || photos === 'selected')) {
      await this.scan.scanLibrary(library.id);
    }
  }

  private async ask(ask: PhotoAsk): Promise<PhotoAccess | null> {
    try {
      const access = await this.shell.ask(ask);
      this.answered(access, ask);
      return access;
    } catch (err) {
      this.toasts.showError(DevicePhotosPresenterStrings.couldNotAsk(), describe(err));
      return null;
    }
  }

  @action.bound
  private answered(access: PhotoAccess | null, ask: PhotoAsk | null): void {
    this.store.access = access;
    this.store.read = true;
    if (access?.photos !== 'none') this.store.refused = false;
    else if (ask === 'read') this.store.refused = true;
  }

  @action.bound
  private setAsking(asking: boolean): void {
    this.store.asking = asking;
  }
}
