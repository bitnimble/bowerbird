import { expect, test } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { LibraryActivity } from '../../activity/library_activity';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import { descriptorFormat, descriptorSize } from '../../processing/rawshim/rawshim_ops';
import { SettingsRepository } from '../../settings/settings_repository';
import { StacksRepository } from '../stacks_repository';
import { StacksService } from '../stacks_service';

const LIBRARY = 'lib00001';

function context(takenAtSeconds = [0, 1, 120, 121]): {
  db: Database;
  activity: LibraryActivity;
  stacks: StacksService;
  repository: StacksRepository;
} {
  const db = new Database(':memory:');
  runMigrations(db);
  db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run(
    LIBRARY,
    '/tmp/grouping',
    'Grouping',
  );
  const descriptor = Buffer.alloc(descriptorSize());
  descriptor[0] = descriptorFormat();
  for (const [index, seconds] of takenAtSeconds.entries()) {
    const taken = new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_taken, date_added, descriptor)
      VALUES (?, ?, json_object('kind', 'file', 'path', ?), 3000, 2000, ?, ?, ?)`,
    ).run(`photo00${index}`, LIBRARY, `${index}.ARW`, taken, taken, descriptor);
  }
  const activity = new LibraryActivity();
  const repository = new StacksRepository(db);
  const stacks = new StacksService(
    repository,
    new PhotoListingRepository(db),
    new LibrariesRepository(db),
    new SettingsRepository(db),
    activity,
  );
  return { db, activity, stacks, repository };
}

test('frames 60 seconds apart stack and frames 61 seconds apart do not', async () => {
  const { db, stacks, repository } = context([0, 60, 121]);
  try {
    expect(await stacks.detectAsync(LIBRARY)).toBe(1);
    const [stack] = repository.autoStackIds(LIBRARY);
    expect(repository.memberIds(stack!, 'taken_asc')).toEqual(['photo000', 'photo001']);
  } finally {
    db.close();
  }
});

test('manual detection stays visible while a worker groups, then clears after the result', async () => {
  const { db, activity, stacks, repository } = context();
  try {
    const first = stacks.detectAsync(LIBRARY);
    const second = stacks.detectAsync(LIBRARY);
    expect(activity.current(LIBRARY)).toEqual([{ kind: 'grouping', count: 1 }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(activity.current(LIBRARY)).toEqual([{ kind: 'grouping', count: 1 }]);
    expect(await first).toBe(2);
    expect(await second).toBe(2);
    expect(repository.autoStackIds(LIBRARY)).toHaveLength(2);
    expect(activity.current(LIBRARY)).toEqual([]);
  } finally {
    db.close();
  }
});

test('a manual stack made during detection stays manual when the worker returns', async () => {
  const { db, activity, stacks, repository } = context();
  try {
    const detection = stacks.detectAsync(LIBRARY);
    const manual = stacks.create(['photo000', 'photo001']);
    expect(await detection).toBe(1);
    expect(repository.get(manual.id)?.origin).toBe('manual');
    expect(repository.memberIds(manual.id, 'taken_desc').sort()).toEqual(['photo000', 'photo001']);
    expect(repository.autoStackIds(LIBRARY)).toHaveLength(1);
    expect(activity.current(LIBRARY)).toEqual([]);
  } finally {
    db.close();
  }
});

test('photos arriving during detection are included before automatic stacks are written', async () => {
  const { db, stacks, repository } = context();
  try {
    const detection = stacks.detectAsync(LIBRARY);
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_taken, date_added, descriptor)
      SELECT 'photo004', library_id, json_object('kind', 'file', 'path', '4.ARW'), width, height, date_taken, date_added, descriptor
      FROM photos WHERE id = 'photo003'`,
    ).run();
    expect(await detection).toBe(2);
    const groups = repository.autoStackIds(LIBRARY);
    expect(groups.map((id) => repository.memberIds(id, 'taken_desc').length).sort()).toEqual([
      2, 3,
    ]);
  } finally {
    db.close();
  }
});

test('a descriptor rebuilt during detection is compared before its stack is written', async () => {
  const { db, stacks, repository } = context();
  try {
    const detection = stacks.detectAsync(LIBRARY);
    const descriptor = Buffer.alloc(descriptorSize());
    descriptor[0] = descriptorFormat() ^ 0xff;
    stacks.storeDescriptor('photo001', descriptor);
    expect(await detection).toBe(1);
    expect(repository.autoStackIds(LIBRARY)).toHaveLength(1);
  } finally {
    db.close();
  }
});
