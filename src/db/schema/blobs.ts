import { check, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { oneOf } from './checks';
import { libraries } from './libraries';
import { photos } from './photos';

// Which peers hold which originals (docs/replication.md §7.2): where a fetch can come from, and
// what the awaiting-originals counts read. Deliberately *not* sufficient for "safe to evict":
// replicated rows are stale by construction, so eviction requires a live possession check at evict
// time (§7.6). No foreign keys, like the log: a retraction tombstone has to outlive the row it is
// about.
export const blobLocations = sqliteTable(
  'blob_locations',
  {
    libraryId: text('library_id').notNull(),
    photoId: text('photo_id').notNull(),
    peerId: text('peer_id').notNull(),
    stamp: text('stamp').notNull(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.photoId, t.peerId] })],
);

// What a passive peer holds, and where (docs/replication.md §14.2). The same question
// `blob_locations` answers for an active peer, in a table of its own and for one reason: a location
// row is a fact a peer asserts about itself, and a directory asserts nothing. These rows are this
// device's reading of a mount it can see, so they never replicate - another device told "the drive
// holds it" could neither reach it nor retract the claim.
//
// `rel_path` is where the copy was last put rather than where the catalogue now says it belongs:
// the two disagree from the moment a photo is binned or a shoot renamed until the backup pass
// replays the move, and finding the file again is what needs the old one. `size` and `content_hash`
// are what a pass checks a copy against without reading every byte of the mount.
export const backupLocations = sqliteTable(
  'backup_locations',
  {
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    peerId: text('peer_id').notNull(),
    relPath: text('rel_path').notNull(),
    contentHash: text('content_hash').notNull(),
    size: integer('size').notNull(),
    // When this device last saw the copy, which the scrub reads oldest first (§14.3). Written by
    // the copy that made it and by every later check of it, so it means "known good at", not
    // "copied at" - a backup nobody has looked at in a month is the thing worth looking at.
    verifiedAt: text('verified_at').notNull(),
  },
  // Photo before peer, which is the other way round from `blob_locations`: what a grid page asks
  // is whether *this photograph* is on a backup, once per row, and a key that leads with the peer
  // answers it by walking every row the library has.
  (t) => [primaryKey({ columns: [t.libraryId, t.photoId, t.peerId] })],
);

export const BLOB_TRANSFER_DIRECTIONS = ['push', 'pull'] as const;
export const BLOB_TRANSFER_STATES = [
  'queued',
  'active',
  'paused',
  'done',
  'failed',
  'cancelled',
] as const;

// The transfer queue (§7.3): manual pushes and pulls of originals, durable so a restart picks up
// from the staged bytes instead of forgetting what it owed. Per-peer bookkeeping, never replicated.
export const blobTransfers = sqliteTable(
  'blob_transfers',
  {
    id: text('id').primaryKey(),
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    peerId: text('peer_id').notNull(),
    direction: text('direction').notNull(),
    state: text('state').notNull().default('queued'),
    bytesDone: integer('bytes_done').notNull().default(0),
    bytesTotal: integer('bytes_total'),
    error: text('error'),
    queuedAt: text('queued_at').notNull(),
  },
  (t) => [
    unique().on(t.libraryId, t.photoId, t.peerId, t.direction),
    check('blob_transfers_direction', oneOf(t.direction, BLOB_TRANSFER_DIRECTIONS)),
    check('blob_transfers_state', oneOf(t.state, BLOB_TRANSFER_STATES)),
  ],
);
