import { beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { RenditionsRepository } from '../renditions_repository';

let db: Database;

function library(id: string, denoiser: string): void {
  db.query(
    `INSERT INTO libraries (id, root_path, name, rendition_hdr, denoiser) VALUES (?, ?, ?, 0, ?)`,
  ).run(id, `/${id}`, id, denoiser);
}

function photo(id: string, libraryId: string, denoiser?: string | null): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, ?, '{"kind":"file","path":"a.arw"}', 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(id, libraryId);
  if (denoiser === undefined) return;
  db.query(
    `INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at)
       VALUES (?, ?, 0, 1, '2026-01-01T00:00:00.000Z')`,
  ).run(id, JSON.stringify({ exposure: 0, denoiser }));
}

function owing(): string[] {
  const rows = db
    .query(
      `SELECT photo_id, variant FROM renditions WHERE needs_build = 1 ORDER BY photo_id, variant`,
    )
    .all() as { photo_id: string; variant: string }[];
  return rows.map((row) => `${row.photo_id}:${row.variant}`);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  library('upscaled', 'upscaler');
  library('plain', 'galosh');
});

test('a denoiser model change owes every photo denoised with it, by its own edit or its library', () => {
  photo('by-library', 'upscaled');
  photo('unset-in-edit', 'upscaled', null);
  photo('chose-another', 'upscaled', 'pmrid');
  photo('chose-it', 'plain', 'upscaler');
  photo('untouched', 'plain');
  db.query('UPDATE renditions SET needs_build = 0').run();

  expect(new RenditionsRepository(db).queueDenoisedWith('upscaler')).toBe(3);
  expect(owing()).toEqual([
    'by-library:full',
    'by-library:grid',
    'chose-it:full',
    'chose-it:grid',
    'unset-in-edit:full',
    'unset-in-edit:grid',
  ]);
});
