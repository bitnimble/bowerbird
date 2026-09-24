import { action } from 'mobx';
import { type EditDoc } from '../../../../../src/schemas/photo_edits';
import { type PhotoDetail, type PhotoSummary, type Triage } from '../../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../../src/schemas/settings';
import { type Rendition } from '../../../../../src/services/processing/renditions/renditions';
import type { Span } from '../../../ui/virtual_rows';
import type { ViewerStore } from './viewer_store';
import type { RenderingIntent } from '../../../../../src/schemas/rendering_intent';

// How many photographs' details and develop documents are kept once read. A detail is a row
// of metadata and a document is a page of numbers, so the whole cache is smaller than one
// grid tile - and it only has to outlast a reader flipping between two frames, which is what
// a cull spends its time doing.
const REMEMBERED_PHOTOS = 64;

// Newest last, so the first key is the oldest and eviction is a walk from the front. The
// delete is what makes that recency rather than arrival order: a photograph read again
// moves to the back, so the two a cull is flipping between are the last to go rather than
// the first, having been read before the sixty-four that came after them.
function keep<T>(cache: Map<string, T>, photoId: string, value: T): void {
  cache.delete(photoId);
  cache.set(photoId, value);
  while (cache.size > REMEMBERED_PHOTOS) {
    const oldest = cache.keys().next().value;
    if (oldest == null) return;
    cache.delete(oldest);
  }
}

export class ViewerPresenter {
  constructor(private readonly store: ViewerStore) {}

  @action.bound
  clearNeighbourhood(): void {
    this.store.neighbourhood = [];
  }

  @action.bound
  setNeighbourhood(photos: PhotoSummary[]): void {
    this.store.neighbourhood = photos;
  }

  @action.bound
  beginDetail(
    photoId: string,
    lastStep: { to: string; direction: 'next' | 'prev' } | null,
    staleDetailId: string | null,
  ): void {
    this.store.lastStep = lastStep;
    if (staleDetailId != null) this.store.details.delete(staleDetailId);
    this.store.open = { id: photoId, status: 'loading' };
    this.store.notesSavedAt = null;
    this.store.rendition = null;
  }

  @action.bound
  detailReady(photoId: string): void {
    this.store.open = { id: photoId, status: 'ready' };
  }

  @action.bound
  detailMissing(photoId: string, error: string): void {
    this.store.open = { id: photoId, status: 'missing', error };
  }

  @action.bound
  forgetRemembered(): void {
    const open = this.store.open?.id;
    // Copied before deleting from what it was read out of.
    for (const photoId of Array.from(this.store.details.keys())) {
      if (photoId !== open) this.store.details.delete(photoId);
    }
    for (const photoId of Array.from(this.store.editDocs.keys())) {
      if (photoId !== open) this.store.editDocs.delete(photoId);
    }
  }

  @action.bound
  rememberDetail(detail: PhotoDetail): void {
    const held = this.store.details.get(detail.id);
    if (held != null && held !== detail) Object.assign(held, detail);
    // Through `keep` either way, hit or miss: the object is the held one on a hit, and what
    // the write is for there is the recency, without which the two photographs a cull flips
    // between are the first evicted rather than the last.
    keep(this.store.details, detail.id, held ?? detail);
    this.store.lastDetailId = detail.id;
  }

  @action.bound
  rememberEdits(photoId: string, doc: EditDoc): void {
    keep(this.store.editDocs, photoId, doc);
  }

  @action.bound
  forgetEdits(photoId: string, orientationChanged: boolean): void {
    this.store.editDocs.delete(photoId);
    if (orientationChanged) {
      this.store.orientationVersions.set(photoId, (this.store.orientationVersions.get(photoId) ?? 0) + 1);
    }
    this.store.details.delete(photoId);
  }

  @action.bound
  turned(photoId: string, doc: EditDoc, rendition: ViewerRendition, chooseRendition: boolean): void {
    keep(this.store.editDocs, photoId, doc);
    this.store.orientationVersions.set(photoId, (this.store.orientationVersions.get(photoId) ?? 0) + 1);
    if (chooseRendition && this.store.rendition == null) this.store.rendition = rendition;
  }

  @action.bound
  chooseRendition(rendition: ViewerRendition): void {
    this.store.rendition = rendition;
  }

  @action.bound
  chooseProof(proof: 'hdr' | 'srgb'): void {
    this.store.proof = proof;
  }

  @action.bound
  chooseProofIntent(intent: RenderingIntent): void {
    this.store.proofIntent = intent;
  }

  @action.bound
  dropDetail(photoId: string): void {
    this.store.details.delete(photoId);
  }

  @action.bound
  holdVerdict(triage: Triage | null): void {
    this.store.heldVerdict = triage;
  }

  @action.bound
  notesSaved(): void {
    this.store.notesSavedAt = Date.now();
  }

  @action.bound
  patchPhoto(photoId: string, fields: Partial<PhotoSummary>): void {
    const neighbour = this.store.neighbourById(photoId);
    if (neighbour != null) Object.assign(neighbour, fields);
    const detail = this.store.detailFor(photoId);
    if (detail != null) Object.assign(detail, fields);
  }

  /**
   * What the viewer's filmstrip is over, or null once it has gone.
   *
   * Written from here rather than by the strip's own presenter because this is the
   * only writer of `ViewerStore` (§18.5); what the strip owns is its own view.
   */
  @action.bound
  setStripSpan(span: Span | null): void {
    this.store.stripSpan = span;
  }

  /** The space the detail view's stage and panels share. */
  @action.bound
  setDetailBox(width: number, height: number): void {
    this.store.detailWidth = width;
    this.store.detailHeight = height;
  }

  @action.bound
  renditionAsked(): void {
    this.store.renditionPicks++;
  }

  @action.bound
  buildStarted(photoId: string, rendition: Rendition | ViewerRendition): void {
    this.store.building = new Set(this.store.building).add(`${photoId}:${rendition}`);
  }

  // Only for as long as the build is running. Held past that, a build that failed
  // - a RAW that was briefly unreadable, a worker that could not spawn - was never
  // attempted again for the life of the tab, and the set grew with every photo
  // that ever asked.
  @action.bound
  buildFinished(photoId: string, rendition: Rendition | ViewerRendition): void {
    const next = new Set(this.store.building);
    next.delete(`${photoId}:${rendition}`);
    this.store.building = next;
  }

  @action.bound
  serverReachable(): void {
    this.store.serverEpoch++;
  }

  // Reported by the stage when a frame has decoded, so the panel beside it can
  // describe what is on screen rather than what a column claims. Carries which
  // file decoded, because the stage reports once per frame and the panel is read
  // on every render after it.
  @action.bound
  imageShown(photoId: string, rendition: ViewerRendition, width: number, height: number): void {
    // Anything measured for another photo goes: that is the step, and this is the
    // first frame of the photo stepped to.
    const kept = this.store.shownImages.filter((shown) => shown.photoId === photoId);
    const shown = { photoId, rendition, width, height };
    // In place when this rendition has decoded before - a rebuild moves its URL, so
    // it decodes again - because the order here is the order the stage mounts its
    // frames in, and a slot moving reinserts a DOM node mid-swap.
    this.store.shownImages = kept.some((held) => held.rendition === rendition)
      ? kept.map((held) => (held.rendition === rendition ? shown : held))
      : [...kept, shown];
  }
}
