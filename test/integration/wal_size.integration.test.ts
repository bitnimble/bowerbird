// The WAL is rewound to be overwritten rather than shrunk, so without a size limit
// it keeps the high-water mark of the worst burst the database has ever seen. The
// backup's read transaction (§4.9) is what pushes that mark up.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';

const LIMIT = 16 * 1024 * 1024;

let dir: string;
let dbPath: string;
let db: Database;

function walBytes(): number {
  return existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
}

// Enough page churn to carry the WAL past the limit. One commit per row on purpose:
// each writes its own copy of every page it touched, which is what makes a pinned
// reader expensive. New rows rather than rewrites of the same few - replacing a
// value frees its overflow pages for the next one to reuse, which keeps the WAL
// compact and is the opposite of what this needs. Values large enough that a couple
// of hundred commits do it, each being an fsync.
let written = 0;
function churn(commits: number): void {
  const insert = db.query('INSERT INTO settings (key, value) VALUES (?, ?)');
  const value = 'x'.repeat(64 * 1024);
  for (let i = 0; i < commits; i++) insert.run(`churn-${written++}`, value);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bb-wal-'));
  dbPath = path.join(dir, 'bowerbird.db');
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a WAL blown up by a long-lived reader is handed back once writing resumes', () => {
  // What a backup does: a second connection holding a read snapshot open while the
  // server keeps writing. Nothing can be checkpointed past it.
  const reader = new Database(dbPath, { readonly: true });
  reader.exec('BEGIN');
  reader.query('SELECT count(*) FROM settings').get();

  churn(300);
  expect(walBytes()).toBeGreaterThan(LIMIT);

  reader.exec('COMMIT');
  reader.close();

  // The limit is applied when the WAL next resets, not by the checkpoint itself, so
  // the space comes back as writing continues rather than at the moment of release.
  churn(100);
  expect(walBytes()).toBeLessThanOrEqual(LIMIT);
});
