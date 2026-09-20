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
