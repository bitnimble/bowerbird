import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { libraries } from './libraries';
import { photos } from './photos';

// This install's own replication identity, minted once and never again: it is what every stamp this
// machine writes is signed with, and what other peers key their version vectors by. Changing it
// would make this peer a stranger to its own writes, so the row is a singleton by construction.
export const replicationIdentity = sqliteTable(
  'replication_identity',
  {
    singleton: integer('singleton').primaryKey(),
    peerId: text('peer_id').notNull(),
    name: text('name').notNull(),
  },
  (t) => [check('replication_identity_singleton', sql`${t.singleton} = 1`)],
);

// The libraries this install actually replicates. Empty until one is paired, which is what keeps an
// ordinary catalogue paying nothing for the log below.
export const replicationLibraries = sqliteTable('replication_libraries', {
  libraryId: text('library_id')
    .primaryKey()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  // Whether this device keeps the RAW files of a library it replicates (§7.10). Deliberately not a
  // replicated unit: it is a statement about one device's disk, and a laptop that wants only the
  // catalogue must not have that answer overwritten by the desktop's.
  syncOriginals: integer('sync_originals').notNull().default(1),
});

// One row per replicated unit, holding the stamp it currently carries: the index that answers
// "everything that has changed since <version vector>" as a range scan, whatever the size of the
// catalogue behind it.
//
// State-based, so it is overwritten in place and never grows past the catalogue, and it needs no
// compaction: an intermediate value nobody holds any more is not something any peer can still want,
// because last-write-wins is settled by the newest stamp alone.
//
// One row per *unit* rather than per row is load-bearing. A version vector is keyed by the peer
// that minted a stamp, and a row whose units were last written by different peers has no single
// origin: keyed by the newest of them, a peer that already holds that origin's later work would
// skip the row and never receive the older unit inside it.
//
// No foreign keys: a tombstone has to outlive the row it describes, and a library tombstone would
// have nothing left to point at.
export const replicationLog = sqliteTable(
  'replication_log',
  {
    libraryId: text('library_id').notNull(),
    entity: text('entity').notNull(),
    rowId: text('row_id').notNull(),
    stamp: text('stamp').notNull(),
    deleted: integer('deleted').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.entity, t.rowId] }),
    index('idx_replication_log_stamp').on(t.libraryId, t.stamp),
  ],
);

// What this replica holds, per origin: the stamp below which everything that origin ever wrote has
// been applied here. A claim about completeness rather than a high-water mark of what happened to
// arrive, which is what lets a sender work out precisely what to send.
//
// Only remote origins. This peer's coverage of its own writes is asked of the clock, since
// everything it has minted is applied here by construction.
export const replicationVectors = sqliteTable(
  'replication_vectors',
  {
    libraryId: text('library_id').notNull(),
    origin: text('origin').notNull(),
    stamp: text('stamp').notNull(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.origin] })],
);

// The same, for what each peer last told us *it* holds. Tombstones are collected against the lowest
// of these: a deletion may only be forgotten once every peer has been told about it, or a peer that
// had not heard would bring the row back.
export const replicationPeerVectors = sqliteTable(
  'replication_peer_vectors',
  {
    libraryId: text('library_id').notNull(),
    peerId: text('peer_id').notNull(),
    origin: text('origin').notNull(),
    stamp: text('stamp').notNull(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.peerId, t.origin] })],
);

// The peers this install has paired with, per library: the record every replication request's
// peer_id is checked against. An interlock against pairing the wrong library, not authentication
// (docs/replication.md §6.5, §11.1); the trusted network is the security boundary.
export const replicationPeers = sqliteTable(
  'replication_peers',
  {
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    peerId: text('peer_id').notNull(),
    name: text('name').notNull(),
    pairedAt: text('paired_at').notNull(),
    lastReplicatedAt: text('last_replicated_at'),
    // Where a peer can be reached, on the side that has to reach it. Only one side ever does: a
    // laptop dials the server it paired with, and the server never dials the laptop, which is what
    // lets a laptop behind NAT open nothing (§6.4). NULL is therefore ordinary rather than missing.
    address: text('address'),
    // Why the last session with this peer did not happen (§8.6). Replication that has quietly
    // stopped working is the failure the trip depends on seeing.
    lastError: text('last_error'),
    wantsOriginals: integer('wants_originals').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.peerId] })],
);

// A materialisation that found its target occupied (§7.7): the entry is skipped, never overwritten
// and never suffixed, and the photo is flagged here for the §5.6 surface. Per-peer derived state,
// never replicated.
export const materialisationFlags = sqliteTable(
  'materialisation_flags',
  {
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    targetPath: text('target_path').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.photoId] })],
);

// A photograph whose merged placement the disk has not caught up with (§7.4). Written in the same
// transaction as the merge that moved it, so a crash before the drain leaves a record rather than a
// tree the scan would read as the user moving the file back, and then replicate the reversal.
//
// was_at is where this peer's copy stood before the merge, because that is the only thing the drain
// cannot recompute; the target comes from the row's current state at drain time, so a rename merged
// while the entry waits retargets it.
export const materialisationQueue = sqliteTable(
  'materialisation_queue',
  {
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    wasAt: text('was_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.photoId] })],
);
