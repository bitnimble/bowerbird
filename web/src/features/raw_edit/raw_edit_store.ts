import { computed, observable } from 'mobx';
import type { EditDoc } from '../../api/client';
import type { Region } from './gpu/tick_pipeline';

export type EditStatus = 'idle' | 'fetching' | 'preparing' | 'live' | 'failed';

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

  /** The adapter behind the tick, for the readout: this is a GPU pipeline now. */
  @observable accessor adapter = '';

  @computed get live(): boolean {
    return this.status === 'live';
  }

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
}
