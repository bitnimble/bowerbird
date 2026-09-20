import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { oneOf } from './checks';
import { libraries } from './libraries';
import { photos } from './photos';

export const STACK_ORIGINS = ['auto', 'manual'] as const;

// A group of photographs of one shot: a burst, or several takes of a scene (§19). Library-wide, so
// a stack transcends the shoots and albums its members happen to sit in.
//
// The origin column is load-bearing rather than informational. Detection re-runs over
// already-stacked photos so that changing the threshold re-forms stacks, and without it that pass
// would dissolve a manual stack whose members are not alike, which is the case manual stacking
// exists for. A human touching a stack makes it 'manual' and detection lets it be.
export const stacks = sqliteTable(
  'stacks',
  {
    id: text('id').primaryKey(),
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    origin: text('origin').notNull(),
    dateCreated: text('date_created').notNull(),
    stamp: text('stamp'),
    // Apart from the row's own stamp because that one moves whenever anything about the stack is
    // written, and "latest-created" has to keep meaning what it says: it is what decides the
    // surviving id where two peers stacked overlapping sets.
    createdStamp: text('created_stamp'),
  },
  (t) => [
    check('stacks_origin', oneOf(t.origin, STACK_ORIGINS)),
    index('idx_stacks_library').on(t.libraryId),
  ],
);

// Which stack each photograph is in (docs/replication.md §3.3).
//
// A row per membership rather than the pointer on photos, because merging two catalogues has to
// *see* that two peers stacked overlapping sets before it can decide what the union is: a pointer
// holds one stack, so the losing side's membership would be gone before the question could be
// asked, and which photographs ended up stacked would come down to whose clock ran later.
//
// photos.stack_id remains, as this table's materialised view: it is what the listing's stack filter
// reads on every row an index walk visits, where a join would be a b-tree probe per row. Both are
// written by StackMembership and by nothing else.
export const stackMembers = sqliteTable(
  'stack_members',
  {
    libraryId: text('library_id').notNull(),
    stackId: text('stack_id')
      .notNull()
      .references(() => stacks.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    stamp: text('stamp'),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.stackId, t.photoId] }),
    index('idx_stack_members_photo').on(t.photoId),
  ],
);
