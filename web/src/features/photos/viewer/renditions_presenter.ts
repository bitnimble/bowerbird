import { type ProcessingStage } from '../../../../../src/schemas/common';
import { type ViewerRendition } from '../../../../../src/schemas/settings';
import { type Rendition } from '../../../../../src/services/processing/renditions/renditions';
import { renditionsApi } from '../../../api/renditions';
import type { DeviceSettingsStore } from '../../settings/device_settings_store';
import type { ListingPresenter } from '../grid/listing_presenter';
import type { StackActionsPresenter } from '../grid/stack_actions_presenter';
import { renderHere } from './render_here';
import type { ViewerPresenter } from './viewer_presenter';
import type { ViewerStore } from './viewer_store';

export class RenditionsPresenter {
  constructor(
    private readonly store: ViewerStore,
    private readonly device: DeviceSettingsStore,
    private readonly viewer: ViewerPresenter,
    private readonly listing: ListingPresenter,
    private readonly stacks: StackActionsPresenter,
    private readonly refreshDetail: () => Promise<void>,
    private readonly fail: (error: unknown) => void,
    private readonly isCurrent: (photoId: string) => boolean,
  ) {}

  // This photo's render, made again from the RAW rather than served from the file
  // that already exists. For working on the pipeline itself: the file *is* the
  // cache, so a change to a decode setting is invisible on every photo already
  // looked at until something deletes what is there.
  //
  // **Whichever rendition is on screen**, since that is the one being looked at: a reader
  // on Rendered RAW (max quality) who asks for a re-render and gets `full` rebuilt is told
  // the pipeline has not changed, by a picture that was never remade. The camera's JPEG is
  // the RAW's own bytes and has no build to force past, so from there this remakes the
  // render behind it - and nothing at all where the photograph has no render to remake,
  // which is the same answer the menu greys the action out on (`rerenderTarget`).
  async rerender(photoId: string): Promise<void> {
    const target = this.store.rerenderTarget;
    if (target == null) return;
    await this.ensureBuilt(photoId, target, true);
  }

  // Puts a rendition on screen, building it first if it is not on disk.
  async show(photoId: string, rendition: ViewerRendition): Promise<void> {
    if (!(await this.ensureBuilt(photoId, rendition))) return;
    if (!this.isCurrent(photoId)) return;
    this.viewer.chooseRendition(rendition);
  }

  // Builds the rendition the first time and leaves the cached file alone every
  // time after. The camera's JPEG is never built: it is the RAW's own bytes
  // (§10.2). False when the build failed, so a caller does not go on to ask for a
  // file that is not there.
  private async ensureBuilt(photoId: string, rendition: ViewerRendition, force = false): Promise<boolean> {
    // The detail on hand is the previous photo's until this one's fetch lands, so
    // "already built" has to be read from *this* photo's entry or not at all:
    // trusting the neighbour's said a file existed that was never built here, and
    // the build was skipped in favour of a 404.
    const built = this.store.detailFor(photoId)?.renditions?.[rendition]?.built === true;

    // Nothing to do is the common case, and running the rest of this for it costs as much
    // as a build. Swapping between two renditions already on screen would take that path
    // every time: it raises the building flag - so pressing O for a render already shown
    // flashes "Rendering" over it - and it awaits a detail fetch before the swap is allowed,
    // which is a delay before the camera's JPEG appears on I, long enough on a slow library
    // to look as though nothing happened. Both views are kept in the DOM precisely so this
    // is instant.
    //
    // A copy served whole is there whenever its file is, so there is nothing to wait for and no
    // detail to wait for it to be reported in (`store.servedWhole`).
    if (this.store.servedWhole(photoId, rendition) || !(force || !built)) return true;

    this.viewer.buildStarted(photoId, rendition);
    try {
      await this.build(photoId, rendition, force);
      // The build may have written an HDR video beside the still, and only the
      // detail knows whether one exists. Without this, Firefox keeps showing the
      // dark still until the page is reloaded (§10.7). Only after a build, because
      // only a build can have written one.
      await this.refreshDetail();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this.viewer.buildFinished(photoId, rendition);
    }
  }

  // The server has rewritten one of this photo's derived files. Written into the
  // row every view already renders from, which is what moves that file's URLs on;
  // mobx notifies the one tile whose field changed and nothing else.
  //
  // Only the stamp for the stage that moved: the grid tile and the viewer's
  // renditions have one each, so rebuilding a photo's renditions leaves its tile
  // where it is rather than re-fetching bytes that did not change.
  rebuilt(photoId: string, stage: ProcessingStage, version: string): void {
    const fields = stage === 'tile' ? { tile_built_at: version } : { renditions_built_at: version };
    // The viewer's run as well as the grid's rows: a photograph the stage is holding as a
    // neighbour is read from whichever of those answers first, and a stack member has no
    // row of its own in a collapsed listing. Left out, a rebuild announced while the reader
    // is on the photograph beside it never moved that frame's URL, so stepping onto it
    // painted the file from before the rebuild - out of the copy the browser already had.
    this.listing.patchPhoto(photoId, fields);
    this.stacks.patchPhoto(photoId, fields);
    this.viewer.patchPhoto(photoId, fields);
    // The stamp moves the image's URL on, and nothing else: the panel beside it reads size,
    // dynamic range and path off the detail's rendition entries, which still describe the file
    // that was just replaced. A library-wide rebuild has no other point that re-reads them.
    if (this.isCurrent(photoId)) {
      void this.refreshDetail();
      return;
    }
    // Any other photograph's is dropped rather than re-read: nothing is showing it, and a
    // library-wide rebuild would otherwise re-read every detail this session has opened. Kept,
    // it describes the file that was just replaced - and `renditions[…].hdr` off a stale one
    // is what decides Firefox's HDR rewrap, so the photo reopens dark (§10.7).
    this.viewer.dropDetail(photoId);
  }

  // A photo whose processing never ran, or failed, has no rendition to serve and
  // nothing queued to change that, so the detail view would sit on "no rendition
  // yet" indefinitely. Builds the one that is actually missing rather than
  // reprocessing from the embedded JPEG: that rebuilds the grid rendition, which
  // is not what the viewer is asking for, so a library that renders would ask
  // again on the next paint and never stop.
  async buildMissing(photoId: string, rendition: Rendition): Promise<void> {
    if (this.store.building.has(`${photoId}:${rendition}`)) return;
    this.viewer.buildStarted(photoId, rendition);
    try {
      await this.build(photoId, rendition);
      await this.refreshDetail();
    } catch (error) {
      // Silent for anything but the photograph on screen. The viewer holds its neighbours
      // ready, so a cull through a library still importing meets one 404 per step, on a
      // photograph nobody is looking at yet - and a toast naming a failure the reader
      // cannot see, on a picture they have not reached, describes nothing they can act on.
      if (this.isCurrent(photoId)) this.fail(error);
    } finally {
      this.viewer.buildFinished(photoId, rendition);
    }
  }

  private async build(photoId: string, rendition: Rendition, force = false): Promise<void> {
    if (!this.device.renderOnThisDevice) return renditionsApi.build(photoId, rendition, force);
    await renderHere(photoId, rendition, force);
  }
}
