import { computed, observable } from 'mobx';
import { type EditDoc } from '../../../../../src/schemas/photo_edits';
import type { AsShot } from '../../../../../src/schemas/prepared';

/** Whether a save is in flight, and whether the last one was refused. */
export type SaveStatus = 'clean' | 'saving' | 'conflict' | 'failed';

export class EditStore {
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
   * The illuminant the camera balanced this frame for, off the prepared header.
   *
   * Null until the frame is open, and null after it for a file whose camera recorded no
   * usable multipliers - there being no baseline, a temperature would be a balance away from
   * nothing, and the pair stays closed.
   */
  @observable accessor asShot: AsShot | null = null;

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
