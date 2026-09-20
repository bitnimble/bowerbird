import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { RENDITION_SOURCES } from '../../schemas/common';
import { oneOf } from './checks';
import { libraries } from './libraries';
import { photos } from './photos';

// Every derived copy of a photograph that has been built or is owed (§10.2). Keyed by the
// photograph and nothing else: a panorama is one, so there is no second kind of owner.
//
// Every photograph gets its rows the moment it is inserted (renditionTriggers), saying it owes both
// passes. That keeps the owed set small enough to drive a query from: idx_renditions_owed holds
// only what is outstanding, so the sync status poll costs a walk of that rather than of the whole
// catalogue.
//
// built_from is a stamp rather than a wall clock, because "is this stale" cannot be asked of
// built_at: the edit is timed on whichever peer made it and the build on whichever peer holds the
// original, and those are routinely not the same machine. A clock a minute out either way then
// hides an edit for good or refuses a correct render forever, both silently, and a minute is well
// inside what the HLC is built to absorb.
//
// Per variant, because the copies are written at different moments: a stamp shared between any two
// of them lets whichever was built last vouch for the rest. Per peer, and so replicated by nothing.
export const renditions = sqliteTable(
  'renditions',
  {
    photoId: text('photo_id').notNull(),
    variant: text('variant').notNull(),
    needsBuild: integer('needs_build').notNull().default(0),
    builtAt: text('built_at'),
    builtFrom: text('built_from'),
    // What the library asks for is libraries.rendition_source; only this says what is on disk right
    // now. A tile is written off the camera's JPEG at import and rewritten from the render when the
    // queue reaches it. Null reads as "unknown" rather than as either answer.
    source: text('source'),
    // Whether the render behind it was warped into the camera's own geometry by the match (§10.8).
    // The recipe's lens table maps the camera's picture to the sensor, so a plane that is not the
    // camera's picture is not the space the table starts in, which is the difference between a
    // render a panorama can be aligned on and one it cannot.
    matched: integer('matched'),
  },
  (t) => [
    primaryKey({ columns: [t.photoId, t.variant] }),
    check('renditions_source', oneOf(t.source, RENDITION_SOURCES)),
    index('idx_renditions_owed')
      .on(t.variant)
      .where(sql`${t.needsBuild} = 1`),
  ],
);

// Renditions this peer fetched from another rather than building (§7.9), and when each was last
// served. A device holding no originals cannot rebuild any of these, so they are a cache with no
// floor under it: browsing a 40,000-photo library would otherwise leave 40,000 tiles behind. Only
// fetched files are listed; a rendition this peer built is the pipeline's, and the pipeline's own
// sweep owns it.
export const fetchedRenditions = sqliteTable(
  'fetched_renditions',
  {
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    rendition: text('rendition').notNull(),
    hdr: integer('hdr').notNull(),
    bytes: integer('bytes').notNull(),
    usedAt: text('used_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.photoId, t.rendition, t.hdr] }),
    index('idx_fetched_renditions_used').on(t.libraryId, t.usedAt),
  ],
);
