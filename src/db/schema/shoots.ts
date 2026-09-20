import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import { OrderingSchema } from '../../schemas/common';
import { oneOf } from './checks';
import { libraries } from './libraries';
import { photos } from './photos';

export const shoots = sqliteTable(
  'shoots',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id').references((): AnySQLiteColumn => shoots.id, {
      onDelete: 'cascade',
    }),
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    folderPath: text('folder_path').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ordering: text('ordering').notNull().default('taken_asc'),
    // The folder's identity apart from its path, so a rename on disk is recognised rather than
    // read as a delete plus a create (§9.4.1). NULL until first seen. The device is half the key:
    // inode numbers are only unique within one filesystem, and a library with a second volume
    // mounted inside it would otherwise match a shoot against an unrelated folder.
    folderDev: integer('folder_dev'),
    folderIno: integer('folder_ino'),
    folderBirthtime: real('folder_birthtime'),
    // Gone from the shoots tree, and its photographs gone from every listing with it (§12.4).
    isHidden: integer('is_hidden').notNull().default(0),
    stamp: text('stamp'),
    // Its own stamp rather than riding `stamp`: a folder rename rewrites `folder_path` on a whole
    // subtree, and a shared stamp would let that clobber a hide made on another peer meanwhile.
    stampHidden: text('stamp_hidden'),
    // Where the folder is, apart from everything else about the shoot. Only the scan writes it, by
    // following a rename on disk (§9.4.1) - a different hand from the one that labels or sorts a
    // shoot, which is what §3 asks of a unit. It also has to be settled when two peers rename onto
    // one name, and a resolution that moved the shared stamp would assert that the label and the
    // ordering were rewritten at that moment too, discarding an edit to either that was still in
    // flight (docs/replication.md §5.6).
    stampFolder: text('stamp_folder'),
  },
  (t) => [
    // A shoot is its folder; the name is a label on it. Two shoots in one folder is the collision
    // worth refusing, and it is this one stated directly.
    unique().on(t.libraryId, t.folderPath),
    check('shoots_ordering', oneOf(t.ordering, OrderingSchema.options)),
    index('idx_shoots_library').on(t.libraryId),
    index('idx_shoots_parent').on(t.parentId),
    // What every listing's hidden clause reads, and on a library that hides nothing it is empty.
    index('idx_shoots_hidden').on(t.isHidden).where(sql`${t.isHidden} = 1`),
    index('idx_shoots_identity').on(
      t.libraryId,
      t.folderPath,
      t.id,
      t.folderDev,
      t.folderIno,
      t.folderBirthtime,
    ),
  ],
);

export const shootBanners = sqliteTable(
  'shoot_banners',
  {
    shootId: text('shoot_id')
      .primaryKey()
      .references(() => shoots.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    stamp: text('stamp'),
  },
  (t) => [index('idx_shoot_banners_photo').on(t.photoId)],
);
