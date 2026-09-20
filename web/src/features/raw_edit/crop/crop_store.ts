import { computed, observable } from 'mobx';
import { displaySize } from '../../../../../src/schemas/display_size';
import type { EditStore } from '../edit/edit_store';
import { StageStore } from '../stage/stage_store';
import { aspectKeyOf, type AspectKey } from './crop_aspect';
import { turnedForDisplay, type CropRect } from './crop_turn';

export class CropStore {
  constructor(
    private readonly stage: StageStore,
    private readonly edit: EditStore,
  ) {}

  /**
   * Whether the crop tool is open.
   *
   * It changes what the stage *shows*, not just what is drawn over it: a crop is chosen
   * against the picture it is being taken out of, so while the tool is open the frame is
   * straightened and turned but not cropped, and the rectangle is an overlay on that.
   */
  @observable accessor cropping = false;

  /**
   * Whether a change of geometry takes the crop onto what it leaves showing.
   *
   * A straighten and a perspective correction both leave wedges of blank around the picture,
   * and a reader who is levelling a horizon is not levelling it in order to look at those.
   * Off for the reader who wants to choose the rectangle themselves - remembered across
   * sessions, being a habit rather than a property of a photograph.
   */
  @observable accessor cropToFit = true;

  /** Whether the straighten slider is being dragged, which is what the grid is drawn for. */
  @observable accessor straightening = false;

  /**
   * The picture the crop's fractions are of: straightened and turned, but never cropped.
   *
   * Which is what `output` is *while the crop tool is open* and not otherwise, so the ratio
   * picker reads this instead: against the cropped picture a rectangle is a fraction of itself,
   * and every shape it reported would be 1:1.
   */
  @computed.struct get cropFrame(): { width: number; height: number } {
    const doc = this.edit.doc;
    if (doc == null || this.stage.width === 0) return { width: 1, height: 1 };
    return displaySize(this.stage.width, this.stage.height, {
      ...doc,
      cropLeft: 0,
      cropTop: 0,
      cropRight: 1,
      cropBottom: 1,
    });
  }

  /** The photograph's own shape, turned as the stage shows it, which is what "Original" means. */
  @computed get originalAspect(): number {
    const turned = this.edit.doc?.rotate === 90 || this.edit.doc?.rotate === 270;
    const width = turned ? this.stage.height : this.stage.width;
    const height = turned ? this.stage.width : this.stage.height;
    return height === 0 ? 1 : width / height;
  }

  /** The ratio a crop drag is held to, in either orientation, or `custom` for a free drag. */
  @observable accessor cropLock: AspectKey = 'custom';

  /** What the picker shows: the orientation the rectangle is in, of the ratio it is held to. */
  @computed get cropAspect(): AspectKey {
    const rect = this.cropRect;
    if (this.cropLock === 'custom' || rect == null) return 'custom';
    const shape = aspectKeyOf(rect, this.cropFrame, this.originalAspect);
    // A turned "Original" is a shape the list may not have.
    return shape === 'custom' ? this.cropLock : shape;
  }

  /**
   * The crop as fractions of what the stage is showing, for the overlay to lay itself out on.
   *
   * The document's fractions are of the *straightened* frame, which is exactly what the stage
   * shows while the tool is open - so they are the same numbers, and the overlay needs no
   * geometry of its own. The quarter turn is the one thing it has to undo: the fractions are
   * defined before the turn and the picture on screen is after it.
   */
  @computed get cropRect(): CropRect | null {
    const doc = this.edit.doc;
    if (doc == null) return null;
    return turnedForDisplay(
      { left: doc.cropLeft, top: doc.cropTop, right: doc.cropRight, bottom: doc.cropBottom },
      doc.rotate,
    );
  }
}
