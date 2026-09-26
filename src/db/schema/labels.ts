import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { libraries } from './libraries';
import { photos } from './photos';

// A library's own labels, in the order the reader arranged them (docs/replication.md §3.2).
//
// No unique index on the name. Two peers creating the same name while apart is a state neither
// could refuse, and a unique index would defer the second row on every session for good; the
// service refuses a duplicate where it is made instead.
export const labels = sqliteTable(
  'labels',
  {
    id: text('id').primaryKey(),
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    colour: text('colour').notNull(),
    position: integer('position').notNull(),
    stamp: text('stamp'),
    stampPosition: text('stamp_position'),
  },
  (t) => [index('idx_labels_library').on(t.libraryId)],
);

export const photoLabels = sqliteTable(
  'photo_labels',
  {
    libraryId: text('library_id').notNull(),
    labelId: text('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    stamp: text('stamp'),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.labelId, t.photoId] }),
    index('idx_photo_labels_photo').on(t.photoId, t.labelId),
  ],
);
