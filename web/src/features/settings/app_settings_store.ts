import { observable } from 'mobx';
import { type RenderTimings, type RenderedRendition } from '../../../../src/schemas/render_stages';
import { type Settings, type ViewerRendition, type ViewerRenditionMode } from '../../../../src/schemas/settings';

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
  /** What the app ships with, for the settings page's reset. Null until it has arrived. */
  @observable.ref accessor defaults: Settings | null = null;
  // What a render was measured to cost on the machine the server is on (§10.1). Empty is nothing
  // measured, which is the panel quoting estimates instead.
  @observable.ref accessor renderTimings: RenderTimings = {};
  // Which render benchmarks are in flight. Several renders of one photograph, so the button that
  // starts one has to stay busy for as long as it takes.
  @observable.shallow accessor benchmarking = new Set<RenderedRendition>();

  isBenchmarking(rendition: RenderedRendition): boolean {
    return this.benchmarking.has(rendition);
  }

  // The viewer opens photos before the settings arrive, so these two answer
  // with the shipped behaviour rather than nothing.
  get viewerRenditionMode(): ViewerRenditionMode {
    return this.settings?.viewer_rendition_mode ?? 'remember';
  }

  get lastViewerRendition(): ViewerRendition | null {
    return this.settings?.last_viewer_rendition ?? null;
  }

  get hideSidebarInViewer(): boolean {
    return this.settings?.hide_sidebar_in_viewer ?? true;
  }
}
