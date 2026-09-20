import { computed, observable } from 'mobx';
import type { Repair } from '../../../../../src/schemas/stored_grid';
import type { EditStore } from '../edit/edit_store';
import { KeystoneStore } from '../keystone/keystone_store';

/** A PNG of the stage from under one repair, and that repair's seam as fractions of it. */
export type RepairThumbnail = { url: string; seam: { x: number; y: number }[] };

export class RepairStore {
  constructor(
    private readonly edit: EditStore,
    private readonly keystone: KeystoneStore,
  ) {}

  /** Whether the repair tool is open. The stage is the reader's own either way. */
  @observable accessor repairing = false;

  /**
   * Every repair's seam as the stage draws it, in fractions of the output: the geometry is the
   * module's to apply (`RepairPresenter.follow`), so this is what it answered.
   */
  @observable.ref accessor repairOutlines: { x: number; y: number }[][] = [];

  /**
   * Where the fill on offer is read from, as the stage draws it: its seam moved by its donor, in
   * fractions of the output. Null while nothing is on offer.
   */
  @observable.ref accessor repairSourceOutline: { x: number; y: number }[] | null = null;

  /** Each repair's thumbnail, by its `repairKeys` entry. */
  @observable.ref accessor repairThumbnails: ReadonlyMap<string, RepairThumbnail> = new Map();

  /** What a repair's thumbnail is drawn from: the repair, and the geometry the stage shows it through. */
  @computed get repairKeys(): string[] {
    return (this.edit.doc?.repairs ?? []).map((repair) => JSON.stringify([this.keystone.geometry, repair]));
  }

  /** Whether the stage draws those seams. */
  @observable accessor repairOutlinesShown = true;

  /** Whether a seam may grow past the loop drawn to hide itself, or is the loop exactly. */
  @observable accessor repairGrows = true;

  /**
   * The places the last loop could be filled from, cheapest seam first, while the reader picks
   * one. Null between loops.
   */
  @observable.ref accessor repairOptions: Repair[] | null = null;

  /** Each of those as the stage would show it, by its place among them, once drawn. */
  @observable.ref accessor repairOptionThumbnails: ReadonlyMap<number, RepairThumbnail> = new Map();

  /** Which of those the stage is showing. */
  @observable accessor repairChoice = 0;

  /** Where in the document's repairs the one on offer sits, while there is one. */
  @observable accessor repairShownAt: number | null = null;

  /** Whether a loop is being solved. */
  @observable accessor repairSolving = false;

  /** Why the last loop was offered nothing, until the next one is drawn. */
  @observable accessor repairRefusal: string | null = null;
}
