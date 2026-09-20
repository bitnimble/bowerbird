import { action } from 'mobx';
import { type EditDoc } from '../../../../../src/schemas/photo_edits';
import type { CropPresenter } from '../crop/crop_presenter';
import { turnedPointForDocument } from '../crop/crop_turn';
import type { EditStore } from '../edit/edit_store';
import type { StageStore } from '../stage/stage_store';
import { keystoneFromGuides, type KeystoneGuide } from './keystone';
import type { GuideKind, KeystoneStore } from './keystone_store';

interface KeystoneHost {
  preview(patch: Partial<EditDoc>): void;
  commit(): void;
  showGeometry(): void;
  closeRepair(): void;
}

export class KeystonePresenter {
  constructor(
    private readonly stage: StageStore,
    private readonly edit: EditStore,
    private readonly store: KeystoneStore,
    private readonly crop: CropPresenter,
    private readonly host: KeystoneHost,
  ) {}

  /**
   * Opens and closes the keystone tool.
   *
   * Closing is what makes the correction take effect on screen, because the stage shows the
   * frame uncorrected while the guides are being drawn on it - the same shape the crop tool has,
   * and for the same reason: you cannot line a guide up with an edge that has already been
   * straightened.
   */
  @action.bound
  setKeystoning(open: boolean): void {
    if (this.store.keystoning === open) return;
    this.store.keystoning = open;
    if (open) {
      this.crop.closeForSibling();
      this.host.closeRepair();
    }
    this.host.showGeometry();
  }

  @action.bound
  closeForSibling(): void {
    this.store.keystoning = false;
  }

  /**
   * The guides, as the overlay holds them: in the frame the reader is looking at.
   *
   * Turned back into the frame's own fractions on the way in, and the correction recomputed from
   * them here rather than anywhere else. **The matrix is derived once, on the writer's side**,
   * so the document carries an answer both renderers read rather than a question each of them
   * answers - which is the difference between a preview and a rendition agreeing by design and
   * agreeing by luck.
   */
  @action.bound
  setGuides(guides: readonly KeystoneGuide[], settle: boolean): void {
    const doc = this.edit.doc;
    if (doc == null) return;
    const stored = guides.map((guide) => {
      const from = turnedPointForDocument({ x: guide.x1, y: guide.y1 }, doc.rotate);
      const to = turnedPointForDocument({ x: guide.x2, y: guide.y2 }, doc.rotate);
      return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    });
    this.host.preview(
      this.crop.fitted({
        keystoneGuides: stored,
        keystone: keystoneFromGuides(stored, { width: this.stage.width, height: this.stage.height }),
      }),
    );
    if (settle) this.host.commit();
  }

  /** Which pair the next line drawn on the picture belongs to. */
  @action.bound
  setGuideKind(kind: GuideKind): void {
    this.store.guideKind = kind;
  }

  /** One guide, by the index the overlay and the panel both name it with. */
  @action.bound
  removeGuide(index: number): void {
    this.setGuides(
      this.store.guides.filter((_, at) => at !== index),
      true,
    );
  }

  /** Takes the correction off, guides and all, which is what a reader means by starting again. */
  @action.bound
  clearKeystone(): void {
    this.host.preview(this.crop.fitted({ keystone: null, keystoneGuides: [] }));
    this.host.commit();
  }
}
