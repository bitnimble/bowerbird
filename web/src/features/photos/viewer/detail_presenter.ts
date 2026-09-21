import { photoEditsApi } from '../../../api/photo_edits';
import { photosApi } from '../../../api/photos';
import { newId } from '../../../../../src/schemas/id';
import type { RequestActivity } from '../../../../../src/schemas/request_activity';
import type { AppSettingsPresenter } from '../../settings/app_settings_presenter';
import { sourceKey, type PhotoSource } from '../photos_store';
import type { ListingStore } from '../grid/listing_store';
import type { ViewerPresenter } from './viewer_presenter';
import type { ViewerStore } from './viewer_store';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DetailPresenter {
  constructor(
    private readonly listing: ListingStore,
    private readonly store: ViewerStore,
    private readonly viewer: ViewerPresenter,
    private readonly settings: AppSettingsPresenter,
    private readonly begin: (photoId: string) => void,
    private readonly openCollection: (source: PhotoSource) => Promise<void>,
    private readonly showRendition: (photoId: string, rendition: 'embedded' | 'full' | 'max') => Promise<void>,
    private readonly isCurrent: (photoId: string) => boolean,
    private readonly fail: (error: unknown) => void,
    private readonly enqueue: (run: () => Promise<void>) => Promise<void>,
  ) {}

  /**
   * Drops every remembered detail and develop document but the open photograph's.
   *
   * The open one is what the panels are rendering from, so it is re-read by whoever calls
   * this rather than dropped under them; the rest cost one fetch each on the next open,
   * which is what they cost before they were remembered at all.
   */
  forgetRemembered(): void {
    this.viewer.forgetRemembered();
  }


  // --- detail ---

  async openDetail(photoId: string, from: PhotoSource | null = null): Promise<void> {
    this.begin(photoId);
    // The collection the URL nests this photo under, loaded alongside the detail
    // rather than after it, so the way back out is right from the first frame
    // instead of pointing at the whole library until the fetch lands. Only when
    // it is not already what is loaded: stepping through a collection would
    // otherwise re-read it on every frame.
    const held = this.listing.source;
    if (from != null && (held == null || sourceKey(held) !== sourceKey(from))) void this.openCollection(from);
    // Before the fetch, not before the call: the settings decide which rendition
    // this photo opens at, but waiting on them to say the detail is in flight
    // leaves the page unable to tell "loading" from "no such photo".
    await this.settings.load();
    try {
      // Read once per photograph, not once per open: a reader flipping between two frames
      // asks for the same two details over and over, and the fetch was the whole cost of a
      // step that has nothing else to do. Whatever changes one afterwards writes into the
      // held object rather than replacing it, so a hit is the same answer a read would give.
      const detail = this.store.detailFor(photoId) ?? (await photosApi.get(photoId));
      // Two of these can be in flight at once - stepping faster than the fetch -
      // and they need not answer in order. The straggler's photo is one the user
      // has already left, so writing it would replace the detail on screen with
      // the one before it and leave the page reporting the open photo as missing.
      if (!this.isCurrent(photoId)) return;
      this.viewer.rememberDetail(detail);
      this.viewer.detailReady(photoId);
      // Landing straight on a photo URL leaves no collection loaded, so the
      // neighbours are unknown and prev/next are dead. Open the photo's library
      // so stepping works from a deep link as well as from the grid.
      if (this.listing.source == null) await this.openCollection({ kind: 'library', libraryId: detail.library_id });
      // A second await, and a slower one - a whole page of the library. The
      // rendition written below is a single shared field, so a reader who has
      // moved on while that was in flight must not have this photo's applied.
      if (!this.isCurrent(photoId)) return;
      // **Unless the reader has already chosen one.** `beginDetail` cleared this, so anything
      // here is a choice that landed while the fetches above were in flight - and the opening
      // rendition is what the *library* would have picked, so applying it now silently discards
      // a deliberate keypress. `isCurrent` does not cover this: the reader has not moved to
      // another photo, they have asked this one for something else. Pressing O straight after a
      // step lands exactly here, and the build succeeds before being overwritten, which is why
      // it looks like nothing happened rather than like a failure.
      if (this.store.rendition != null) return;
      // Only ever a rendition that has to be made first. One the photo already has is what
      // it opened at, needing neither a build nor a round trip to learn that - the server
      // resolved both on this same read (`shown_rendition`, `rendition_to_build`), so there
      // is nothing left for this client to work out.
      if (detail.rendition_to_build != null) await this.showRendition(photoId, detail.rendition_to_build);
    } catch (err) {
      if (!this.isCurrent(photoId)) return;
      // On the open photo rather than in the store's shared error slot, which a
      // list fetch also writes: a library that failed to load must not read as
      // this photo being missing from the catalogue.
      this.viewer.detailMissing(photoId, message(err));
    }
  }

  // Its own read rather than a field of the detail: the document is the editor's, it is large
  // beside a row of metadata, and nothing outside the panel that lists it asks.
  async loadEdits(photoId: string): Promise<void> {
    if (this.store.editsFor(photoId) != null || this.readingEdits.has(photoId)) return;
    this.readingEdits.add(photoId);
    const generation = this.editsGeneration;
    try {
      const state = await photoEditsApi.get(photoId).catch(() => null);
      // Dropped rather than stored when something forgot this document while the read was
      // out: leaving the editor is exactly that, and the answer in flight is the document
      // from before the save - stored, it is what every later open reads.
      if (state == null || this.editsGeneration !== generation) return;
      this.viewer.rememberEdits(photoId, state.doc);
    } finally {
      // Cleared however it went, so a read that failed is asked again rather than leaving the
      // panel reading "loading" for the life of the tab.
      this.readingEdits.delete(photoId);
    }
  }

  private readonly readingEdits = new Set<string>();
  // Bumped by `forgetEdits`, so a read still out when one lands cannot write over it.
  private editsGeneration = 0;

  /**
   * Drops what was read for a photograph, so the next ask goes to the server.
   *
   * The editor writes this document behind the panel's back - a different store, a different
   * presenter - so leaving it is the one moment the held copy is known to be behind.
   */
  forgetEdits(photoId: string, orientationChanged = false): void {
    this.editsGeneration++;
    this.viewer.forgetEdits(photoId, orientationChanged);
    // The detail goes with it. A save moves `is_edited`, which the server resolves
    // `shown_rendition` from, and the render behind it - so a held one answers the next
    // open with the photograph as it was before the edit, at the file it was drawn from
    // then. Dropped rather than re-read: leaving the editor opens the viewer, which reads it.
  }


  async turn(photoId: string, by: 90 | -90): Promise<void> {
    const rendition = this.store.frameOf(photoId).rendition;
    await this.enqueue(async () => {
      try {
        const current = await photoEditsApi.get(photoId);
        const rotate = (((current.doc.rotate + by) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
        const saved = await photoEditsApi.save(photoId, { ...current.doc, rotate }, current.rev, newId());
        this.editsGeneration++;
        this.viewer.turned(photoId, saved.doc, rendition, this.isCurrent(photoId));
        await photoEditsApi.finish(photoId);
        await this.refresh();
      } catch (err) {
        this.fail(err);
      }
    });
  }


  async refresh(activity: RequestActivity = 'interactive'): Promise<void> {
    const open = this.store.open;
    if (open == null) return;
    const detail = await photosApi.get(open.id, activity).catch(() => null);
    // The re-read is of whatever was open when it started, which a step during
    // the round trip has already replaced.
    if (detail != null && this.isCurrent(detail.id)) this.viewer.rememberDetail(detail);
  }

}
