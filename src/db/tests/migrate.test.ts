import { describe, it, expect } from 'bun:test';
import { Database } from '../driver';
import { runMigrations } from '../migrate';
import { DEFAULT_SETTINGS } from '../../schemas/settings';

function settingsFor(db: Database, keys: string[]): Record<string, string> {
  const rows = db.query('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.filter((row) => keys.includes(row.key)).map((row) => [row.key, row.value]));
}

function objectsOfType(db: Database, type: 'table' | 'index' | 'trigger'): string[] {
  return (
    db
      .query(`SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all(type) as { name: string }[]
  ).map((row) => row.name);
}

describe('opening a catalogue', () => {
  it('preserves disabled camera matching across the render-stage migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec('DELETE FROM __drizzle_migrations WHERE created_at > 1789700000000');
    db.query('INSERT INTO libraries (id, root_path, name, render_skip_full, render_skip_max) VALUES (?, ?, ?, ?, ?)')
      .run('stages', '/stages', 'Stages', 'dust,match,sharpen', 'denoise,match');
    db.query('INSERT INTO libraries (id, root_path, name, render_skip_full) VALUES (?, ?, ?, ?)')
      .run('exact', '/exact', 'Exact', 'mismatch');

    runMigrations(db);

    expect(db.query('SELECT render_skip_full, render_skip_max FROM libraries WHERE id = ?').get('stages')).toEqual({
      render_skip_full: 'dust,lens,colour,sharpen', render_skip_max: 'denoise,lens,colour',
    });
    expect(db.query('SELECT render_skip_full, render_skip_max FROM libraries WHERE id = ?').get('exact')).toEqual({
      render_skip_full: 'mismatch', render_skip_max: '',
    });
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

    const seeded = db.query('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const keys = new Set(seeded.map((row) => row.key));
    // Every key but the ones whose default is null: an absent row is already "nothing chosen",
    // which is what `last_viewer_rendition` is until something is.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      expect(keys.has(key)).toBe(value != null);
    }
    expect(keys.has('last_viewer_rendition')).toBe(false);
    expect(seeded.find((row) => row.key === 'hdr_peak_nits')?.value).toBe('1000');
    expect(seeded.find((row) => row.key === 'watch_enabled')?.value).toBe('true');
    expect(seeded.find((row) => row.key === 'cors_origins')?.value).toBe('');

    // `OR IGNORE`, so a re-run cannot put a tuned value back to the default, which is every
    // restart rather than an edge case.
    db.exec("UPDATE settings SET value = '4000' WHERE key = 'hdr_peak_nits'");
    runMigrations(db);
    expect(settingsFor(db, ['hdr_peak_nits'])).toEqual({ hdr_peak_nits: '4000' });
  });

  it('mints one replication identity and keeps it across restarts', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const first = db.query('SELECT peer_id FROM replication_identity').get() as { peer_id: string };

    runMigrations(db);

    expect(db.query('SELECT COUNT(*) AS n FROM replication_identity').get()).toEqual({ n: 1 });
    expect((db.query('SELECT peer_id FROM replication_identity').get() as { peer_id: string }).peer_id).toBe(
      first.peer_id,
    );
  });
});
