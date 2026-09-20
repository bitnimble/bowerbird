import { action } from 'mobx';
import { type EditDoc } from '../../../../../src/schemas/photo_edits';
import { readSetting, writeSetting } from '../../../app/local_setting';
import {
  aspectCrop,
  aspectDraggedCrop,
  aspectRatioFor,
  type AspectKey,
} from './crop_aspect';
import { insetCrop } from './crop_to_bounds';
import {
  draggedCrop,
  turnedForDocument,
  type CropGrip,
  type CropRect,
} from './crop_turn';
import type { CropStore } from './crop_store';
import type { EditStore } from '../edit/edit_store';
import type { StageStore } from '../stage/stage_store';

const CROP_TO_FIT_KEY = 'bowerbird.edit.cropToFit';

interface CropHost {
  preview(patch: Partial<EditDoc>): void;
  write(patch: Partial<EditDoc>): EditDoc | null;
  settle(patch: Partial<EditDoc>): void;
  commit(): void;
  showGeometry(): void;
  closeKeystone(): void;
  closeRepair(): void;
}

/**
 * The rectangle a fit is taken out of: what the reader framed, or the crop where nothing has
 * been fitted yet.
 *
 * The fallback is what makes an imported sidecar behave. It arrives cropped and with no framing
 * stored, and that rectangle is the reader's own rather than the output of any fit - so
 * levelling its horizon trims the wedges out of it instead of handing back the frame they had
 * already cropped away.
 */
function framedIn(doc: EditDoc): CropRect {
  const { framedLeft, framedTop, framedRight, framedBottom } = doc;
  if (framedLeft == null || framedTop == null || framedRight == null || framedBottom == null) {
    return { left: doc.cropLeft, top: doc.cropTop, right: doc.cropRight, bottom: doc.cropBottom };
  }
  return { left: framedLeft, top: framedTop, right: framedRight, bottom: framedBottom };
}

export class CropPresenter {
  constructor(
    private readonly stage: StageStore,
    private readonly edit: EditStore,
    private readonly store: CropStore,
    private readonly host: CropHost,
  ) {
    // The habit the last session ended on. Read here rather than defaulted in the store,
    // which holds data and does not go and get any.
    store.cropToFit = readSetting(CROP_TO_FIT_KEY) !== '0';
  }

  /**
   * Opens and closes the crop tool.
   *
   * The stage shows the frame uncropped while it is open, so leaving it is what makes the crop
   * take visible effect. Refitting the view to the picture that just changed shape is the
   * stage's, not this: the region follows the view.
   */
  @action.bound
  setCropping(open: boolean): void {
    if (this.store.cropping === open) return;
    this.store.cropping = open;
    // One tool at a time. Both open at once shows the frame with the crop *and* the straighten
    // taken off, which is the keystone's stage - and the crop rectangle laid out on it would
    // then be fractions of a different picture from the one it is being dragged over.
    if (open) {
      this.host.closeKeystone();
      this.host.closeRepair();
    }
    this.host.showGeometry();
  }

  @action.bound
  closeForSibling(): void {
    this.store.cropping = false;
  }

  /**
   * A drag of the rectangle, from where it stood when the gesture began.
   *
   * The overlay says which grip and how far the pointer went as a share of the picture; what
   * that does to four edges is `draggedCrop`, or `aspectDraggedCrop` while the picker holds a
   * ratio. Settling on release writes one history entry for the drag, which is the seam every
   * slider commits on.
   */
  @action.bound
  dragCrop(from: CropRect, grip: CropGrip | null, by: { x: number; y: number }, settle: boolean): void {
    const ratio = aspectRatioFor(this.store.cropLock, this.store.originalAspect);
    this.previewCrop(
      ratio == null ? draggedCrop(from, grip, by) : aspectDraggedCrop(from, grip, by, ratio, this.store.cropFrame),
    );
    if (settle) this.host.commit();
  }

  /** The crop rectangle, as fractions of the straightened frame the tool is showing. */
  @action.bound
  previewCrop(rect: CropRect): void {
    const doc = this.edit.doc;
    if (doc == null) return;
    // Undoing the turn the overlay laid itself out under (`store.cropRect` does the forward
    // half), so the document keeps the fractions in the order Camera Raw defines them.
    const crop = turnedForDocument(rect, doc.rotate);
    // A hand on the rectangle is the only thing that says what the reader wants kept, so it
    // replaces what a later straighten trims out of - and the crop tool draws on the frame
    // uncropped, so what they chose is what they get rather than a fit of it.
    const patch = {
      framedLeft: crop.left,
      framedTop: crop.top,
      framedRight: crop.right,
      framedBottom: crop.bottom,
      cropLeft: crop.left,
      cropTop: crop.top,
      cropRight: crop.right,
      cropBottom: crop.bottom,
    };
    // The open tool draws the frame uncropped, so a redraw per move would be a full GPU tick of
    // an unchanged picture.
    if (this.store.cropping) this.host.write(patch);
    else this.host.preview(patch);
  }

  @action.bound
  settleCrop(rect: CropRect): void {
    this.previewCrop(rect);
    this.host.commit();
  }

  /**
   * The rectangle at one of the picker's ratios, from wherever the reader left it.
   *
   * Settled rather than previewed: a pick is one act with no middle to it, unlike the drag that
   * `previewCrop` serves a move at a time.
   */
  @action.bound
  setCropAspect(key: AspectKey): void {
    const rect = this.store.cropRect;
    const ratio = aspectRatioFor(key, this.store.originalAspect);
    this.store.cropLock = key;
    if (rect == null || ratio == null) return;
    this.settleCrop(aspectCrop(rect, ratio, this.store.cropFrame));
  }

  /** A quarter turn, in the direction the button points. */
  @action.bound
  turn(by: 90 | -90): void {
    const doc = this.edit.doc;
    if (doc == null) return;
    const rotate = (((doc.rotate + by) % 360) + 360) % 360;
    this.host.preview({ rotate: rotate as 0 | 90 | 180 | 270 });
    this.host.commit();
  }

  /**
   * A change of geometry, with the crop moved onto what it leaves showing.
   *
   * A straighten and a perspective correction both leave the picture sitting in its frame as a
   * quadrilateral with wedges of blank around it, and nobody levels a horizon in order to look
   * at those - so the crop becomes the largest rectangle inside the picture, and the whole
   * frame again where the geometry is back to nothing. One patch rather than two writes: two
   * would be two entries in the history and a frame drawn between them showing the wedges.
   *
   * **Never while the crop tool is open**, whatever the toggle says. There the reader is
   * choosing the rectangle by hand, and replacing it under them mid-gesture is the one thing
   * that must not happen.
   */
  @action.bound
  fitted(patch: Partial<EditDoc>): Partial<EditDoc> {
    const doc = this.edit.doc;
    if (doc == null || !this.store.cropToFit || this.store.cropping) return patch;
    const next = { ...doc, ...patch };
    const within = framedIn(next);
    const rect =
      insetCrop({
        width: this.stage.width,
        height: this.stage.height,
        cropAngle: next.cropAngle,
        keystone: next.keystone,
        within,
      }) ?? within;
    return {
      ...patch,
      // Written on every fit, not only the first. The fit is what makes the pair meaningful -
      // before it there is one rectangle and after it two - and writing the input beside the
      // output in the same patch is what keeps them one step in the history rather than two.
      framedLeft: within.left,
      framedTop: within.top,
      framedRight: within.right,
      framedBottom: within.bottom,
      cropLeft: rect.left,
      cropTop: rect.top,
      cropRight: rect.right,
      cropBottom: rect.bottom,
    };
  }

  /**
   * Whether a geometry change takes the crop with it, and the crop caught up on the way in.
   *
   * Remembered across sessions rather than per photograph: it describes how the reader works,
   * not what this frame is. Settled rather than previewed when it turns on, so the trim it
   * performs is one step in the history like any other.
   */
  @action.bound
  setCropToFit(on: boolean): void {
    this.store.cropToFit = on;
    writeSetting(CROP_TO_FIT_KEY, on ? '1' : '0');
    if (on) this.host.settle(this.fitted({}));
  }

  @action.bound
  previewStraighten(degrees: number): void {
    this.store.straightening = true;
    this.host.preview(this.fitted({ cropAngle: Math.round(degrees * 100) / 100 }));
  }

  @action.bound
  settleStraighten(degrees: number): void {
    this.previewStraighten(degrees);
    // The grid is for the gesture, so it goes when the gesture does.
    this.store.straightening = false;
    this.host.commit();
  }
}
