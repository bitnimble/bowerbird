import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import { recipeOf } from '../../schemas/recipes';
import { parkDivergentEdits, parseChain } from '../photo_edits/edit_sessions';
import { StacksRepository } from '../stacks/stacks_repository';
import { entityOf, type ReplicatedEntity, type ReplicatedKind } from './entities';
import { queueMaterialisation, recipePathToTouch } from './materialise';
import { observeStamp, stamp as stampFor } from './stamps';
import type { Cell, Change, LiveChange, Tombstone } from '../../schemas/replication';
import { keyPartsOf, parseable, whereKey, whereSidecar } from './stream';
import { forgetCascade, shootsBelow, tombstone, unbury } from './tombstones';

// Merging what arrived into what is here (docs/replication.md §5).
//
// Every rule reduces to one comparison: the newer stamp wins, per unit. What
// makes that safe rather than merely simple is that it is applied to a *unit* -
// the set of columns a photographer changes together - so a verdict made here and
// a move made there both survive, and neither takes the other's columns with it.

// Parents before children, so a photograph is here before the membership that
// names it. Pages arrive in stamp order, which respects causality on the peer
// that wrote them but says nothing about a receiver that holds only some of it.
// Every kind, and the compiler says so: a `Record` keyed by the union means a kind
// added to `REPLICATED_ENTITIES` and forgotten here will not build. Left off a
// list, it sorted at `indexOf` -1 - ahead of `library`, ahead of everything - and
// the first such kind with a parent would have deferred every session, for ever,
// with nothing to see. `folder_rule` and `blob_location` were both off it.
const ORDER: Record<ReplicatedKind, number> = {
  library: 0,
  shoot: 1,
  folder_rule: 2,
  photo: 3,
  stack: 4,
  stack_member: 5,
  shoot_banner: 6,
  photo_edits: 7,
  edit_conflict: 8,
  blob_location: 9,
};

const log = new Logger('replication');

/**
 * Applies one page's changes. The caller owns the transaction.
 *
 * @returns the stamps it could not apply, which is how a session knows not to
 * claim them. A change whose parent this peer has deleted cannot be written -
 * SQLite refuses the reference and it would be wrong to invent one - but it must
 * not be forgotten either: claiming coverage of a change that was dropped is how
 * a row goes missing between two peers that both think they are in step. Left
 * unclaimed, it simply arrives again next time, by which point the deletion has
 * usually reached the sender and it stops being sent at all.
 */
export function applyChanges(db: Database, libraryId: string, changes: readonly Change[]): Applied {
  const ordered = [...changes].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const deferred: string[] = [];
  const taken: Change[] = [];
  for (const change of ordered) {
    const entity = entityOf(change.kind);
    try {
      // Claimed and dropped, which §5.1 forbids for anything this peer could have
      // taken - and this is the one thing it could not. An id that will not come
      // apart names no row, on any peer, ever; left unclaimed it arrives again every
      // session and refuses the page it arrives in, which is that library not
      // replicating in either direction for good.
      if (!parseable(entity, change.rowId)) {
        log.warn('dropping a change whose row id cannot be read', { entity: change.kind, row: change.rowId });
        continue;
      }
      if (!belongsHere(db, libraryId, entity, change)) {
        // A row of another library, from a peer paired for this one. Left
        // unclaimed rather than applied or skipped: nothing here can write it, and
        // claiming coverage of it would say this peer had taken something it
        // refused.
        deferred.push(...unclaimed(change));
        continue;
      }
      if (change.deleted) applyTombstone(db, libraryId, entity, change);
      else applyRow(db, libraryId, entity, change);
      taken.push(change);
    } catch (error) {
      if (!isMissingReference(error)) throw error;
      deferred.push(...unclaimed(change));
    }
  }
  return { deferred, taken };
}

/**
 * What one page's apply did: the stamps it could not take, and the changes it did.
 *
 * The two are separate answers because a stamp is not a change. One action mints
 * one stamp for as many rows as it touched - a binning of four hundred
 * photographs is one thing the photographer did - so asking "was this change
 * taken" by looking its stamp up among the deferred ones answers for every other
 * row that action touched as well.
 */
export interface Applied {
  deferred: string[];
  taken: readonly Change[];
}

/**
 * The photographs among these changes whose copies may be owed again: an arriving document, or an
 * arriving row, whose recipe a composite's copies are built from. A shortlist for
 * `queueEditedSince` to ask about, not a claim about any of them.
 */
export function rebuildCandidates(taken: readonly Change[]): string[] {
  return taken.filter((change) => change.kind === 'photo_edits' || change.kind === 'photo').map((change) => change.rowId);
}

/**
 * Every stamp a change carries that this peer has now not applied.
 *
 * A row's units are written by whoever edited them, so one change routinely
 * carries stamps from several origins - and `change.stamp` is the *newest* of
 * them, which is a different question from "which origins does this leave
 * uncovered". Held back on that one alone, a deferral caps an origin that had
 * nothing to do with the part that failed, while the origin whose unit is missing
 * is claimed in full and never sends it again: the photograph's placement lost for
 * good, from a rating somebody else made later. The self case is the sharpest,
 * since a vector never takes a remote's word about this peer's own origin, so the
 * cap is discarded outright.
 */
function unclaimed(change: Change): string[] {
  // A grave says one thing and a live row says one per unit, and the shape of the
  // change is which. There is nothing else on it to hold back against by mistake.
  return change.deleted ? [change.stamp] : Object.values(change.stamps);
}

/**
 * Dissolves the stacks that removals have left with nothing to be a stack of (§5.2).
 *
 * **At the close of a session, never inside one.** By here this peer holds
 * everything the sender had, so a stack of one is a stack of one - whereas a page
 * is a slice of the sender's log in stamp order, and the removal that empties a
 * stack routinely arrives pages before the additions that keep it whole. Asked
 * mid-session, a peer dissolves a stack whose other members are still coming, then
 * refuses them when they land, while the peer that had them all along dissolves
 * nothing: the two never agree again. That is what two earlier attempts at this
 * rule got wrong.
 *
 * Only stacks a membership has actually *left*, which the graves say: a stack that
 * is small because nobody has sent its members yet has none. What this writes is an
 * ordinary tombstone under this peer's own origin, which is what carries it to the
 * peer whose removal was the other half of the story - and why two peers that each
 * took a different member out of one stack both end up agreeing it has ended.
 */
export function dissolveEmptiedStacks(db: Database, libraryId: string): void {
  const spent = db
    .query(
      `SELECT s.id FROM stacks s
        WHERE s.library_id = ?
          AND (SELECT COUNT(*) FROM stack_members m WHERE m.stack_id = s.id) < 2
          AND EXISTS (SELECT 1 FROM replication_log l
                       WHERE l.library_id = s.library_id AND l.entity = 'stack_member'
                         AND l.deleted = 1 AND l.row_id LIKE s.id || '/%')
        ORDER BY s.id`,
    )
    .all(libraryId) as { id: string }[];
  if (spent.length === 0) return;
  const stacks = new StacksRepository(db);
  for (const stack of spent) stacks.dissolveIfSpent(stack.id, false);
}


/**
 * Whether a change is about the library this session is replicating.
 *
 * Most tables carry `library_id` and every query here is scoped by it, so the
 * question answers itself. The four that do not - the library row, a shoot's
 * banner, a photograph's edits and its parked candidates - have to ask their
 * parent, or a peer paired for one library could write into another one held on
 * the same server (§11.2).
 *
 * A parent that is simply not here yet is not a refusal: that is the ordinary
 * out-of-order case the foreign key already defers.
 */
function belongsHere(db: Database, libraryId: string, entity: ReplicatedEntity, change: Change): boolean {
  if (entity.kind === 'library') return change.rowId === libraryId;
  if (entity.libraryVia == null) return true;
  const parent = change.rowId.split('/')[0] ?? '';
  const row = db.query(entity.libraryVia).get(parent) as { library_id: string } | null;
  return row == null || row.library_id === libraryId;
}

/** A change this peer cannot take yet, to be left unclaimed and heard again. */
class Deferred extends Error {}

/**
 * Which of two shoots renamed onto one folder loses it: **the one renamed later.**
 *
 * `shoots` is unique on `(library_id, folder_path)`, and two peers each renaming a different folder to
 * the same name while apart is a state no peer can hold. The earlier rename is the one that already
 * stood when the later was made, so it keeps the folder.
 *
 * Both peers reach the same verdict because both compare the same pair of stamps - the arriving shoot's
 * against the one on the row already sitting on the folder. Which side of the comparison each peer is
 * on differs; the answer does not.
 *
 * Answers `null` where the collision is not this one at all - another unique index, a shoot whose
 * payload carries no folder to contest, or a folder that turns out to be free - leaving it to be held
 * back and heard again rather than settled by a rule that does not fit it.
 */
function keepsTheFolder(
  db: Database,
  libraryId: string,
  entity: ReplicatedEntity,
  change: LiveChange,
): FolderVerdict | null {
  if (entity.kind !== 'shoot') return null;
  const wanted = change.row['folder_path'];
  const arriving = change.stamps['shoot.folder'];
  if (typeof wanted !== 'string' || arriving == null) return null;
  const holder = db
    .query('SELECT id, stamp_folder AS stamp FROM shoots WHERE library_id = ? AND folder_path = ? AND id <> ?')
    .get(libraryId, wanted, change.rowId) as { id: string; stamp: string | null } | null;
  if (holder == null) return null;
  // A shoot inserted from a payload that carried no `shoot` unit takes its folder from the identity
  // columns and leaves the stamp NULL. No peer has been told where it sits, so it has the weaker claim
  // of the two rather than an unrankable one, and it is the one that moves.
  if (holder.stamp == null) return { kind: 'holder', by: holder.id };
  if (holder.stamp < arriving) return { kind: 'arriving', by: holder.id };
  if (holder.stamp > arriving) return { kind: 'holder', by: holder.id };
  // **Exactly equal, which one action touching two shoots really does produce:** `relocate` stamps a
  // shoot and its whole subtree with a single value, so two rows here can carry the same one. The id
  // breaks it, being the only thing left that both peers read the same way - and a tie broken
  // differently on each side is two peers each keeping their own rename for ever.
  return { kind: holder.id < change.rowId ? 'arriving' : 'holder', by: holder.id };
}

/** Which of the two renames loses: the arriving one, or the one already sitting on the folder. */
type FolderVerdict = { kind: 'arriving' | 'holder'; by: string };

/**
 * The first of `wanted_2`, `wanted_3` … that no other shoot of this library holds.
 *
 * Where a rename that lost its folder settles when it has nowhere to go back to: the peer that could
 * say where it came from is the other one, and waiting for it is a stall that may never clear. A
 * suffix rather than anything derived from the id, because this is a folder name a person reads - and
 * the scan relocates a shoot by inode regardless (§9.4.1), so the name only has to be free and stable.
 *
 * **Never `wanted` itself**, counted from 2 rather than checking it first: `wanted` is the contested
 * folder, which the loser is being moved *off*, and the winner is about to take it. Excluding the row
 * being moved from the search - it is the one sitting on `wanted` - would otherwise hand it straight
 * back.
 *
 * `except` is that row, so a name it already holds under a suffix is not read as occupied either.
 */
function freeFolder(db: Database, libraryId: string, wanted: string, except: string): string {
  for (let n = 2; ; n++) {
    const candidate = `${wanted}_${n}`;
    const taken = db
      .query('SELECT 1 FROM shoots WHERE library_id = ? AND folder_path = ? AND id <> ?')
      .get(libraryId, candidate, except);
    // Unbounded in principle, a handful in practice: it takes one contested rename per suffix already
    // spent, and each one settled advances the name for whatever comes next.
    if (taken == null) return candidate;
  }
}

/**
 * A write refused because another row here already holds the value, as opposed to one refused for
 * being wrong.
 *
 * Narrow on purpose, and read at the one write that can meet it rather than folded into
 * `isMissingReference`: a unique index is also how this catalogue states invariants it wants to hear
 * about loudly - `idx_photos_one_representative` is the sharp one - and a blanket "unique failures are
 * deferrals" would turn the next one of those into a page quietly arriving again for ever.
 */
function isUniqueCollision(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

function isMissingReference(error: unknown): boolean {
  return (
    error instanceof Deferred || (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed'))
  );
}

/**
 * A reference this peer cannot honour, resolved the way its own deletion would
 * have.
 *
 * `photos.shoot_id` is nullable and set to NULL when its shoot is deleted, so a
 * photograph arriving assigned to a shoot this peer has *buried* belongs in no
 * shoot - which is exactly what this peer's own copy of that deletion did to
 * every other photograph in it. Every peer computes the same answer from the same
 * grave, so nothing about it needs to travel.
 */
function resolve(db: Database, libraryId: string, entity: ReplicatedEntity, column: string, value: Cell): Cell {
  // A lineage chain is stored as it arrives and relayed onward from there, so a
  // cap applied when reading one bounds this peer's own work and nothing else:
  // the overlong column is still written here and still handed to everyone else,
  // for good. Cut on the way in, which is the only side that binds (§11.2). Both
  // the insert and the update path come through here.
  if (column === 'chain' && typeof value === 'string') return JSON.stringify(parseChain(value));
  if (entity.kind !== 'photo' || column !== 'shoot_id' || value == null) return value;
  // Scoped, because the foreign key is not: a shoot of *another* library on this
  // server satisfies both, and a photograph written into it is this session
  // reaching outside the library it was paired for (§11.2).
  if (db.query('SELECT 1 FROM shoots WHERE id = ? AND library_id = ?').get(value as string, libraryId) != null) {
    return value;
  }
  // The grave, not the absence. A page is 500 rows in stamp order and only the
  // page is sorted parents-first, so a shoot written after its photographs were
  // placed - a rename, a description, a re-parent - is a later page than they are,
  // and reading "not here yet" as "deleted" strips the membership of every
  // photograph in it *permanently*: the write succeeds, so the stamp is claimed
  // and the shoot arriving a page later has nothing left to attach. Handed back
  // untouched, the foreign key refuses it and the change is deferred (see
  // `applyChanges`), which is what the deferral is for.
  return graveOf(db, libraryId, 'shoot', value as string) != null ? null : value;
}

/**
 * A deletion, against whatever this peer has since done to the row.
 *
 * **Only a stack comes back from one.** Dissolving a stack is a statement about
 * the stack alone, and a membership added later says the more recent thing, so
 * newest-wins applies as it does everywhere else.
 *
 * A photograph and a shoot are different, and it took a permanent divergence to
 * see why. Neither is ever hard-deleted on its own: the one path that removes
 * those rows is a folder leaving the library, which writes the folder's rule in
 * the same transaction. So a later write from a peer that had not heard yet is
 * not somebody saying "keep this after all" - it is somebody rating a photograph
 * in a folder that has since left, and bringing the row back would have repair
 * remove it again on the next pass. If the folder is ever let back in, the scan
 * imports its files as new photographs with new ids, which is the resurrection a
 * person would actually recognise, and it needs nothing from this.
 *
 * The divergence: a row that comes back arrives with the *resurrecting* peer's
 * copy of every unit, which can be older than what the peer applying it held and
 * destroyed - and the deletion is erased as the row returns, so nothing is left
 * to settle the difference. Final tombstones close that off. Ties, and every
 * other race, are then decided by the stamp as before.
 */
function applyTombstone(db: Database, libraryId: string, entity: ReplicatedEntity, change: Tombstone): void {
  const where = whereKey(entity, change.rowId, libraryId);
  const stamps = entity.units.map((unit) => unit.stamp);
  const local = db
    .query(`SELECT ${stamps.join(', ')} FROM ${entity.table} WHERE ${where.sql}`)
    .get(...where.params) as Record<string, string | null> | null;
  if (local != null) {
    const survives =
      resurrectable(entity) &&
      stamps.some((column) => {
        const held = local[column];
        return held != null && held > change.stamp;
      });
    if (survives) return;
    // The same fan-out the peer that made this deletion ran: the children go with
    // the row, and this peer stops advertising the ones it was holding.
    if (entity.kind === 'photo' || entity.kind === 'shoot' || entity.kind === 'stack') {
      if (entity.kind === 'photo') sayWhatTheDeletionCosts(db, change);
      // A shoot takes the tree under it, and the tree *here* is not the tree the
      // sender had: a child made on this peer while the other was deleting the
      // parent is one the sender never heard of, so its tombstone names only the
      // parent. Left to the foreign key, that child would go with no record of
      // going - the log still advertising a row nobody can be sent (§5.1).
      const doomed = entity.kind === 'shoot' ? shootsBelow(db, [change.rowId]) : [change.rowId];
      forgetCascade(db, libraryId, entity.kind, doomed);
      // Stamped here, not with the tombstone that caused them, for the reason the
      // cascade is: a row stamped inside the deleting peer's origin can never be
      // sent back to it, and these describe rows only this peer ever had.
      const alsoGone = doomed.filter((rowId) => rowId !== change.rowId);
      if (alsoGone.length > 0) {
        const at = stampFor(db);
        for (const rowId of alsoGone) tombstone(db, libraryId, entity.kind, rowId, at);
      }
    }
    db.query(`DELETE FROM ${entity.table} WHERE ${where.sql}`).run(...where.params);
  }
  tombstone(db, libraryId, entity.kind, change.rowId, change.stamp);
}

function applyRow(db: Database, libraryId: string, entity: ReplicatedEntity, change: LiveChange): void {
  const { row, stamps } = change;
  const where = whereKey(entity, change.rowId, libraryId);
  const local = db
    .query(`SELECT ${entity.units.map((unit) => unit.stamp).join(', ')} FROM ${entity.table} WHERE ${where.sql}`)
    .get(...where.params) as Record<string, string | null> | null;

  if (local == null) {
    // A row that is not here may be one nobody has sent yet, or one this peer
    // deleted. Only the second has a tombstone, and only a unit written after it
    // may bring the row back.
    if (entity.updateOnly || buried(db, libraryId, entity, change)) return;
    insert(db, libraryId, entity, change, row, stamps);
    return;
  }

  // Sessions decide what a diverged pair of edits means before LWW decides which
  // one shows (docs/replication.md §5.3). Only the parking is extra: a descendant
  // is always the newer stamp, so the unit comparison below already applies it,
  // and the newest of two parked candidates becoming the provisional row is that
  // same comparison again.
  if (entity.kind === 'photo_edits') parkDivergentEdits(db, change);

  // Column and value together, rather than SQL and parameters in step: a collision below is settled by
  // writing the same update with one column dropped, which is a filter over these and would otherwise
  // be two arrays to keep aligned by hand.
  const writes: { column: string; value: Cell }[] = [];
  let placement = false;
  for (const unit of entity.units) {
    const arriving = stamps[unit.entity];
    const held = local[unit.stamp];
    if (arriving == null || (held != null && held >= arriving)) continue;
    if (unit.entity === 'photo.placement' || unit.entity === 'photo.bin') placement = true;
    for (const column of unit.columns) {
      // **A column the sender never mentioned keeps this peer's own value.** A peer on an older
      // build selects only the columns it knows (`stream.ts`), so a column added since is simply
      // absent from the payload - and writing NULL for it is either a field silently cleared or,
      // where the column is NOT NULL, a constraint failure that is not a missing reference and so
      // rejects the whole page rather than deferring it. Every session, since the page comes
      // back. `null` that the sender *did* send is a real value and still lands (§8.5).
      if (!(column in row)) continue;
      writes.push({ column, value: resolve(db, libraryId, entity, column, row[column] ?? null) });
    }
    writes.push({ column: unit.stamp, value: arriving });
  }
  if (writes.length === 0) return;
  const update = (of: readonly { column: string; value: Cell }[]): void => {
    db.query(`UPDATE ${entity.table} SET ${of.map((w) => `${w.column} = ?`).join(', ')} WHERE ${where.sql}`).run(
      ...of.map((w) => w.value),
      ...where.params,
    );
  };
  // Read before the write, because where this peer's copy stands is the one thing the drain
  // cannot work out afterwards (§7.4). Validated on the way out rather than taken from the row:
  // this value is queued and later joined onto the library root, and a payload's own check
  // cannot vouch for what SQL reads back out of a recipe.
  const wasAt = placement ? recipePathToTouch(db, change.rowId) : null;
  try {
    update(writes);
  } catch (error) {
    // The same collision the insert below defers, reached from the other side: a row this peer *does*
    // have by key, moved onto a value another row here already occupies. Two peers each renaming a
    // different folder to the same name while apart is the reachable one - `shoots` is unique on
    // `(library_id, folder_path)` and no peer can hold both - and there is no order of arrival that
    // makes it fit.
    //
    // Never thrown, because a throw here is the whole page refused, every session, in both directions:
    // one contested folder name would stop a library replicating anything at all, and the rows behind
    // it are photographs.
    if (!isUniqueCollision(error)) throw error;
    const held = keepsTheFolder(db, libraryId, entity, change);
    if (held == null) {
      // Some other unique constraint, or a folder that turns out to be free. Held back and heard
      // again (§5.1), which is all a merge can do with a collision it cannot name.
      log.warn('a change could not be written beside a row already here', {
        entity: entity.kind,
        row: change.rowId,
        err: String(error),
      });
      throw new Deferred();
    }
    // **The loser yields, and this peer can always make it.** Whichever of the two renames came later
    // gives the folder up: the arriving one by not being written, the one already sitting there by being
    // moved off. Neither needs a path invented for it - the arriving change's loser keeps what it
    // already has here, and the local loser goes to the contested name suffixed, which is free by
    // construction. Both are re-stamped, so the peer that made the losing rename hears where it went.
    if (held.kind === 'arriving') {
      // The arriving rename is the later one. It keeps what this peer holds, and everything else the
      // unit carried still lands: a name changed in the same breath as the folder was not contested.
      // `folder_path` is dropped rather than replaced, so this write cannot collide in turn: the only
      // unique index on `shoots` is the one over it, and the row keeps the folder it already had.
      //
      // Only the *folder's* stamp is moved. The shoot's own arrives untouched, so a label or an
      // ordering that rode along with the rename lands under the stamp it was actually written at -
      // promoting that one would claim they had been rewritten now, and silently drop an edit to
      // either that a third peer still had on its way (§5.6).
      const kept = writes.filter((w) => w.column !== 'folder_path' && w.column !== 'stamp_folder');
      update([...kept, { column: 'stamp_folder', value: stampFor(db) }]);
      log.info('a folder was claimed by an earlier rename, so this one goes back', {
        shoot: change.rowId,
        folder: String(change.row['folder_path']),
        keptBy: held.by,
      });
    } else {
      // The arriving rename is the earlier one and takes the folder, so the shoot sitting on it is the
      // loser. Only the peer that renamed *that* one knows where it came from, so here it takes the
      // contested name suffixed - which replicates under this peer's own stamp, and is what a rename
      // with nowhere to go back to settles at.
      // The folder's stamp alone, on a row this page was not even about: bumping the shoot's would say
      // that whatever else it holds was rewritten now, which is an edit to its label lost on every peer
      // that had not yet sent it (§5.6).
      const moved = freeFolder(db, libraryId, String(change.row['folder_path']), held.by);
      db.query('UPDATE shoots SET folder_path = ?, stamp_folder = ? WHERE id = ?').run(moved, stampFor(db), held.by);
      update(writes);
      log.warn('a folder went to an earlier rename, so the shoot holding it took a free name', {
        shoot: held.by,
        folder: String(change.row['folder_path']),
        took: moved,
        wonBy: change.rowId,
      });
    }
  }
  if (wasAt != null) queueMaterialisation(db, libraryId, change.rowId, wasAt);
  afterWrite(db, entity, change, where);
}

// Not "is this one of the kinds that compose": a kind this build has never heard of composes
// too, and a peer on a later build is where one comes from. What is true of every row that is
// not a file is that it has no bytes of its own to be missing.
function composed(recipe: Cell | undefined): boolean {
  return typeof recipe === 'string' && recipeOf(recipe).kind !== 'file';
}

function insert(
  db: Database,
  libraryId: string,
  entity: ReplicatedEntity,
  change: LiveChange,
  row: Record<string, Cell>,
  stamps: Record<string, string>,
): void {
  const columns: string[] = [];
  const values: Cell[] = [];
  // Checked rather than assumed, because SQLite will not check it for us: a TEXT
  // PRIMARY KEY on an ordinary table is nullable, and NULLs are exempt from its
  // uniqueness, so a payload with no id at all inserts a row with none - and every
  // later change under that row id inserts another, since the lookup by id can
  // never find one. The key must also *be* the row id the log named it by, or the
  // row this peer writes is not the row the sender was describing.
  const keyed = keyParts(entity, change.rowId);
  for (const column of new Set([...entity.identity, ...entity.key])) {
    // The library is this session's, never the payload's. Every other statement
    // here is scoped by `library_id = ?` bound from the pairing-checked id, but an
    // insert has no row to scope against - so a peer paired for one library could
    // otherwise create rows in another one held on the same server (§11.2).
    if (column === entity.libraryColumn) {
      columns.push(column);
      values.push(libraryId);
      continue;
    }
    const value = row[column] ?? null;
    const expected = keyed.get(column);
    if (expected != null && value !== expected) {
      throw new AppError('VALIDATION_ERROR', `a ${entity.kind} says it is ${change.rowId} but its ${column} is ${String(value)}`);
    }
    if (value == null) {
      throw new AppError('VALIDATION_ERROR', `a ${entity.kind} arrived with no ${column}`);
    }
    columns.push(column);
    values.push(resolve(db, libraryId, entity, column, value));
  }
  // A photograph this peer is hearing of for the first time is one whose bytes it
  // does not have: the column is per-peer and no payload carries it, so left to
  // the schema's default a whole cloned catalogue would claim to hold every
  // original - and the processing queue, which asks for photographs that are
  // present and unbuilt, would try to decode every one of them (§9).
  //
  // A composite has no bytes of its own to be missing, and nothing would ever clear the flag
  // for one: it is rendered from its frames, so the transfer and scan paths that clear it
  // never reach it and it would sit unrenderable on every peer but the one that merged it.
  if (entity.kind === 'photo' && !composed(row['recipe'])) {
    columns.push('is_missing');
    values.push(1);
  }
  for (const unit of entity.units) {
    const arriving = stamps[unit.entity];
    if (arriving == null) continue;
    for (const column of unit.columns) {
      if (columns.includes(column)) continue;
      // Left out entirely where the sender never mentioned it, so the column takes the schema's
      // own default rather than a NULL - the same rule the update above follows, and the only
      // one that lets a peer on an older build insert a row into a table that has since grown a
      // NOT NULL column.
      if (!(column in row)) continue;
      columns.push(column);
      values.push(resolve(db, libraryId, entity, column, row[column] ?? null));
    }
    columns.push(unit.stamp);
    values.push(arriving);
  }
  const written = db.query(
    `INSERT INTO ${entity.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT DO NOTHING`,
  ).run(...values);
  // Nothing may claim coverage of a change it discarded (§5.1). The row this peer
  // does not have by key can still collide on another unique constraint - two peers
  // that each mirrored the same folder into a shoot of their own, which needs a
  // tree they both scanned - and claiming that change says this peer took a row it
  // refused, while everything referencing it is refused for good afterwards.
  if (written.changes === 0) {
    log.warn('a row could not be written beside one already here', { entity: entity.kind, row: change.rowId });
    throw new Deferred();
  }
  unbury(db, libraryId, entity.kind, change.rowId);
  afterWrite(db, entity, change, whereKey(entity, change.rowId, libraryId));
}

function afterWrite(
  db: Database,
  entity: ReplicatedEntity,
  change: LiveChange,
  where: { sql: string; params: string[] },
): void {
  if (entity.sidecar != null) {
    const side = entity.sidecar;
    const key = whereSidecar(entity, change.rowId);
    db.query(`DELETE FROM ${side.table} WHERE ${key.sql}`).run(...key.params);
    if (change.sidecar != null) {
      const sent = change.sidecar;
      const columns = [...entity.key, ...side.columns];
      db.query(
        `INSERT INTO ${side.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...key.params, ...side.columns.map((column) => sent[column] ?? null));
    }
  }
  // An editor open on this photograph is holding a revision that no longer
  // describes what is stored, so the next save it attempts has to be refused
  // rather than allowed to overwrite what just arrived.
  if (entity.table === 'photo_edits') {
    db.query(`UPDATE photo_edits SET rev = rev + 1 WHERE ${where.sql}`).run(...where.params);
  }
}

/** Whether a later write may bring this kind of row back at all (see `applyTombstone`). */
function resurrectable(entity: ReplicatedEntity): boolean {
  return entity.kind !== 'photo' && entity.kind !== 'shoot';
}

/**
 * Says so when a photograph's removal takes develop settings made *after* it.
 *
 * Nothing can be done to keep them. The photograph's row is going because its
 * folder left the library, and that tombstone is final (see below); its edits
 * cannot outlive it - `edit_conflicts` and `photo_edits` both hang off the
 * photograph by a foreign key, so there is nowhere for them to be parked that the
 * same deletion does not reach. If the folder is ever let back in, its files
 * import as new photographs with new ids, which these edits could not attach to
 * either.
 *
 * What is worth refusing to do quietly is throwing away work somebody did while
 * another device was deciding the folder should go. The line names the
 * photograph, so a backup can still be gone through.
 */
function sayWhatTheDeletionCosts(db: Database, change: Tombstone): void {
  const edits = db.query('SELECT stamp FROM photo_edits WHERE photo_id = ?').get(change.rowId) as
    | { stamp: string | null }
    | null;
  if (edits?.stamp == null || edits.stamp <= change.stamp) return;
  log.warn('a photograph removed elsewhere took develop settings made here after the removal', {
    photo: change.rowId,
    edited: edits.stamp,
    removed: change.stamp,
  });
}

/**
 * The key columns the log's row id spells out, which the payload has to agree with.
 *
 * Empty where the id spells none, rather than refusing: `applyChanges` has already
 * dropped such a change, so reaching here with one is not something a peer can
 * arrange - and a throw at this depth would take the page with it, which is the
 * thing that stopped whole libraries replicating.
 */
function keyParts(entity: ReplicatedEntity, rowId: string): Map<string, string> {
  const parts = keyPartsOf(rowId, entity.key);
  if (parts == null) return new Map();
  return new Map(entity.key.map((column, i): [string, string] => [column, parts[i]!]));
}

function buried(db: Database, libraryId: string, entity: ReplicatedEntity, change: LiveChange): boolean {
  const at = graveOf(db, libraryId, entity.kind, change.rowId);
  if (at == null) return false;
  // The newest unit, computed here rather than read off the change: what this asks
  // is whether the grave is newer than *anything* the row carries, which no single
  // field on a live change means. Holding a deferral against any single one is how a
  // photograph's placement gets claimed and never sent again.
  return !resurrectable(entity) || at >= newestUnit(change);
}

function newestUnit(change: LiveChange): string {
  let newest = '';
  for (const stamp of Object.values(change.stamps)) if (stamp > newest) newest = stamp;
  return newest;
}

/** The stamp this peer buried a row at, or null if it never buried one. */
function graveOf(db: Database, libraryId: string, kind: string, rowId: string): string | null {
  const grave = db
    .query('SELECT stamp FROM replication_log WHERE library_id = ? AND entity = ? AND row_id = ? AND deleted = 1')
    .get(libraryId, kind, rowId) as { stamp: string } | null;
  return grave?.stamp ?? null;
}

/** Takes every stamp in a page into account, so nothing minted here sorts below it. */
export function observePage(db: Database, changes: readonly Change[]): boolean {
  let accepted = true;
  for (const change of changes) {
    for (const stamp of unclaimed(change)) {
      if (!observeStamp(db, stamp)) accepted = false;
    }
  }
  return accepted;
}
