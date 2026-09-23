import { REPLICATED_UNITS } from './units';

// What actually travels, and what a merge does with it once it lands
// (docs/replication.md §3, §5).
//
// **The log indexes units; the payload carries whole rows.** Those granularities
// differ on purpose. A version vector is keyed by the peer that minted a stamp,
// so the *index* has to be per unit or a row whose units were last written by
// different peers would be skipped by a peer that already held the newest of
// them. But a unit on its own cannot be applied to a row that is not there yet -
// pages arrive in stamp order, not in an order that puts a photograph before its
// verdict - so what is sent is the row, with every unit's stamp on it, and the
// merge resolves each unit separately. Sending a column the receiver already has
// costs a few bytes; sending half a row costs a photograph that cannot be
// inserted.

export interface EntityUnit {
  /** The log entity, e.g. `photo.triage`. */
  entity: string;
  stamp: string;
  columns: readonly string[];
}

/**
 * Every kind of row that replicates.
 *
 * Written out rather than inferred, so that adding one is a compile error
 * everywhere a decision is made per kind - the apply's parents-before-children
 * order most of all, where a kind nobody listed sorted ahead of everything and
 * would have deferred every session, silently, for as long as it took somebody to
 * notice.
 */
export type ReplicatedKind =
  | 'photo'
  | 'shoot'
  | 'folder_rule'
  | 'stack'
  | 'stack_member'
  | 'blob_location'
  | 'library'
  | 'shoot_banner'
  | 'photo_edits'
  | 'edit_conflict';

export interface ReplicatedEntity {
  /** What a tombstone for one of these is called in the log. */
  kind: ReplicatedKind;
  table: string;
  /**
   * The columns the log's `row_id` encodes, in order, joined by a slash where
   * there is more than one. Deliberately not the table's whole primary key: the
   * log is already scoped to a library, so repeating the library in every row id
   * would be a second copy of something the query already knows.
   */
  key: readonly string[];
  /** Where this table records its library, for the queries that must be scoped by it. */
  libraryColumn?: string;
  /**
   * For a table that records no library of its own, how to ask which one a row
   * belongs to: SQL taking the row id's key parts and answering `library_id`.
   *
   * A session replicates one library, and a change naming a row in a different one
   * is a change the sending peer was never paired for. Every table that carries
   * `library_id` refuses that in its WHERE clause; these have to ask their parent.
   */
  libraryVia?: string;
  /** Columns every unit needs present to insert a row at all. */
  identity: readonly string[];
  units: readonly EntityUnit[];
  /**
   * A row this peer does not already have cannot be created from a payload, so a
   * merge may only update one. True of the library itself, whose `root_path` is
   * where *this* machine keeps it: a library arriving somewhere it is unknown is
   * one that peer is not replicating, which pairing decides and a merge does not.
   */
  updateOnly?: boolean;
  /**
   * A second table keyed the same way whose row travels with this one, because it
   * is part of the same fact rather than a fact of its own.
   */
  sidecar?: { table: string; columns: readonly string[] };
}

function unitsOf(table: string, columns: Record<string, readonly string[]>): EntityUnit[] {
  return REPLICATED_UNITS.filter((unit) => unit.table === table).map((unit) => ({
    entity: unit.entity,
    stamp: unit.stamp,
    columns: columns[unit.entity] ?? [],
  }));
}

export const REPLICATED_ENTITIES: readonly ReplicatedEntity[] = [
  {
    kind: 'photo',
    table: 'photos',
    key: ['id'],
    libraryColumn: 'library_id',
    // width and height are NOT NULL and belong to `imported`, so a row cannot be
    // created without them; they ride in identity as well so a page carrying only
    // a verdict can still land the photograph it is about.
    // The recipe rather than a path, because it is where the path now is - and because a row
    // cannot be created without one: it is NOT NULL, and what it says decides whether the row
    // is a file at all.
    identity: ['id', 'library_id', 'recipe', 'width', 'height', 'date_added'],
    units: unitsOf('photos', {
      'photo.imported': [
        'content_hash',
        // With `date_added` rather than with the recipe, though it is derived from the path in
        // one: every write of a path after the import is a folder rename, a bin move or a
        // restore, and none of those changes a filename's extension. So this is an import-time
        // fact that never moves again, and pairing it with the path would have it re-sent by
        // every rename.
        'format',
        'file_size',
        'width',
        'height',
        'orientation',
        'date_taken',
        'date_taken_offset',
        'date_added',
        'latitude',
        'longitude',
        'iso',
        'shutter_speed',
        'aperture',
        'focal_length',
        'camera_make',
        'camera_model',
        'lens_model',
        'capture_sequence',
      ],
      'photo.triage': ['rating', 'triage', 'notes'],
      // The recipe travels here rather than with the import facts, and for a file photograph it
      // *is* the placement: where its bytes are is what a rename rewrites, which is exactly what
      // this unit has always carried. A composite's recipe is the same fact one level up - what
      // its pixels come from - and nothing renames one, so the two cannot collide.
      'photo.placement': ['recipe', 'shoot_id'],
      // `deleted_from_path` stays with `is_deleted`, and the pairing is the point:
      // it is only meaningful while the row is binned, so a peer that thinks the
      // photograph is live holds NULL for it. Moved to `placement` it would ride
      // that peer's ordinary path writes, and a newer one would null the origin of
      // a binning it had never heard about - after which a restore puts the RAW in
      // the library root. Which is worse than what moving it was meant to fix; see
      // `rewritePathPrefix`.
      'photo.bin': ['is_deleted', 'deleted_from_path', 'deleted_batch'],
      'photo.stack': ['stack_state'],
      'photo.hidden': ['is_hidden'],
    }),
  },
  {
    kind: 'shoot',
    table: 'shoots',
    key: ['id'],
    libraryColumn: 'library_id',
    identity: ['id', 'library_id', 'folder_path', 'name'],
    units: unitsOf('shoots', {
      shoot: ['parent_id', 'name', 'description', 'ordering'],
      // `folder_path` is in `identity` as well, so a page carrying only a label can still land the
      // shoot it is about - the same reason `width` and `height` ride the photograph's identity.
      'shoot.folder': ['folder_path'],
      'shoot.hidden': ['is_hidden'],
    }),
  },
  {
    kind: 'folder_rule',
    table: 'folder_rules',
    key: ['folder_path'],
    libraryColumn: 'library_id',
    identity: ['library_id', 'folder_path', 'rule'],
    units: unitsOf('folder_rules', { folder_rule: ['rule'] }),
  },
  {
    kind: 'stack',
    table: 'stacks',
    key: ['id'],
    libraryColumn: 'library_id',
    identity: ['id', 'library_id', 'origin', 'date_created'],
    // `created_stamp` is in the unit so it travels, but nothing ever rewrites it:
    // it decides which id survives when two peers stacked overlapping sets, and a
    // value that moved could not answer that.
    units: unitsOf('stacks', {
      stack: ['origin', 'date_created', 'created_stamp'],
    }),
  },
  {
    kind: 'stack_member',
    table: 'stack_members',
    key: ['stack_id', 'photo_id'],
    libraryColumn: 'library_id',
    identity: ['library_id', 'stack_id', 'photo_id'],
    units: unitsOf('stack_members', { stack_member: [] }),
  },
  {
    kind: 'blob_location',
    table: 'blob_locations',
    key: ['photo_id', 'peer_id'],
    libraryColumn: 'library_id',
    // Nothing beyond the key: the row *is* the claim, and its stamp is when the
    // peer made it. A retraction is a tombstone like any other.
    identity: ['library_id', 'photo_id', 'peer_id'],
    units: unitsOf('blob_locations', { blob_location: [] }),
  },
  {
    kind: 'library',
    table: 'libraries',
    updateOnly: true,
    key: ['id'],
    // root_path is per-peer and NOT NULL UNIQUE, so it cannot travel and cannot be
    // defaulted: a library arriving at a peer that does not have it is a library
    // that peer is not replicating, which pairing decides rather than a merge.
    identity: ['id', 'name'],
    units: unitsOf('libraries', {
      library: [
        'name',
        'ordering',
        'include_subfolders',
        'include_non_raw',
        'bin_name',
        'auto_stack',
        'auto_stack_similarity',
        'auto_stack_window_seconds',
      ],
    }),
  },
  {
    kind: 'shoot_banner',
    table: 'shoot_banners',
    key: ['shoot_id'],
    libraryVia: 'SELECT library_id FROM shoots WHERE id = ?',
    identity: ['shoot_id', 'photo_id'],
    units: unitsOf('shoot_banners', { shoot_banner: ['photo_id'] }),
  },
  {
    kind: 'photo_edits',
    table: 'photo_edits',
    key: ['photo_id'],
    libraryVia: 'SELECT library_id FROM photos WHERE id = ?',
    identity: ['photo_id', 'doc', 'cursor', 'rev', 'updated_at'],
    // `rev` is in identity so a row can be created, and is otherwise left alone by
    // the merge: it counts writes made against *this* replica, and an apply bumps
    // it so an editor holding a stale revision is refused rather than silently
    // overwriting what has just arrived.
    // `updated_at` is replicated, not merely part of the identity above. Identity
    // seeds an insert, and every edit after the first one for a photograph takes
    // the update path - so left out here it freezes on every peer but the one
    // doing the editing. It is what says a rendition is out of date: the rebuild
    // queue asks it, and §7.9's fetch-through refuses to serve against it. Frozen,
    // a peer keeps showing the picture from before the edit and keeps handing that
    // picture to peers that cannot build their own, and nothing comes to correct
    // it, because nothing is looking at anything that changed.
    units: unitsOf('photo_edits', { photo_edits: ['doc', 'cursor', 'session_id', 'chain', 'updated_at'] }),
    // The undo stack travels with the document rather than as a fact of its own.
    // A history spliced from two peers is a history of a session that never
    // happened, so undo would walk back through states the photograph was never
    // in; whole, it is at worst somebody else's session, which is what the edit
    // conflict is for.
    sidecar: { table: 'photo_edit_history', columns: ['deltas'] },
  },
  {
    kind: 'edit_conflict',
    table: 'edit_conflicts',
    key: ['photo_id', 'session_id'],
    // The first key part alone: a session id says nothing about a library.
    libraryVia: 'SELECT library_id FROM photos WHERE id = ?',
    identity: ['photo_id', 'session_id', 'doc', 'cursor', 'chain'],
    // A frozen candidate, so plain LWW is exact: the only writes it ever sees are
    // the same divergence parked again after a later save of the same session.
    units: unitsOf('edit_conflicts', { edit_conflict: ['doc', 'history', 'cursor', 'chain'] }),
  },
];

const BY_ENTITY = new Map<string, ReplicatedEntity>();
for (const entity of REPLICATED_ENTITIES) {
  BY_ENTITY.set(entity.kind, entity);
  for (const unit of entity.units) BY_ENTITY.set(unit.entity, entity);
}

/** The entity a log row belongs to, whether it names a unit or a tombstone. */
export function entityOf(logEntity: string): ReplicatedEntity {
  const found = BY_ENTITY.get(logEntity);
  if (found == null) throw new Error(`no replicated entity for ${logEntity}`);
  return found;
}

/** Every column a payload for this entity carries. */
export function payloadColumns(entity: ReplicatedEntity): string[] {
  const columns = new Set<string>([...entity.identity, ...entity.key]);
  for (const unit of entity.units) {
    for (const column of unit.columns) columns.add(column);
  }
  return [...columns];
}
