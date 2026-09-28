import { describe, it, expect } from 'bun:test';
import { Database } from '../driver';

function blobs(): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE b (id TEXT PRIMARY KEY, bytes BLOB)');
  return db;
}

describe('a BLOB column', () => {
  // libSQL answers `get` with a Buffer and `all` with a bare ArrayBuffer, which has no `length`.
  // Nothing throws on the difference: a caller measuring one reads `undefined` and quietly decides
  // the row is the wrong size. That is how stacking stopped - every descriptor failed the size test
  // in `descriptorsOf` and detection found nothing to stack, with no error anywhere.
  it('is bytes whichever way the row was read', () => {
    const db = blobs();
    const written = new Uint8Array([1, 2, 3, 4, 5]);
    db.run('INSERT INTO b VALUES (?, ?)', ['a', written]);

    const one = db.query('SELECT bytes FROM b WHERE id = ?').get('a') as { bytes: Uint8Array };
    const [first] = db.query('SELECT bytes FROM b').all() as { bytes: Uint8Array }[];

    for (const read of [one.bytes, first!.bytes]) {
      expect(read).toBeInstanceOf(Uint8Array);
      expect(Buffer.isBuffer(read)).toBe(false);
      expect(read.length).toBe(written.length);
      expect([...read]).toEqual([...written]);
    }
    expect(JSON.stringify(one)).toBe(JSON.stringify(first));
  });

  it('is null when no bytes were written', () => {
    const db = blobs();
    db.run('INSERT INTO b VALUES (?, ?)', ['a', null]);
    expect((db.query('SELECT bytes FROM b').all() as { bytes: unknown }[])[0]!.bytes).toBeNull();
  });
});

/**
 * Every shape a statement is bound in, each with exactly one placeholder.
 *
 * One is where they are told apart wrongly. libSQL decides whether it was handed values or a map of
 * names by looking at what it received, and a lone `null` or a lone `Uint8Array` answers `'object'`
 * just as a map does - so a single BLOB bound positionally reached the binding as if it were named
 * and panicked the library, which takes the process with it rather than throwing. Two placeholders
 * never showed it, which is why nothing here binds two.
 */
describe('a statement with one placeholder', () => {
  const one = (): Database => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE p (v)');
    db.run('INSERT INTO p VALUES (NULL)');
    return db;
  };
  const held = (db: Database): unknown => (db.query('SELECT v FROM p').get() as { v: unknown }).v;

  it('binds a lone BLOB by position', () => {
    const db = one();
    db.query('UPDATE p SET v = ?').run(new Uint8Array([9, 9, 9]));
    expect([...(held(db) as Uint8Array)]).toEqual([9, 9, 9]);
  });

  it('binds a lone null by position', () => {
    const db = one();
    db.query('UPDATE p SET v = ?').run('first');
    db.query('UPDATE p SET v = ?').run(null);
    expect(held(db)).toBeNull();
  });

  it('binds a lone value given as an array', () => {
    const db = one();
    db.query('UPDATE p SET v = ?').run(['boxed']);
    expect(held(db)).toBe('boxed');
  });

});

describe('a query that matched nothing', () => {
  it('answers null, as the row types say', () => {
    expect(blobs().query('SELECT bytes FROM b WHERE id = ?').get('missing')).toBeNull();
  });
});
