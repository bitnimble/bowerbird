import { action } from 'mobx';
import { type Triage } from '../../../../../src/schemas/photos';
import { photosApi } from '../../../api/photos';
import type { ViewerPresenter } from './viewer_presenter';

const HELD_VERDICT_MS = 150;

type Patch = (
  photoId: string,
  fields: Parameters<typeof photosApi.update>[1],
  options?: { quiet?: boolean },
) => Promise<boolean>;

export class MarksPresenter {
  private verdictTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly viewer: ViewerPresenter,
    private readonly patch: Patch,
    private readonly isCurrent: (photoId: string) => boolean,
  ) {}

  async setRating(photoId: string, rating: number): Promise<void> {
    await this.patch(photoId, { rating });
  }

  async setTriage(photoId: string, triage: Triage, options: { quiet?: boolean } = {}): Promise<boolean> {
    return this.patch(photoId, { triage }, options);
  }

  holdVerdict(triage: Triage | null): void {
    this.viewer.holdVerdict(triage);
    clearTimeout(this.verdictTimer);
    if (triage != null) this.verdictTimer = setTimeout(this.releaseVerdict, HELD_VERDICT_MS);
  }

  @action.bound
  private releaseVerdict(): void {
    this.viewer.holdVerdict(null);
  }

  async setNotes(photoId: string, notes: string): Promise<void> {
    await this.patch(photoId, { notes });
    // Blurring the box and stepping on is one gesture during a cull, so the save
    // routinely lands on a photo the reader has already left - where "saved"
    // would be a claim about a note they never wrote.
    if (!this.isCurrent(photoId)) return;
    this.viewer.notesSaved();
  }
}
