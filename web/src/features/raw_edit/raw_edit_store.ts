import { computed, observable } from 'mobx';
import type { EditDoc } from '../../api/client';
import { displaySize } from '../../../../src/schemas/display_size';
import { turnedForDisplay, turnedPointForDisplay, type CropRect } from './crop_turn';
import { isUpright, type KeystoneGuide } from './keystone';
import { wholeFrameGeometry, type EditGeometry } from './gpu/shaders';
import type { AsShot, Region } from './gpu/edit_pipeline';

export type EditStatus = 'idle' | 'fetching' | 'preparing' | 'live' | 'failed';

/**
 * Which of the stage's modes the pointer is in.
 *
 * One value rather than the two booleans below it because that is what the header's selector
 * is: a one-of-N, where "neither" is a choice a reader makes rather than a state they fall into.
 */
export type EditTool = 'cursor' | 'crop' | 'perspective' | 'loupe';

/** The loupe's side, in CSS pixels. Square, and the same square wherever it is held. */
export const LOUPE_SIZE = 400;

/** Where the magnification starts, and the ends the wheel is held between. */
export const LOUPE_DEFAULT_MAGNIFICATION = 2;
export const LOUPE_MIN_MAGNIFICATION = 1;
export const LOUPE_MAX_MAGNIFICATION = 16;

/**
 * Which pair a guide belongs to: the edges that should have been upright, or the ones level.
 *
 * Not stored on the guide. A line's pair *is* its direction - `isUpright` - and a second copy
 * of that on the document would be free to disagree with the line it describes. What the
 * reader chooses is only what they are about to draw.
 */
export type GuideKind = 'vertical' | 'horizontal';

/** Whether a save is in flight, and whether the last one was refused. */
export type SaveStatus = 'clean' | 'saving' | 'conflict' | 'failed';

// Observables and computeds only. Every mutation is on RawEditPresenter.
export class RawEditStore {
  @observable accessor status: EditStatus = 'idle';
  /** Why, where the status alone does not say - a fetch failure, or what is in flight. */
  @observable accessor message = '';

  @observable accessor width = 0;
  @observable accessor height = 0;

  /**
   * The develop settings as the server last agreed them, with local moves laid on top.
   *
   * Null until the open has read them. Not built here from a default: the server
   * answers for an unedited photo too, with the neutral document, so the client
   * never has to know what neutral is - which is what keeps `web` importing only
   * *types* from the server's schemas rather than pulling zod's runtime across.
   */
  @observable accessor doc: EditDoc | null = null;

  /**
   * The revision the next write must carry.
   *
   * Held because the server refuses a write that names a stale one: without it two
   * tabs do not merely lose an edit, the server diffs a stale document and records
   * a change nobody made.
   */
  @observable accessor rev = 0;

  @observable accessor canUndo = false;
  @observable accessor canRedo = false;
  @observable accessor saveStatus: SaveStatus = 'clean';

  /**
   * The part of the frame on screen, in source pixels. Null until the frame is open.
   *
   * Where zoom and pan live: the draw runs at canvas resolution over this rectangle, so
   * moving it is the whole of navigating a photograph, and nothing else has to change.
   */
  @observable accessor region: Region | null = null;

  /** Whether the camera's own colour is in play, or the grade fell back to neutral. */
  @observable accessor matched = false;

  /**
   * The illuminant the camera balanced this frame for, off the prepared header.
   *
   * Null until the frame is open, and null after it for a file whose camera recorded no
   * usable multipliers - there being no baseline, a temperature would be a balance away from
   * nothing, and the pair stays closed.
   */
  @observable accessor asShot: AsShot | null = null;

  /** The adapter behind the tick, for the readout: this is a GPU pipeline now. */
  @observable accessor adapter = '';

  @computed get live(): boolean {
    return this.status === 'live';
  }

  /**
   * Whether the crop tool is open.
   *
   * It changes what the stage *shows*, not just what is drawn over it: a crop is chosen
   * against the picture it is being taken out of, so while the tool is open the frame is
   * straightened and turned but not cropped, and the rectangle is an overlay on that.
   */
  @observable accessor cropping = false;

  /**
   * Whether the keystone tool is open.
   *
   * Same idea as `cropping` and further: the guides are drawn down edges that are *leaning*, so
   * the stage has to show the frame with the correction taken off - and with the crop and the
   * straighten off too, because a guide runs to the edge of the photograph and the reader has
   * to be able to reach the part of it a crop would have hidden.
   */
  @observable accessor keystoning = false;

  /**
   * Whether the loupe is the pointer's job.
   *
   * A mode rather than a modifier held down, because pixel-peeping is what a reader is *doing*
   * for a while - judging a denoise, a sharpen or a focus across several parts of one frame -
   * and a key held through all of that is a key held for a minute.
   */
  @observable accessor loupeOpen = false;

  /**
   * Where the loupe is centred, in the stage's own CSS pixels, or null while the pointer is
   * off the picture.
   *
   * Screen space and not source pixels: what the reader is pointing at is a place on the
   * *stage*, and turning that into a region needs the view, which the component holds.
   */
  @observable accessor loupeAt: { x: number; y: number } | null = null;

  /**
   * Source pixels per loupe pixel, so 1 is 1:1 and 4 is four times life size.
   *
   * Absolute rather than relative to the view, because the question a loupe answers is about
   * the photograph's own pixels - "is this sharp", "is that grain or detail" - and an answer
   * that moved with how far the reader happened to be zoomed out would not be one.
   */
  @observable accessor loupeMagnification = LOUPE_DEFAULT_MAGNIFICATION;

  @computed get tool(): EditTool {
    if (this.cropping) return 'crop';
    if (this.keystoning) return 'perspective';
    return this.loupeOpen ? 'loupe' : 'cursor';
  }

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

  /** Which pair the perspective tool adds next. The pairs are independent, so this is a choice. */
  @observable accessor guideKind: GuideKind = 'vertical';

  /**
   * The exposure the tick draws at, in EV.
   *
   * Derived rather than stored beside the document. Holding both is two
   * representations of one value, and any path that moved one without the other
   * would draw a picture that disagrees with what a save would send.
   */
  @computed get exposureEv(): number {
    return this.doc?.exposure ?? 0;
  }

  /**
   * The geometry the tick should draw with, which is not always the document's.
   *
   * Straightened and turned but uncropped while the tool is open - see `cropping` - and the
   * document's own the rest of the time. Built through `displaySize`, the server's function,
   * so the editor and the rendition agree on the shape without a second implementation.
   */
  @computed get geometry(): EditGeometry {
    const doc = this.doc;
    if (this.width === 0 || doc == null) return wholeFrameGeometry(Math.max(this.width, 1), Math.max(this.height, 1));
    const uncropped = { ...doc, cropLeft: 0, cropTop: 0, cropRight: 1, cropBottom: 1 };
    // The keystone tool needs the frame as the camera left it: the guides name what *should*
    // have been parallel, so they are drawn on the lines that are not - and they are fractions
    // of the frame, which the straighten would no longer be true of.
    const shown: EditDoc = this.keystoning
      ? { ...uncropped, cropAngle: 0, keystone: null }
      : this.cropping
        ? uncropped
        : doc;
    return {
      cropLeft: shown.cropLeft,
      cropTop: shown.cropTop,
      cropRight: shown.cropRight,
      cropBottom: shown.cropBottom,
      cropAngle: shown.cropAngle,
      rotate: shown.rotate,
      output: displaySize(this.width, this.height, shown),
      keystone: shown.keystone,
    };
  }

  /**
   * The guides as the overlay lays them out, which is the document's turned onto the screen.
   *
   * The document holds them in the frame's own fractions - the frame the correction is defined
   * over - and the stage shows that frame after the quarter turn, so the turn is the whole of
   * the mapping. The same split the crop rectangle has, and for the same reason.
   */
  @computed get guides(): KeystoneGuide[] {
    const doc = this.doc;
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
    return this.doc?.keystone != null;
  }

  /** What the region is a window on: the picture the geometry above produces. */
  @computed get output(): { width: number; height: number } {
    return this.geometry.output;
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
    const doc = this.doc;
    if (doc == null) return null;
    return turnedForDisplay(
      { left: doc.cropLeft, top: doc.cropTop, right: doc.cropRight, bottom: doc.cropBottom },
      doc.rotate,
    );
  }

  /**
   * Where the two white balance sliders sit, which is not the same as what the document holds.
   *
   * The document stores null for "as shot" and has to - the same edit pasted onto a photo
   * metered under tungsten must mean that photo's own neutral, not this one's. A slider cannot
   * show null, so it shows the frame's own illuminant until the reader moves it, and the first
   * move is what turns the pair into stored numbers.
   */
  @computed get balance(): AsShot | null {
    const neutral = this.asShotBalance;
    if (neutral == null) return null;
    return {
      temperature: this.doc?.temperature ?? neutral.temperature,
      tint: this.doc?.tint ?? neutral.tint,
    };
  }

  /**
   * Where the pair stands when nobody has moved it, which is what both sliders snap back to.
   *
   * Rounded, because the camera's illuminant is solved rather than chosen and comes back at
   * 5487.3K. Only for the panel and for what a first move stores: the *tick* is told the
   * header's own unrounded pair, so a photo nobody has balanced is graded at exactly the
   * illuminant it was shot under rather than a fifth of a Kelvin off it.
   */
  @computed get asShotBalance(): AsShot | null {
    const asShot = this.asShot;
    if (asShot == null) return null;
    return { temperature: Math.round(asShot.temperature), tint: Math.round(asShot.tint) };
  }
}
