import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { photos } from './photos';

// One photo's develop settings as they stand, plus the two small values that move on every undo.
// Read by the editor's open, and never by way of the history: that split is the whole reason there
// are two tables.
//
// Editing is non-destructive: the RAW is never written, and deleting these rows restores the photo
// to what the camera recorded. The cascade is a *hard* delete only, which is deliberate: a photo
// restored from the Bin comes back edited, and one whose file moved keeps its edits, because move
// detection preserves the id.
//
// No row until the first edit, so an untouched library pays nothing for this.
export const photoEdits = sqliteTable('photo_edits', {
  photoId: text('photo_id')
    .primaryKey()
    .references(() => photos.id, { onDelete: 'cascade' }),
  doc: text('doc').notNull(), // EditDocSchema, JSON
  // How far into photo_edit_history.deltas the undo cursor stands. Here rather than beside the
  // deltas because an undo moves this and the doc and touches neither the array nor its overflow
  // pages; welded to that blob, stepping one integer would rewrite tens of kilobytes.
  cursor: integer('cursor').notNull(),
  // Bumped by every write, and required by the next one. Without it two tabs do not merely lose an
  // edit: the server diffs a stale document against the stored one and invents a delta for a
  // change nobody made, which undo then walks back through.
  rev: integer('rev').notNull(),
  updatedAt: text('updated_at').notNull(),
  stamp: text('stamp'),
  // Which editor open wrote the current document, and the hops behind it back to the root
  // (docs/replication.md §5.3). NULL reads as plain last-write-wins.
  sessionId: text('session_id'),
  chain: text('chain'),
});

// The undo stack, as one JSON array per photo rather than a row per step: a single step is never
// read without the rest of its history, because undo walks the array.
export const photoEditHistory = sqliteTable('photo_edit_history', {
  photoId: text('photo_id')
    .primaryKey()
    .references(() => photos.id, { onDelete: 'cascade' }),
  deltas: text('deltas').notNull(), // [{ from: Partial<EditDoc>, to: Partial<EditDoc> }, ...]
});

// Both sides of an edit conflict, kept until the photographer picks one (docs/replication.md
// §5.3). A row is a frozen candidate: the document, its undo stack and its session lineage exactly
// as they stood when the divergence was found, replicated under the candidate's own stamp.
//
// Every column is the candidate's own bytes and the stamp is the candidate's own stamp,
// deliberately: one of a divergence's two rows carries the *other* peer's stamp, and a row so
// stamped can never be streamed to a peer whose coverage already claims that origin. So each side
// builds its own copy from the same two candidates, and they have to build the same bytes.
export const editConflicts = sqliteTable(
  'edit_conflicts',
  {
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    doc: text('doc').notNull(),
    history: text('history'),
    cursor: integer('cursor').notNull(),
    chain: text('chain').notNull(),
    stamp: text('stamp'),
  },
  (t) => [primaryKey({ columns: [t.photoId, t.sessionId] })],
);
