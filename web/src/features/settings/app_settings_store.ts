import { observable } from 'mobx';
import type { Settings, ViewerRendition, ViewerRenditionMode } from '../../api/client';

// Everything the user can change that belongs to neither a library nor this
// browser: the viewer's preferences and the server's own tuning. Server-side
// because the same catalogue is opened from a phone, a laptop and whatever is
// plugged into the good monitor, and because processing reads half of them.
//
// One observable for the whole record rather than a field each: they arrive and
// are written back as one object, and a component reading two of them should not
// need two subscriptions. Null until the first load, so the settings page shows
// what the server holds rather than a guess it would then correct.
export class AppSettingsStore {
  @observable.ref accessor settings: Settings | null = null;

  // The viewer opens photos before the settings arrive, so these two answer
  // with the shipped behaviour rather than nothing.
  get viewerRenditionMode(): ViewerRenditionMode {
    return this.settings?.viewer_rendition_mode ?? 'remember';
  }

  get lastViewerRendition(): ViewerRendition | null {
    return this.settings?.last_viewer_rendition ?? null;
  }
}
