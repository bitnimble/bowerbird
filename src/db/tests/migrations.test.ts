import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../migrations';

// The photos table as it stood before the import's two passes were tracked
// separately: one pending flag and one written-at stamp for the whole photo.
const OLD_PHOTOS = `
CREATE TABLE photos (
  id                TEXT PRIMARY KEY,
  library_id        TEXT NOT NULL,
  -- Carried by every real database of this vintage, and the schema's own indexes
  -- are built on them, so a fixture without them fails before the migration runs.
  shoot_id          TEXT,
  file_hash         TEXT,
  file_path         TEXT NOT NULL,
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  date_taken        TEXT,
  date_added        TEXT NOT NULL,
  is_missing        INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  date_reprocessed  TEXT,
  needs_processing  INTEGER NOT NULL DEFAULT 1,
  rendition_source  TEXT,
  preview_rendition TEXT
);
CREATE INDEX idx_photos_needs_processing ON photos(needs_processing) WHERE needs_processing = 1;
`;

// The library columns and settings keys as they stood while a rendition was
// called a preview.
const OLD_PREVIEW_NAMES = `
CREATE TABLE libraries (
  id                TEXT PRIMARY KEY,
  root_path         TEXT NOT NULL UNIQUE,
  data_path         TEXT,
  preview_source    TEXT NOT NULL DEFAULT 'embedded',
  preview_hdr       INTEGER NOT NULL DEFAULT 0,
  preview_hdr_video INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function oldDatabase(): Database {
  const db = new Database(':memory:');
  db.exec(OLD_PHOTOS);
  db.exec(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added, date_reprocessed, needs_processing)
     VALUES ('built', 'lib', 'a.arw', 100, 100, '2026-01-01T00:00:00.000Z', '2026-02-02T03:04:05.000Z', 0),
            ('pending', 'lib', 'b.arw', 100, 100, '2026-01-01T00:00:00.000Z', NULL, 1)`,
  );
  return db;
}

function columns(db: Database, table = 'photos'): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

describe('migrations: splitting the import into two stages', () => {
  it('carries a photo that was fully processed over as done, at the stamp it had', () => {
    const db = oldDatabase();
    runMigrations(db);

    const row = db.query("SELECT * FROM photos WHERE id = 'built'").get() as Record<string, unknown>;
    // Both stages are behind it, and both name the only time the old column knew.
    // Guessing "never built" instead would re-import a whole catalogue; leaving the
    // stamps null would make every image URL plain and every browser cache stale.
    expect(row.needs_tile).toBe(0);
    expect(row.needs_renditions).toBe(0);
    expect(row.tile_built_at).toBe('2026-02-02T03:04:05.000Z');
    expect(row.renditions_built_at).toBe('2026-02-02T03:04:05.000Z');
  });

  it('carries a photo that was still queued over as owing both passes', () => {
    const db = oldDatabase();
    runMigrations(db);

    const row = db.query("SELECT * FROM photos WHERE id = 'pending'").get() as Record<string, unknown>;
    expect(row.needs_tile).toBe(1);
    expect(row.needs_renditions).toBe(1);
    expect(row.tile_built_at).toBeNull();
  });

  it('drops the columns it replaced, and its index with them', () => {
    const db = oldDatabase();
    runMigrations(db);

    const cols = columns(db);
    expect(cols.has('needs_processing')).toBe(false);
    expect(cols.has('date_reprocessed')).toBe(false);
    // SQLite refuses to drop a column an index is built on, so the index has to go
    // first - and a migration that half-applied would leave the table unusable.
    const indexes = (db.query('PRAGMA index_list(photos)').all() as { name: string }[]).map((i) => i.name);
    expect(indexes).not.toContain('idx_photos_needs_processing');
    expect(indexes).toContain('idx_photos_needs_tile');
  });

  it('runs again over its own output without complaint', () => {
    const db = oldDatabase();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect((db.query("SELECT tile_built_at FROM photos WHERE id = 'built'").get() as { tile_built_at: string }).tile_built_at).toBe(
      '2026-02-02T03:04:05.000Z',
    );
  });

  it('renames the preview-named columns and settings keys, keeping their values', () => {
    const db = new Database(':memory:');
    db.exec(OLD_PREVIEW_NAMES);
    db.exec(
      `INSERT INTO libraries (id, root_path, preview_source, preview_hdr, preview_hdr_video) VALUES ('lib', '/photos', 'render', 1, 1);
       INSERT INTO settings (key, value) VALUES ('preview_rendition_mode', 'max'), ('last_preview_rendition', 'full')`,
    );
    db.exec(OLD_PHOTOS);
    db.exec(
      `INSERT INTO photos (id, library_id, file_path, width, height, date_added, preview_rendition)
       VALUES ('p', 'lib', 'a.arw', 100, 100, '2026-01-01T00:00:00.000Z', 'max')`,
    );

    runMigrations(db);

    expect(columns(db).has('preview_rendition')).toBe(false);
    expect(db.query("SELECT viewer_rendition FROM photos WHERE id = 'p'").get()).toEqual({ viewer_rendition: 'max' });
    expect(db.query("SELECT rendition_source, rendition_hdr FROM libraries WHERE id = 'lib'").get()).toEqual({
      rendition_source: 'render',
      rendition_hdr: 1,
    });
    // The video setting is gone rather than renamed: Firefox's twin is made in
    // the browser now, so there is nothing for it to turn on (§10.7).
    expect(columns(db, 'libraries').has('preview_hdr_video')).toBe(false);
    expect(columns(db, 'libraries').has('rendition_hdr_video')).toBe(false);
    expect(db.query('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
      { key: 'last_viewer_rendition', value: 'full' },
      { key: 'viewer_rendition_mode', value: 'max' },
    ]);
  });

  it('splits a tuned denoise into the luma and chroma pair, and keeps a later edit', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec("INSERT INTO settings (key, value) VALUES ('raw_denoise', '1.4'), ('raw_sharpen', '0.6')");

    runMigrations(db);
    // What the user tuned for the pair as one, carried onto both so the upgrade renders
    // what it rendered before.
    expect(db.query('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
      { key: 'raw_denoise_chroma', value: '1.4' },
      { key: 'raw_denoise_luma', value: '1.4' },
      { key: 'raw_sharpen', value: '0.6' },
    ]);

    // And a value chosen afterwards survives a re-run, which is what a downgrade and
    // re-upgrade leaves behind.
    db.exec("UPDATE settings SET value = '2.5' WHERE key = 'raw_denoise_chroma'");
    runMigrations(db);
    expect(db.query("SELECT value FROM settings WHERE key = 'raw_denoise_chroma'").get()).toEqual({ value: '2.5' });
  });

  it('creates a fresh database with the stages already split', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const cols = columns(db);
    expect(cols.has('needs_tile')).toBe(true);
    expect(cols.has('renditions_built_at')).toBe(true);
    expect(cols.has('needs_processing')).toBe(false);
  });

  // Names used to be optional placeholders for the root folder. Existing blank
  // rows become real names, and the column refuses NULL afterwards.
  it('fills blank library names from the root path and makes the column required', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE libraries (
      id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, data_path TEXT, name TEXT
    )`);
    db.exec(`INSERT INTO libraries (id, root_path, name) VALUES
      ('a', '/photos/Trip', NULL),
      ('b', '/photos/Trip/2025', ''),
      ('c', '/photos/Weddings', 'Already named')`);
    db.exec(OLD_PHOTOS);

    runMigrations(db);

    const rows = db.query('SELECT id, name FROM libraries ORDER BY id').all() as { id: string; name: string }[];
    expect(rows).toEqual([
      { id: 'a', name: 'Trip' },
      { id: 'b', name: 'Trip 2025' },
      { id: 'c', name: 'Already named' },
    ]);
    const nameCol = (db.query('PRAGMA table_info(libraries)').all() as { name: string; notnull: number }[]).find(
      (col) => col.name === 'name',
    );
    expect(nameCol?.notnull).toBe(1);
  });

  it('halves a tuned quantizer once, whatever it is run over', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec("INSERT INTO settings (key, value) VALUES ('full_rendition_quantizer', '26'), ('hdr_crf', '20'), ('full_rendition_size', '3840')");
    // Stamped by the first run, so a settings row written afterwards is on the new
    // scale already and must be left alone. Halving twice would double every
    // rendition's size, which is the failure this cannot self-detect.
    runMigrations(db);
    runMigrations(db);

    const values = db.query('SELECT key, value FROM settings ORDER BY key').all();
    expect(values).toEqual([
      { key: 'full_rendition_quantizer', value: '26' },
      { key: 'full_rendition_size', value: '3840' },
      { key: 'hdr_crf', value: '20' },
    ]);
  });

  it('halves the quantizers a database predating the rescale had tuned', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Every key the rescale names, not a sample of them: they are listed in one SQL
    // `IN`, and a key mistyped there leaves those users on the old scale silently.
    db.exec(`INSERT INTO settings (key, value) VALUES
      ('grid_rendition_quantizer', '26'), ('full_rendition_quantizer', '26'),
      ('lossless_sdr_quantizer', '16'), ('lossless_quantizer', '8'),
      ('hdr_crf', '20'), ('full_rendition_size', '3840')`);

    runMigrations(db);

    // Only the quantizers, and only once: a size on the same table is not on this
    // scale and a second run finds the stamp.
    runMigrations(db);
    expect(db.query('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
      { key: 'full_rendition_quantizer', value: '13' },
      { key: 'full_rendition_size', value: '3840' },
      { key: 'grid_rendition_quantizer', value: '13' },
      { key: 'hdr_crf', value: '10' },
      { key: 'lossless_quantizer', value: '4' },
      { key: 'lossless_sdr_quantizer', value: '8' },
    ]);
  });

  it('leaves a quantizer it cannot parse for the settings reader to discard', () => {
    // SQLite reads `CAST('lots' AS INTEGER)` as 0, so halving without a guard turns a
    // row nothing can parse into a *valid* 0 - near-lossless, in range, and preferred
    // over the default from then on. A downgrade and re-upgrade is what writes such a
    // row, and `settings.integration.test.ts` pins that it must not take the viewer
    // down; this pins that the migration cannot promote it either.
    const db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Every shape SQLite would quietly turn into a number: an empty string and a word
    // both CAST to 0, and `CAST` is a *prefix* parse so '26abc' is 26 and '26.9' is 26.
    // Halving any of them promotes a value the settings reader was correctly discarding
    // into one it will use. '80' is a third case - parseable, but outside the schema's
    // 0-63, so the reader rejects it and the migration must not rescue it into range.
    db.exec(`INSERT INTO settings (key, value) VALUES
      ('grid_rendition_quantizer', 'lots'), ('hdr_crf', ''),
      ('full_rendition_quantizer', '26abc'), ('lossless_sdr_quantizer', '80'),
      ('lossless_quantizer', '0')`);

    runMigrations(db);

    expect(db.query('SELECT key, value FROM settings ORDER BY key').all()).toEqual([
      { key: 'full_rendition_quantizer', value: '26abc' },
      { key: 'grid_rendition_quantizer', value: 'lots' },
      { key: 'hdr_crf', value: '' },
      // Already the tightest the scale goes, and halving it would say nothing new.
      { key: 'lossless_quantizer', value: '0' },
      { key: 'lossless_sdr_quantizer', value: '80' },
    ]);
  });
});
