import { describe, it, expect } from 'bun:test';
import { Database } from '../driver';
import { runMigrations } from '../migrate';
import { config } from '../../config';
import { computeFileHash } from '../../utils/hash';

function settingsFor(db: Database, keys: string[]): Record<string, string> {
  const rows = db.query('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(
    rows.filter((row) => keys.includes(row.key)).map((row) => [row.key, row.value]),
  );
}

function objectsOfType(db: Database, type: 'table' | 'index' | 'trigger'): string[] {
  return (
    db
      .query(
        `SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all(type) as { name: string }[]
  ).map((row) => row.name);
}

function beforePhotoLinks(db: Database): void {
  db.exec("DELETE FROM __drizzle_migrations WHERE hash = '0020_photo_links'");
  for (const trigger of [
    'photos_link_ins',
    'photos_link_upd',
    'photos_unlink',
    'photos_share_stamp_triage',
    'photos_share_stamp_hidden',
  ])
    db.exec(`DROP TRIGGER ${trigger}`);
  db.exec('DROP TABLE photo_links');
}

describe('opening a catalogue', () => {
  it('preserves disabled camera matching across the render-stage migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec("DELETE FROM __drizzle_migrations WHERE hash = '0007_camera_match_stages'");
    db.query(
      'INSERT INTO libraries (id, root_path, name, render_skip_full, render_skip_max) VALUES (?, ?, ?, ?, ?)',
    ).run('stages', '/stages', 'Stages', 'dust,match,sharpen', 'denoise,match');
    db.query(
      'INSERT INTO libraries (id, root_path, name, render_skip_full) VALUES (?, ?, ?, ?)',
    ).run('exact', '/exact', 'Exact', 'mismatch');

    runMigrations(db);

    expect(
      db
        .query('SELECT render_skip_full, render_skip_max FROM libraries WHERE id = ?')
        .get('stages'),
    ).toEqual({
      render_skip_full: 'dust,lens,colour,sharpen',
      render_skip_max: 'denoise,lens,colour',
    });
    expect(
      db.query('SELECT render_skip_full, render_skip_max FROM libraries WHERE id = ?').get('exact'),
    ).toEqual({
      render_skip_full: 'mismatch',
      render_skip_max: '',
    });
    db.close();
  });

  it('rehashes every scanned photo from its stat, so a moved file still pairs with its row', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec("DELETE FROM __drizzle_migrations WHERE hash = '0018_stat_file_hash'");
    db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run('lib', '/l', 'L');
    const insert = db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added, file_hash, date_updated, file_size)
         VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), 6000, 4000, '2026-01-01T00:00:00.000Z', ?, ?, ?)`,
    );
    insert.run('scanned', 'Trip/A.ARW', 'header-hash', '2026-02-03T04:05:06.789Z', 81_000_000);
    insert.run('unscanned', 'Trip/b.arw', null, null, null);

    runMigrations(db);

    const hashOf = (id: string): unknown =>
      (db.query('SELECT file_hash FROM photos WHERE id = ?').get(id) as { file_hash: unknown })
        .file_hash;
    expect(hashOf('scanned')).toBe(
      computeFileHash('elsewhere/a.arw', {
        mtime: '2026-02-03T04:05:06.789Z',
        fileSize: 81_000_000,
      }),
    );
    expect(hashOf('unscanned')).toBeNull();
    db.close();
  });

  it('names camera files as their RAWs do, links the pairs, and gives each pair the later marks', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    beforePhotoLinks(db);
    db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run('lib', '/l', 'L');
    const insert = db.query(
      `INSERT INTO photos (id, library_id, recipe, format, width, height, date_added, date_taken,
                           camera_make, camera_model, rating, triage, stamp_triage)
         VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), ?, 6000, 4000, '2026-01-01',
                 '2026-03-04T05:06:07.000Z', ?, ?, ?, ?, ?)`,
    );
    insert.run('raw', 'Trip/IMG_0001.CR2', 'cr2', 'Canon', 'EOS 100D', 0, null, null);
    insert.run('jpeg', 'Trip/IMG_0001.JPG', 'jpeg', 'Canon', 'Canon EOS 100D', 4, 'picked', '0002');
    insert.run('rated', 'Trip/IMG_0002.CR2', 'cr2', 'Canon', 'EOS 100D', 2, null, '0003');
    insert.run(
      'rated-jpeg',
      'Trip/IMG_0002.JPG',
      'jpeg',
      'Canon',
      'Canon EOS 100D',
      5,
      null,
      '0001',
    );
    insert.run('heif', 'Trip/IMG_0003.HIF', 'heif', 'Canon', 'Canon EOS 100D', 3, null, '0001');
    insert.run('heif-raw', 'Trip/IMG_0003.CR2', 'cr2', 'Canon', 'EOS 100D', 0, null, null);
    insert.run('phone', 'Phone/PXL_1.JPG', 'jpeg', 'Google', 'Pixel 9', 0, null, null);
    db.exec("INSERT INTO albums (id, name) VALUES ('album', 'Album')");
    db.exec(
      "INSERT INTO album_photos (album_id, photo_id, date_added) VALUES ('album', 'jpeg', '2026-02-01')",
    );
    db.exec(
      "INSERT INTO labels (id, library_id, name, colour, position) VALUES ('label', 'lib', 'Keep', 'red', 0)",
    );
    db.exec(
      "INSERT INTO photo_labels (library_id, label_id, photo_id, stamp) VALUES ('lib', 'label', 'jpeg', 'old')",
    );

    runMigrations(db);

    const row = (id: string): unknown =>
      db.query('SELECT camera_make, camera_model, rating, triage FROM photos WHERE id = ?').get(id);
    expect(row('jpeg')).toMatchObject({ camera_make: 'Canon', camera_model: 'EOS 100D' });
    expect(row('phone')).toMatchObject({ camera_make: 'Google', camera_model: 'Pixel 9' });
    expect(
      db.query('SELECT raw_id, camera_file_id FROM photo_links ORDER BY raw_id').all(),
    ).toEqual([
      { raw_id: 'heif-raw', camera_file_id: 'heif' },
      { raw_id: 'rated', camera_file_id: 'rated-jpeg' },
      { raw_id: 'raw', camera_file_id: 'jpeg' },
    ]);
    expect(row('raw')).toMatchObject({ rating: 4, triage: 'picked' });
    expect(row('heif-raw')).toMatchObject({ rating: 3 });
    expect(row('rated')).toMatchObject({ rating: 2, triage: null });
    expect(row('rated-jpeg')).toMatchObject({ rating: 2, triage: null });
    expect(db.query("SELECT photo_id FROM album_photos WHERE photo_id = 'raw'").all()).toEqual([
      { photo_id: 'raw' },
    ]);
    expect(db.query("SELECT photo_id FROM photo_labels WHERE photo_id = 'raw'").all()).toEqual([
      { photo_id: 'raw' },
    ]);
    db.close();
  });

  it('takes each camera file out of the automatic stack it shared with its RAW', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    beforePhotoLinks(db);
    db.query('INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)').run('lib', '/l', 'L');
    const insert = db.query(
      `INSERT INTO photos (id, library_id, recipe, format, width, height, date_added, date_taken,
                           camera_make, camera_model, stack_id, stack_state, is_representative)
         VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), ?, 6000, 4000, '2026-01-01',
                 ?, 'Sony', ?, ?, 'stacked', ?)`,
    );
    const member = db.query(
      "INSERT INTO stack_members (library_id, stack_id, photo_id, stamp) VALUES ('lib', ?, ?, '0001')",
    );
    const stack = db.query(
      "INSERT INTO stacks (id, library_id, origin, date_created, stamp) VALUES (?, 'lib', ?, '2026-01-01', '0001')",
    );
    const at = (second: number): string => `2026-03-04T05:06:0${second}.000Z`;
    stack.run('pair', 'auto');
    insert.run('raw', 'Trip/DSC01.ARW', 'arw', at(1), 'ILCE-7M4', 'pair', 0);
    insert.run('jpeg', 'Trip/DSC01.JPG', 'jpeg', at(1), 'ILCE-7M4', 'pair', 1);
    stack.run('burst', 'auto');
    insert.run('first', 'Trip/DSC02.ARW', 'arw', at(2), 'ILCE-7M4', 'burst', 0);
    insert.run('first-jpeg', 'Trip/DSC02.JPG', 'jpeg', at(2), 'ILCE-7M4', 'burst', 1);
    insert.run('second', 'Trip/DSC03.ARW', 'arw', at(3), 'ILCE-7M4', 'burst', 0);
    stack.run('chosen', 'manual');
    insert.run('kept', 'Trip/DSC04.ARW', 'arw', at(4), 'ILCE-7M4', 'chosen', 0);
    insert.run('kept-jpeg', 'Trip/DSC04.JPG', 'jpeg', at(4), 'ILCE-7M4', 'chosen', 1);
    for (const [stackId, photoId] of [
      ['pair', 'raw'],
      ['pair', 'jpeg'],
      ['burst', 'first'],
      ['burst', 'first-jpeg'],
      ['burst', 'second'],
      ['chosen', 'kept'],
      ['chosen', 'kept-jpeg'],
    ])
      member.run(stackId, photoId);

    runMigrations(db);

    const stacks = (): string[] =>
      (db.query('SELECT id FROM stacks ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    const members = (stackId: string): string[] =>
      (
        db
          .query('SELECT photo_id FROM stack_members WHERE stack_id = ? ORDER BY photo_id')
          .all(stackId) as { photo_id: string }[]
      ).map((r) => r.photo_id);
    const stackOf = (id: string): unknown =>
      db.query('SELECT stack_id, is_representative FROM photos WHERE id = ?').get(id);
    expect(stacks()).toEqual(['burst', 'chosen']);
    expect(stackOf('raw')).toEqual({ stack_id: null, is_representative: 1 });
    expect(stackOf('jpeg')).toEqual({ stack_id: null, is_representative: 1 });
    expect(members('burst')).toEqual(['first', 'second']);
    expect(stackOf('first-jpeg')).toEqual({ stack_id: null, is_representative: 1 });
    expect(members('chosen')).toEqual(['kept', 'kept-jpeg']);
    db.close();
  });

  it('brings up every table, index and trigger, and does it again without complaint', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const first = {
      tables: objectsOfType(db, 'table'),
      indexes: objectsOfType(db, 'index'),
      triggers: objectsOfType(db, 'trigger'),
    };

    // Every start runs this, so running twice is the ordinary case rather than an edge one.
    runMigrations(db);

    expect(first.tables).toContain('photos');
    expect(first.triggers).toContain('photos_owe_renditions');
    expect(first.triggers).toContain('photos_index_inputs_ins');
    expect(first.triggers).toContain('trg_repl_photo_triage_ins');
    // drizzle-kit cannot carry an expression index holding a comma, so this one is registered
    // beside the triggers rather than generated. It is the one most easily lost.
    expect(first.indexes).toContain('idx_photos_path');
    expect({
      tables: objectsOfType(db, 'table'),
      indexes: objectsOfType(db, 'index'),
      triggers: objectsOfType(db, 'trigger'),
    }).toEqual(first);
  });

  // Asserted against the table rather than through `SettingsRepository`, which defaults a missing
  // key and so reads the same either way: what this pins is that the rows are actually there,
  // which is what lets the API hand the defaults out and the client stop carrying its own copy.
  it('writes every shipped default as a row, and keeps a chosen value over one', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const seeded = db.query('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const keys = new Set(seeded.map((row) => row.key));
    // Every key but the ones whose default is null: an absent row is already "nothing chosen",
    // which is what `last_viewer_rendition` is until something is.
    for (const [key, value] of Object.entries(config.defaultSettings)) {
      expect(keys.has(key)).toBe(value != null);
    }
    expect(keys.has('last_viewer_rendition')).toBe(false);
    expect(seeded.find((row) => row.key === 'hdr_reference_white_nits')?.value).toBe('203');
    expect(seeded.find((row) => row.key === 'watch_enabled')?.value).toBe('true');
    expect(seeded.find((row) => row.key === 'cors_origins')?.value).toBe('');

    // `OR IGNORE`, so a re-run cannot put a tuned value back to the default, which is every
    // restart rather than an edge case.
    db.exec("UPDATE settings SET value = '250' WHERE key = 'hdr_reference_white_nits'");
    runMigrations(db);
    expect(settingsFor(db, ['hdr_reference_white_nits'])).toEqual({
      hdr_reference_white_nits: '250',
    });
  });

  it('mints one replication identity and keeps it across restarts', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const first = db.query('SELECT peer_id FROM replication_identity').get() as { peer_id: string };

    runMigrations(db);

    expect(db.query('SELECT COUNT(*) AS n FROM replication_identity').get()).toEqual({ n: 1 });
    expect(
      (db.query('SELECT peer_id FROM replication_identity').get() as { peer_id: string }).peer_id,
    ).toBe(first.peer_id);
  });
});
