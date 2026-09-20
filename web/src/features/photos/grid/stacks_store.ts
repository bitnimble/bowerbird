import { observable } from 'mobx';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import type { Expansion } from './bands';

/**
 * The frames a merge in flight is about.
 *
 * How far it has got is not here: the bar is the toast's, so it moves several times a second where
 * this is written twice - and a tile that observed the fraction would re-render for every strip.
 */
export interface MergingRows {
  positions: Set<number>;
  photoIds: Set<string>;
}

export class StacksStore {
  // The stacks the reader has expanded, keyed by stack id (§19.6).
  //
  // Keyed by the stack rather than by the position it was opened at, because the
  // position is a coordinate that a re-order or an import moves: a band survives
  // those and has its position recomputed, rather than being closed because the
  // collection changed underneath it.
  @observable accessor expansions = new Map<string, Expansion>();
  // What each stack holds, by stack id, however it came to be known - a band the reader opened, or
  // a stack they selected without opening.
  //
  // Separate from `expansions`, which is about what is *drawn*: a band closes when the reader is
  // done looking at it, and `selectedLoadedPhotos` still has to say what a selected stack tile
  // stands for. Nothing here affects the listing, so it is kept rather than pruned with the band.
  @observable accessor stackMembers = new Map<string, PhotoSummary[]>();
  // Where an open stack's tile sits on its masonry line, by stack id: the offset and
  // width its band cuts the gap in its top edge from, and the height its band caps
  // its own rows against (§19.6).
  //
  // Measured, and the only geometry in the grid that is. A masonry line grows its
  // tiles from their own shapes *or* hands the slack to a spacer depending on what
  // follows the line, so where a tile ended up on one is not arithmetic the way a
  // column is - the same reason a masonry block's height is measured rather than
  // computed (§18.3.2). One tile per open stack, and only while it is open.
  @observable accessor stackTileBoxes = new Map<string, { x: number; width: number; height: number }>();
  /**
   * The rows the merge running right now is about, or null.
   *
   * The positions are this client's own - the rows it asked to merge, marked from the moment it
   * asked - where the ids come from the server, which is what lets a second view watching the
   * same library mark them too. A row is waiting if either names it.
   */
  @observable.ref accessor mergingRows: MergingRows | null = null;

  /** Whether this row is one of the frames a merge is working through. */
  waitingOnMerge(position: number, photoId: string): boolean {
    const merging = this.mergingRows;
    return merging != null && (merging.positions.has(position) || merging.photoIds.has(photoId));
  }

  /**
   * A photo held only as a member of an open band.
   *
   * A collapsed listing has no row for a stack's members (§19.5.1), so without
   * this every control that starts by locating the photo - rating, the triage
   * verdicts - silently does nothing on a band tile while appearing to work.
   */
  memberById(photoId: string): PhotoSummary | null {
    for (const open of this.expansions.values()) {
      const found = open.photos.find((photo) => photo.id === photoId);
      if (found != null) return found;
    }
    return null;
  }

  /** The open band a photograph is a member of, if the reader has one open. */
  bandOf(photo: PhotoSummary): Expansion | null {
    return photo.stack_id == null ? null : (this.expansions.get(photo.stack_id) ?? null);
  }

  expansionAt(position: number): Expansion | null {
    for (const open of this.expansions.values()) {
      if (open.position === position) return open;
    }
    return null;
  }
}
