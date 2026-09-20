import { computed, observable } from 'mobx';
import { CropStore } from '../crop/crop_store';
import type { EditTool } from '../edit_tool';
import { KeystoneStore } from '../keystone/keystone_store';
import { RepairStore } from '../repair/repair_store';

/** The loupe's side, in CSS pixels. Square, and the same square wherever it is held. */
export const LOUPE_SIZE = 400;

/** Where the magnification starts, and the ends the wheel is held between. */
export const LOUPE_DEFAULT_MAGNIFICATION = 2;
export const LOUPE_MIN_MAGNIFICATION = 1;
export const LOUPE_MAX_MAGNIFICATION = 16;

export class LoupeStore {
  constructor(
    private readonly crop: CropStore,
    private readonly keystone: KeystoneStore,
    private readonly repair: RepairStore,
  ) {}

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

  /**
   * Whether what the glass is showing is the export's pixels rather than the tick's own render.
   *
   * What it answers is "has the glass sharpened yet", which is the only part of the loupe a
   * reader or a test can ask about from outside the canvas.
   */
  @observable accessor loupeSharp = false;

  /**
   * The stage's CSS box, as the component last measured it.
   *
   * Held so a tile arriving can be drawn without one: the fetch answers on its own schedule,
   * long after the pointer move that asked for it, and nothing may read layout there.
   */
  @observable.ref accessor loupeBox = { width: 0, height: 0 };

  /** Whether a rendition tile is on its way, which the glass says beside its magnification. */
  @observable accessor loupeRendering = false;

  @computed get tool(): EditTool {
    if (this.crop.cropping) return 'crop';
    if (this.keystone.keystoning) return 'perspective';
    if (this.repair.repairing) return 'repair';
    return this.loupeOpen ? 'loupe' : 'cursor';
  }
}
