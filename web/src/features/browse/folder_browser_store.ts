import { observable } from 'mobx';
import type { BrowseResponse } from '../../api/client';

// One directory of the server's filesystem at a time, for the picker that
// chooses a library root. Data only: every mutation lives on
// FolderBrowserPresenter.
export class FolderBrowserStore {
  @observable.ref accessor listing: BrowseResponse | null = null;
  @observable accessor loading = false;
  @observable accessor error: string | null = null;
}
