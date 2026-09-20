import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { OrderingSchema } from '../../schemas/common';
import { oneOf } from './checks';
import { photos } from './photos';

export const albums = sqliteTable(
  'albums',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ordering: text('ordering').notNull().default('taken_asc'),
  },
  (t) => [check('albums_ordering', oneOf(t.ordering, OrderingSchema.options))],
);

export const albumPhotos = sqliteTable(
  'album_photos',
  {
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    dateAdded: text('date_added').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.albumId, t.photoId] }),
    index('idx_album_photos_photo').on(t.photoId),
  ],
);

export const albumBanners = sqliteTable(
  'album_banners',
  {
    albumId: text('album_id')
      .primaryKey()
      .references(() => albums.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
  },
  (t) => [index('idx_album_banners_photo').on(t.photoId)],
);
