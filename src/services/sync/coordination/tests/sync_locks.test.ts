import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '../../../../db/connection';
import { LEASE_MS, SyncLocksRepository } from '../sync_locks_repository';

const LIB = 'lib00100';

let db: ReturnType<typeof createDatabase>;
let locks: SyncLocksRepository;

beforeEach(() => {
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run(LIB, '/tmp/lib', 'lib');
  locks = new SyncLocksRepository(db);
});

afterEach(() => db.close());

describe('the sync lease', () => {
  it('is held by one owner at a time', () => {
    expect(locks.acquire(LIB, 'a')).toBe(true);
    expect(locks.acquire(LIB, 'b')).toBe(false);
    expect(locks.ownerOf(LIB)).toBe('a');
  });

  it('is reclaimed once it has expired, and not before', () => {
    const start = new Date('2026-08-06T00:00:00.000Z');
    expect(locks.acquire(LIB, 'a', start)).toBe(true);

    const nearly = new Date(start.getTime() + LEASE_MS - 5_000);
    expect(locks.acquire(LIB, 'b', nearly)).toBe(false);

    const past = new Date(start.getTime() + LEASE_MS + 1_000);
    expect(locks.acquire(LIB, 'b', past)).toBe(true);
    expect(locks.ownerOf(LIB)).toBe('b');
  });

  it('is kept alive by a refresh from its own owner and nobody else', () => {
    const start = new Date('2026-08-06T00:00:00.000Z');
    locks.acquire(LIB, 'a', start);
    locks.refresh(LIB, 'b', new Date(start.getTime() + 20_000)); // not the holder: no effect
    expect(locks.acquire(LIB, 'c', new Date(start.getTime() + LEASE_MS + 1_000))).toBe(true);

    const retaken = new Date(start.getTime() + LEASE_MS + 1_000);
    locks.refresh(LIB, 'c', new Date(retaken.getTime() + 20_000));
    expect(locks.acquire(LIB, 'd', new Date(retaken.getTime() + LEASE_MS + 1_000))).toBe(false);
  });

  // A run whose lease lapsed and whose `finally` then fires must not take its
  // successor's lock down with it.
  it('cannot be released by anyone but its current owner', () => {
    locks.acquire(LIB, 'a');
    locks.release(LIB, 'b');
    expect(locks.ownerOf(LIB)).toBe('a');
    locks.release(LIB, 'a');
    expect(locks.ownerOf(LIB)).toBeNull();
  });
});
