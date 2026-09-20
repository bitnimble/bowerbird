import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { Database } from '../driver';
import { runMigrations } from '../migrate';
import { photoInputTriggers, triggers } from '../triggers';
import { RecipeSchema } from '../../schemas/recipes';

function openMigrated(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertPhoto(db: Database, id: string, recipe: string): void {
  db.query(
    "INSERT INTO photos (id, library_id, recipe, width, height, date_added) VALUES (?, 'lib', ?, 6000, 4000, '2026-01-01')",
  ).run(id, recipe);
}

function sourcesOfRow(db: Database, id: string): string[] {
  return (db.query('SELECT photo_id FROM photo_sources WHERE composed_id = ? ORDER BY at').all(id) as {
    photo_id: string;
  }[]).map((row) => row.photo_id);
}

describe('photoInputTriggers', () => {
  it('indexes no sources for an unknown composite kind', () => {
    const db = openMigrated();
    insertPhoto(db, 'p1', JSON.stringify({ kind: 'mosaic', sources: [{ photoId: 'f1' }] }));
    expect(sourcesOfRow(db, 'p1')).toEqual([]);
  });

  it('indexes an assembly recipe\'s sources', () => {
    const db = openMigrated();
    insertPhoto(db, 'p1', JSON.stringify({ kind: 'assembly', sources: [{ photoId: 'f1' }, { photoId: 'f2' }] }));
    expect(sourcesOfRow(db, 'p1')).toEqual(['f1', 'f2']);
  });

  it('lists every composite kind in the union', () => {
    const kinds = RecipeSchema.options.map((option) => option.shape.kind.value).filter((kind) => kind !== 'file');
    expect(kinds.length).toBeGreaterThan(1);
    for (const kind of kinds) expect(photoInputTriggers()).toContain(`'${kind}'`);
  });

  it('a library created before the allowlist takes the new trigger body', () => {
    const db = openMigrated();
    // The body a library shipped with before 'assembly' was a kind: the gate on 'panorama' alone.
    db.exec('DROP TRIGGER photos_index_inputs_ins');
    db.exec(photoInputTriggers().replace("IN ('panorama', 'assembly')", "= 'panorama'"));
    // Only the migration, then only what migrate.ts does after one.
    db.exec(readFileSync(new URL('../migrations/0004_composite_sources.sql', import.meta.url), 'utf8'));
    db.exec(triggers());
    insertPhoto(db, 'p1', JSON.stringify({ kind: 'assembly', sources: [{ photoId: 'f1' }] }));
    expect(sourcesOfRow(db, 'p1')).toEqual(['f1']);
  });
});
