import { Database } from '../driver';
import { describe, it, expect } from 'bun:test';
import { unusedId, withNewId } from '../constraints';
import { IdSchema } from '../../schemas/common';
import { newId } from '../../schemas/id';

function table(): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT UNIQUE)');
  return db;
}

describe('withNewId', () => {
  it('mints an id of the shape the schemas accept', () => {
    const db = table();
    const id = withNewId((candidate) => db.run('INSERT INTO t VALUES (?, ?)', [candidate, 'a']));
    expect(IdSchema.parse(id)).toBe(id);
    expect(db.query('SELECT id FROM t').all()).toEqual([{ id }]);
  });

  it('draws again when the id is taken, and returns the one that landed', () => {
    const db = table();
    const taken = withNewId((candidate) => db.run('INSERT INTO t VALUES (?, ?)', [candidate, 'a']));

    let draws = 0;
    const id = withNewId((candidate) => {
      draws++;
      db.run('INSERT INTO t VALUES (?, ?)', [draws < 3 ? taken : candidate, 'b']);
    });

    expect(draws).toBe(3);
    expect(db.query('SELECT id FROM t WHERE name = ?').all('b')).toEqual([{ id }]);
  });

  it('gives up after five draws', () => {
    const db = table();
    const taken = withNewId((candidate) => db.run('INSERT INTO t VALUES (?, ?)', [candidate, 'a']));

    let draws = 0;
    expect(() => {
      withNewId(() => {
        draws++;
        db.run('INSERT INTO t VALUES (?, ?)', [taken, 'b']);
      });
    }).toThrow(/UNIQUE constraint failed: t\.id/);
    expect(draws).toBe(5);
  });

  it('skips an id already taken, for a caller that commits before the insert', () => {
    const taken = new Set<string>();
    let draws = 0;
    const id = unusedId((candidate) => {
      draws++;
      if (draws < 3) taken.add(candidate);
      return taken.has(candidate);
    });

    expect(draws).toBe(3);
    expect(taken.has(id)).toBe(false);
  });

  it('does not spend draws on a violation of some other unique column', () => {
    const db = table();
    withNewId((candidate) => db.run('INSERT INTO t VALUES (?, ?)', [candidate, 'a']));

    let attempts = 0;
    expect(() => {
      withNewId((candidate) => {
        attempts++;
        db.run('INSERT INTO t VALUES (?, ?)', [candidate, 'a']);
      });
    }).toThrow(/UNIQUE constraint failed: t\.name/);
    expect(attempts).toBe(1);
  });
});

describe('newId', () => {
  // A capital would make two distinct ids one rendition file on macOS and Windows.
  it('never draws a character outside the case-safe alphabet', () => {
    for (let i = 0; i < 2000; i++) expect(newId()).toMatch(/^[a-z0-9]{16}$/);
  });
});
