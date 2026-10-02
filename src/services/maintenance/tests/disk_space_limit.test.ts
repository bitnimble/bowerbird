import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import {
  built,
  db,
  limit,
  photo,
  renditions,
  usedAt,
  usingDiskSpaceLimit,
} from './disk_space_limit_test_helpers';

const LIB = 'disk-space-limit-test';
const GIB = 1024 ** 3;

usingDiskSpaceLimit(LIB);

describe('the disk space limit', () => {
  it('evicts the least recently used renditions until under the limit, never a grid tile', async () => {
    for (const id of ['p1', 'p2', 'p3']) photo(id);
    const tile = built('p1', 'grid', 100, '2026-01-01T00:00:00.000Z');
    const p1 = built('p1', 'full', 100, '2026-01-02T00:00:00.000Z');
    const p2 = built('p2', 'full', 100, '2026-01-03T00:00:00.000Z');
    const p3 = built('p3', 'max', 100, '2026-01-04T00:00:00.000Z');
    // Viewed after the others were built, so p2 becomes the oldest.
    renditions.markUsed('p1', 'full', '2026-01-05T00:00:00.000Z');

    expect(await limit.enforce(250)).toBe(200);

    expect(existsSync(tile)).toBe(true);
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(false);
    expect(existsSync(p3)).toBe(false);
    expect(renditions.stamps('p2', 'full')).toEqual({
      built_at: '2026-01-03T00:00:00.000Z',
      built_from: 'p2-edits',
    });
    expect(renditions.leastRecentlyUsed(10).map((copy) => copy.photo_id)).toEqual(['p1']);
    expect(new LibrariesRepository(db).getById(LIB)?.rendered_photo_count).toBe(1);
  });

  it('leaves everything while under the limit', async () => {
    photo('p1');
    const file = built('p1', 'full', 100, '2026-01-01T00:00:00.000Z');

    expect(await limit.enforce(100)).toBe(0);

    expect(existsSync(file)).toBe(true);
  });

  it('stays over the limit rather than evict a grid tile', async () => {
    photo('p1');
    const tile = built('p1', 'grid', 100, '2026-01-01T00:00:00.000Z');

    expect(await limit.enforce(0)).toBe(0);

    expect(existsSync(tile)).toBe(true);
  });

  it('stops the fetched-rendition cache counting only the copies it evicted', async () => {
    photo('p1');
    photo('p2');
    built('p1', 'full', 100, '2026-01-01T00:00:00.000Z', true);
    built('p2', 'full', 100, '2026-01-02T00:00:00.000Z');
    const fetched = db.query(
      `INSERT INTO fetched_renditions (library_id, photo_id, rendition, hdr, bytes, used_at)
         VALUES (?, ?, ?, ?, 100, '2026-01-01T00:00:00.000Z')`,
    );
    fetched.run(LIB, 'p1', 'full', 1);
    fetched.run(LIB, 'p1', 'full', 0);
    fetched.run(LIB, 'p2', 'full', 0);

    expect(await limit.enforce(100)).toBe(100);

    expect(
      db.query('SELECT photo_id, hdr FROM fetched_renditions ORDER BY photo_id, hdr').all(),
    ).toEqual([
      { photo_id: 'p1', hdr: 0 },
      { photo_id: 'p2', hdr: 0 },
    ]);
  });

  it('counts a copy again once it is rebuilt, and not while it is gone', async () => {
    photo('p1');
    built('p1', 'full', 100, '2026-01-01T00:00:00.000Z');
    await limit.enforce(0);

    renditions.markUsed('p1', 'full', '2026-01-02T00:00:00.000Z');
    expect(renditions.leastRecentlyUsed(10)).toEqual([]);

    built('p1', 'full', 100, '2026-01-03T00:00:00.000Z');
    expect(renditions.leastRecentlyUsed(10)).toEqual([
      { photo_id: 'p1', variant: 'full', used_at: '2026-01-03T00:00:00.000Z', library_id: LIB },
    ]);
  });

  it('stops counting a copy whose build is forgotten', () => {
    photo('p1');
    built('p1', 'full', 100, '2026-01-01T00:00:00.000Z');

    renditions.forgetBuilt('p1', ['full']);

    expect(renditions.leastRecentlyUsed(10)).toEqual([]);
    expect(new LibrariesRepository(db).getById(LIB)?.rendered_photo_count).toBe(0);
  });

  it('marks a copy used at most once a minute', () => {
    photo('p1');
    built('p1', 'full', 100, '2026-01-01T00:00:00.000Z');

    renditions.markUsed('p1', 'full', '2026-01-01T00:00:30.000Z');
    expect(usedAt('p1', 'full')).toBe('2026-01-01T00:00:00.000Z');
    renditions.markUsed('p1', 'full', '2026-01-01T00:01:00.000Z');
    expect(usedAt('p1', 'full')).toBe('2026-01-01T00:00:00.000Z');
    renditions.markUsed('p1', 'full', '2026-01-01T00:01:01.000Z');
    expect(usedAt('p1', 'full')).toBe('2026-01-01T00:01:01.000Z');
  });

  it('holds to a limit changed while a pass is running, and ignores an unchanged one', async () => {
    const limits: number[] = [];
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    limit.enforce = async (limitBytes) => {
      limits.push(limitBytes);
      await blocked;
      return 0;
    };

    limit.configure(5);
    limit.configure(5);
    limit.configure(1);
    release();
    await Bun.sleep(0);

    expect(limits).toEqual([5 * GIB, 1 * GIB]);
  });
});
