import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../src/db/driver';
import { runMigrations } from '../../src/db/migrate';
import type { CaptureSequence } from '../../src/schemas/capture_sequence';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotoListingRepository } from '../../src/services/photos/listing/photo_listing_repository';
import { descriptorFormat, descriptorSize } from '../../src/services/processing/rawshim/rawshim_ops';
import { SettingsRepository } from '../../src/services/settings/settings_repository';
import { StacksRepository } from '../../src/services/stacks/stacks_repository';
import { StacksService } from '../../src/services/stacks/stacks_service';

const LIBRARY = 'lib00001';
const ORDERING = 'taken_desc' as const;

let db: Database;
let stacks: StacksService;
let repo: StacksRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIBRARY, '/tmp/lib', 'lib', ORDERING);
  repo = new StacksRepository(db);
  stacks = new StacksService(repo, new PhotoListingRepository(db), new LibrariesRepository(db), new SettingsRepository(db));
});

/** A photograph `second` seconds into the day, identical in likeness to every other one here. */
function insertPhoto(n: number, second: number, sequence: CaptureSequence | null = null): string {
  const id = `photo${String(n).padStart(3, '0')}`;
  const taken = new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const descriptor = Buffer.alloc(descriptorSize());
  descriptor[0] = descriptorFormat();
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_taken, date_added, descriptor, capture_sequence)
     VALUES (?, ?, json_object('kind', 'file', 'path', ?), 3000, 2000, ?, ?, ?, ?)`,
  ).run(id, LIBRARY, `DSC${n}.ARW`, taken, taken, descriptor, sequence == null ? null : JSON.stringify(sequence));
  return id;
}

function pixelShift(n: number, second: number, index: number): string {
  return insertPhoto(n, second, { kind: 'pixelShift', group: 4242, index, count: 4 });
}

function stackOf(photoId: string): { id: string; origin: string } | null {
  return db.query('SELECT stacks.id, stacks.origin FROM photos JOIN stacks ON stacks.id = photos.stack_id WHERE photos.id = ?').get(photoId) as {
    id: string;
    origin: string;
  } | null;
}

describe('bracket stacks', () => {
  test('a pixel shift is a stack of exactly its four frames, whatever looks like it nearby', () => {
    const before = insertPhoto(1, 0);
    const burst = [1, 2, 3, 4].map((index) => pixelShift(10 + index, index, index));
    const after = insertPhoto(20, 6);

    stacks.detect(LIBRARY);

    const stack = stackOf(burst[0]!);
    expect(stack?.origin).toBe('bracket');
    expect(repo.memberIds(stack!.id, ORDERING).sort()).toEqual([...burst].sort());
    // The neighbours are byte-identical in likeness and within the window, so the likeness pass
    // stacks them - with each other, never into the burst.
    expect(stackOf(before)?.origin).toBe('auto');
    expect(stackOf(before)?.id).toBe(stackOf(after)?.id);
  });

  test('a looser likeness pass leaves the bracket stack exactly as it was', () => {
    const burst = [1, 2, 3, 4].map((index) => pixelShift(index, index, index));
    insertPhoto(9, 5);
    stacks.detect(LIBRARY);
    const stack = stackOf(burst[0]!)!;

    db.query('UPDATE libraries SET auto_stack_similarity = 0 WHERE id = ?').run(LIBRARY);
    stacks.detect(LIBRARY);

    expect(stackOf(burst[0]!)).toEqual(stack);
    expect(repo.memberIds(stack.id, ORDERING)).toHaveLength(4);
  });

  test('a second pass over a settled library writes nothing', () => {
    const burst = [1, 2, 3, 4].map((index) => pixelShift(index, index, index));
    stacks.detect(LIBRARY);
    const stack = stackOf(burst[0]!);
    const stamps = db.query('SELECT stamp FROM stacks').all();

    stacks.detect(LIBRARY);

    expect(stackOf(burst[0]!)).toEqual(stack);
    expect(db.query('SELECT stamp FROM stacks').all()).toEqual(stamps);
  });

  test('forms even where automatic stacking is off', () => {
    const burst = [1, 2, 3, 4].map((index) => pixelShift(index, index, index));
    db.query('UPDATE libraries SET auto_stack = 0 WHERE id = ?').run(LIBRARY);

    stacks.detect(LIBRARY);

    expect(stackOf(burst[0]!)?.origin).toBe('bracket');
  });

  test('takes its frames out of an automatic stack', () => {
    const burst = [1, 2, 3, 4].map((index) => pixelShift(index, index, index));
    repo.create('auto1', LIBRARY, 'auto', '2026-01-01');
    repo.addPhotos('auto1', burst.slice(0, 2));

    stacks.detect(LIBRARY);

    expect(stackOf(burst[0]!)?.origin).toBe('bracket');
    expect(repo.get('auto1')).toBeNull();
  });

  test('leaves a capture alone when a person has placed one of its frames', () => {
    const burst = [1, 2, 3, 4].map((index) => pixelShift(index, index, index));
    const mine = stacks.create([burst[0]!, insertPhoto(9, 60)]);

    stacks.detect(LIBRARY);

    expect(stackOf(burst[0]!)?.id).toBe(mine.id);
    expect(stackOf(burst[1]!)?.origin).not.toBe('bracket');
  });

  test('leaves a capture alone when a person pulled one of its frames out of a stack', () => {
    const burst = [1, 2, 3, 4].map((index) => pixelShift(index, index, index));
    db.query("UPDATE photos SET stack_state = 'unstacked' WHERE id = ?").run(burst[3]!);

    stacks.detect(LIBRARY);

    expect(stackOf(burst[0]!)?.origin).not.toBe('bracket');
  });

  test('a person editing a bracket stack makes it theirs', () => {
    const burst = [1, 2, 3, 4].map((index) => pixelShift(index, index, index));
    stacks.detect(LIBRARY);
    const stack = stackOf(burst[0]!)!;

    stacks.removePhotos(stack.id, [burst[3]!]);
    stacks.detect(LIBRARY);

    expect(stackOf(burst[0]!)).toEqual({ id: stack.id, origin: 'manual' });
    expect(stackOf(burst[3]!)).toBeNull();
  });
});
