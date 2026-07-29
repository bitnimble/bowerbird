import { observable } from 'mobx';
import type { ViewerRendition, ViewerRenditionMode } from '../../api/client';

// The settings that belong to the catalogue rather than to a library or to the
// deployment. Server-side rather than in this browser: the same catalogue is
// opened from a phone, a laptop and whatever is plugged into the good monitor,
// and "the rendition I was last looking at" is worth nothing if it only holds
// on one of them.
export class AppSettingsStore {
  @observable accessor viewerRenditionMode: ViewerRenditionMode = 'remember';
  @observable accessor lastViewerRendition: ViewerRendition | null = null;
}
