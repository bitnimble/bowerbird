import { withNewId } from '../../db/constraints';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { PhotoSummary } from '../../schemas/photos';
import type { Stack } from '../../schemas/stacks';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { PhotosRepository } from '../photos/photos_repository';
import { descriptorSize, stackGroups } from '../processing/rawshim_ops';
import type { StackCandidate, StacksRepository } from './stacks_repository';

const log = new Logger('stacks');

/**
 * Splits time-ordered candidates wherever the gap between two of them exceeds
 * the window.
 *
 * A stack only ever grows to a photograph within the window of the one before
 * it, so nothing on one side of a wider gap can join anything on the other. The
 * split therefore changes no grouping at all; it only bounds how much has to be
 * held at once to a single stretch of shooting.
 */
function runs(candidates: readonly StackCandidate[], windowSeconds: number): StackCandidate[][] {
  const split: StackCandidate[][] = [];
  for (const candidate of candidates) {
    const current = split.at(-1);
    const previous = current?.at(-1);
    if (current == null || previous == null || candidate.timestamp - previous.timestamp > windowSeconds) {
      split.push([candidate]);
    } else {
      current.push(candidate);
    }
  }
  return split;
}

/**
 * Photo stacks: the groups themselves, and the detection that proposes them
 * (DESIGN §19).
 *
 * Every method here that a person triggered marks the stack it touched
 * 'manual', which is what takes it out of detection's hands for good. That rule
 * is the whole boundary between "the catalogue's guess" and "what the
 * photographer said", and it is enforced here rather than at the API so a future
 * caller cannot route around it.
 */
export class StacksService {
  constructor(
    private readonly stacks: StacksRepository,
    private readonly photos: PhotosRepository,
    private readonly libraries: LibrariesRepository,
  ) {}

  /**
   * Stores the descriptor a grid tile produced (§19.3).
   *
   * Computed in the worker that rendered the tile, off the pixels it was already
   * holding, so this side neither decodes nor compares anything - it writes a
   * blob. Blobs of the wrong size are refused rather than stored: the comparison
   * reads a fixed stride, and one bad row would be read past.
   */
  storeDescriptor(photoId: string, descriptor: Uint8Array): void {
    if (descriptor.length !== descriptorSize()) {
      log.warn('ignoring a descriptor of the wrong size', { photo: photoId, bytes: descriptor.length });
      return;
    }
    this.stacks.writeDescriptor(photoId, Buffer.from(descriptor));
  }

  get(stackId: string): Stack {
    const stack = this.stacks.get(stackId);
    if (stack == null) throw new AppError('NOT_FOUND', `stack ${stackId} not found`);
    return stack;
  }

  /**
   * A stack's members, newest first.
   *
   * `albumId` filters them to what that album holds, because an album is strict:
   * a member it does not contain is not shown at all. A shoot needs no such
   * argument - every member is returned and each row carries its own `shoot_id`,
   * which is all the client needs to dim the ones that are elsewhere.
   */
  photosOf(stackId: string, options: { albumId?: string; deleted?: boolean } = {}): PhotoSummary[] {
    this.get(stackId);
    const members = this.stacks.memberIds(stackId, options.deleted ?? false);
    const photos = members.map((id) => this.photos.getById(id)).filter((photo) => photo != null);
    const inAlbum =
      options.albumId == null ? photos : photos.filter((photo) => photo.album_ids.includes(options.albumId!));
    return inAlbum.map((photo) => ({ ...photo, stack_size: 1 }));
  }

  /**
   * Makes a stack out of the given photos.
   *
   * Photos already in a stack are moved into the new one, and any stack left
   * with fewer than two members is deleted: a stack of one is a photograph, and
   * leaving it behind would show as a badge claiming a stack that is not there.
   */
  create(requested: readonly string[]): Stack {
    // Counted after resolving, not before. The same id twice, or one naming a
    // photo that is gone, would otherwise pass the length check and produce a
    // stack of one - a badge claiming a stack that is not there, which §19.6
    // says must not exist, and which nothing later prunes because pruning only
    // ever looks at the stacks a create emptied.
    const photoIds = this.stacks.existingPhotoIds([...new Set(requested)]);
    if (photoIds.length < 2) throw new AppError('VALIDATION_ERROR', 'a stack needs at least two photos');
    const libraryId = this.stacks.soleLibraryOf(photoIds);
    // A stack is library-wide but not library-crossing: its members share a
    // catalogue, and nothing in the grid could show a stack that spans two.
    if (libraryId == null) throw new AppError('VALIDATION_ERROR', 'a stack cannot span libraries');

    const id = this.stacks.transaction(() => {
      const emptied = this.stacks.stackIdsOf(photoIds);
      const stackId = withNewId((candidate) => this.stacks.create(candidate, libraryId, 'manual', new Date().toISOString()));
      this.stacks.addPhotos(stackId, photoIds);
      this.pruneStacks(emptied);
      return stackId;
    });
    log.info('created a stack', { stack: id, photos: photoIds.length });
    return this.get(id);
  }

  /** Drops every photo out of a stack and deletes it. */
  unstack(stackId: string): void {
    this.get(stackId);
    this.stacks.transaction(() => this.stacks.dissolve(stackId, true));
    log.info('unstacked', { stack: stackId });
  }

  /**
   * Takes photos out of a stack, leaving the stack for whatever remains.
   *
   * The stack becomes 'manual' rather than staying detection's: a person has
   * said these photographs do not belong together, and a later pass that put
   * them back would be overruling them.
   */
  removePhotos(stackId: string, photoIds: readonly string[]): void {
    this.get(stackId);
    this.stacks.transaction(() => {
      // Marked manual only if a photograph actually left. A request naming ids
      // this stack does not hold - a stale client, a double submit - would
      // otherwise freeze an automatic stack out of detection's reach for good
      // without changing anything the user can see.
      if (this.stacks.removePhotos(stackId, photoIds, true) === 0) return;
      this.stacks.markManual(stackId);
      this.pruneStacks([stackId], true);
    });
    log.info('removed photos from a stack', { stack: stackId, photos: photoIds.length });
  }

  /**
   * Re-forms this library's automatic stacks from every candidate it has.
   *
   * Rewrites them wholesale rather than adding to them, which is what makes the
   * similarity setting mean something after it changes: raise it and stacks
   * split, lower it and they merge. Manual stacks and photos somebody pulled out
   * are not candidates, so neither is touched (§19.4.2).
   *
   * Returns how many stacks the library now has by detection.
   */
  detect(libraryId: string): number {
    const library = this.libraries.getById(libraryId);
    if (library == null) throw new AppError('NOT_FOUND', `library ${libraryId} not found`);
    if (!library.auto_stack) return 0;

    const candidates = this.stacks.candidates(libraryId);
    if (candidates.length === 0) return 0;

    // Walked one run at a time, where a run ends at a gap wider than the window.
    //
    // The rule only ever joins a photo to the one before it when the two are
    // within the window (§19.4.3), so photographs either side of a wider gap can
    // never share a stack: splitting there is exact rather than an
    // approximation. What it buys is memory. A descriptor is 2.6 kB, so holding
    // a whole library's worth to compare frames that are hours apart is hundreds
    // of megabytes to answer a question already settled by their timestamps.
    const size = descriptorSize();
    const members: string[][] = [];
    for (const run of runs(candidates, library.auto_stack_window_seconds)) {
      if (run.length < 2) continue;
      const descriptors = this.stacks.descriptorsOf(
        run.map((candidate) => candidate.id),
        size,
      );
      // Photos whose descriptor did not come back usable drop out of the run
      // here, so the ids, the timestamps and the descriptors stay one list of
      // the same length - which is what the grouping call is trusting.
      const usable = run.filter((candidate) => descriptors.has(candidate.id));
      if (usable.length < 2) continue;
      const groups = stackGroups(
        usable.map((candidate) => descriptors.get(candidate.id)!),
        BigInt64Array.from(usable.map((candidate) => BigInt(candidate.timestamp))),
        library.auto_stack_similarity,
        library.auto_stack_window_seconds,
      );
      const byGroup = new Map<number, string[]>();
      for (const [index, group] of groups.entries()) {
        if (group < 0) continue;
        const existing = byGroup.get(group);
        if (existing == null) byGroup.set(group, [usable[index]!.id]);
        else existing.push(usable[index]!.id);
      }
      members.push(...byGroup.values());
    }

    this.stacks.transaction(() => {
      // The old automatic stacks go first, and their photos go back to 'none'
      // rather than 'unstacked': this pass is detection changing its own mind,
      // not a person rejecting the grouping, so the photos must stay available
      // to the grouping being written a line later.
      for (const stackId of this.stacks.autoStackIds(libraryId)) this.stacks.dissolve(stackId, false);
      const now = new Date().toISOString();
      for (const photoIds of members) {
        const id = withNewId((candidate) => this.stacks.create(candidate, libraryId, 'auto', now));
        this.stacks.addPhotos(id, photoIds);
      }
    });

    log.info('detected stacks', { library: libraryId, stacks: members.length, candidates: candidates.length });
    return members.length;
  }

  /**
   * Deletes any of these stacks that no longer holds two photographs.
   *
   * `released` says whether the photograph left behind was released by a person.
   * It matters: after a remove, the last survivor is there because somebody took
   * the others out, so leaving it as 'none' would let detection put the stack
   * straight back - the same situation an unstack marks 'unstacked'. A stack
   * merely emptied by a create is detection's business again.
   */
  private pruneStacks(stackIds: readonly string[], released = false): void {
    for (const stackId of stackIds) {
      if (this.stacks.get(stackId) == null) continue;
      if (this.stacks.countMembers(stackId) < 2) {
        this.stacks.dissolve(stackId, released);
        continue;
      }
      // A stack that survives losing members may have lost the one standing for
      // it. Only the *new* stack is refreshed by `addPhotos`, so without this a
      // source stack keeps a hole and every listing pays the correlated-subquery
      // arm for it from then on.
      this.stacks.refreshRepresentative(stackId);
    }
  }
}
