import { computed, observable } from 'mobx';
import { displaySize } from '../../../../../src/schemas/display_size';
import { type EditDoc } from '../../../../../src/schemas/photo_edits';
import { CropStore } from '../crop/crop_store';
import { turnedPointForDisplay } from '../crop/crop_turn';
import type { EditStore } from '../edit/edit_store';
import { wholeFrameGeometry, type EditGeometry } from '../edits';
import { StageStore } from '../stage/stage_store';
import { isUpright, type KeystoneGuide } from './keystone';

/**
 * Which pair a guide belongs to: the edges that should have been upright, or the ones level.
 *
 * Not stored on the guide. A line's pair *is* its direction - `isUpright` - and a second copy
 * of that on the document would be free to disagree with the line it describes. What the
 * reader chooses is only what they are about to draw.
 */
export type GuideKind = 'vertical' | 'horizontal';

export class KeystoneStore {
  constructor(
    private readonly stage: StageStore,
    private readonly edit: EditStore,
    private readonly crop: CropStore,
  ) {}

  /**
   * Whether the keystone tool is open.
   *
   * Same idea as `cropping` and further: the guides are drawn down edges that are *leaning*, so
   * the stage has to show the frame with the correction taken off - and with the crop and the
   * straighten off too, because a guide runs to the edge of the photograph and the reader has
   * to be able to reach the part of it a crop would have hidden.
   */
  @observable accessor keystoning = false;

  /** Which pair the perspective tool adds next. The pairs are independent, so this is a choice. */
  @observable accessor guideKind: GuideKind = 'vertical';

  /**
   * The geometry the tick should draw with, which is not always the document's.
   *
   * Straightened and turned but uncropped while the tool is open - see `cropping` - and the
   * document's own the rest of the time.
   */
  @computed get geometry(): EditGeometry {
    const doc = this.shownDoc;
    if (doc == null) return wholeFrameGeometry();
    return {
      crop: [doc.cropLeft, doc.cropTop, doc.cropRight, doc.cropBottom],
      angleDegrees: doc.cropAngle,
      rotate: doc.rotate,
      keystone: doc.keystone,
    };
  }

  /**
   * The document as the stage is showing it, which the tools change without changing the edit.
   *
   * Null before a frame has arrived, where there is no picture to have a shape.
   */
  @computed private get shownDoc(): EditDoc | null {
    const doc = this.edit.doc;
    if (this.stage.width === 0 || doc == null) return null;
    const uncropped = { ...doc, cropLeft: 0, cropTop: 0, cropRight: 1, cropBottom: 1 };
    // The keystone tool needs the frame as the camera left it: the guides name what *should*
    // have been parallel, so they are drawn on the lines that are not - and they are fractions
    // of the frame, which the straighten would no longer be true of.
    if (this.keystoning) return { ...uncropped, cropAngle: 0, keystone: null };
    return this.crop.cropping ? uncropped : doc;
  }

  /**
   * The guides as the overlay lays them out, which is the document's turned onto the screen.
   *
   * The document holds them in the frame's own fractions - the frame the correction is defined
   * over - and the stage shows that frame after the quarter turn, so the turn is the whole of
   * the mapping. The same split the crop rectangle has, and for the same reason.
   */
  @computed get guides(): KeystoneGuide[] {
    const doc = this.edit.doc;
    if (doc == null) return [];
    return doc.keystoneGuides.map((guide) => {
      const from = turnedPointForDisplay({ x: guide.x1, y: guide.y1 }, doc.rotate);
      const to = turnedPointForDisplay({ x: guide.x2, y: guide.y2 }, doc.rotate);
      return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    });
  }

  /** The guides split into the two pairs, which is how the tool talks about them. */
  @computed get guidePairs(): Record<GuideKind, { guide: KeystoneGuide; index: number }[]> {
    const pairs: Record<GuideKind, { guide: KeystoneGuide; index: number }[]> = {
      vertical: [],
      horizontal: [],
    };
    this.guides.forEach((guide, index) => {
      pairs[isUpright(guide) ? 'vertical' : 'horizontal'].push({ guide, index });
    });
    return pairs;
  }

  /** Whether the photograph is carrying a correction, which is what the tool's label reads off. */
  @computed get keystoned(): boolean {
    return this.edit.doc?.keystone != null;
  }

  /**
   * What the region is a window on: the picture the geometry above produces.
   *
   * `displaySize` is the server's own function rather than a copy of it, which is what keeps this
   * agreeing with `hdr::cropped_size` - the size the module lays its output grid out at.
   */
  @computed.struct get output(): { width: number; height: number } {
    const doc = this.shownDoc;
    if (doc == null) {
      return { width: Math.max(this.stage.width, 1), height: Math.max(this.stage.height, 1) };
    }
    return displaySize(this.stage.width, this.stage.height, doc);
  }
}
