import { describe, it, expect } from 'bun:test';
import { Database } from '../driver';
import { getTableName, is, Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { runMigrations } from '../migrate';
import * as albums from '../schema/albums';
import * as blobs from '../schema/blobs';
import * as exportsSchema from '../schema/exports';
import * as libraries from '../schema/libraries';
import * as photoEdits from '../schema/photo_edits';
import * as photos from '../schema/photos';
import * as renditions from '../schema/renditions';
import * as replication from '../schema/replication';
import * as settings from '../schema/settings';
import * as shoots from '../schema/shoots';
import * as stacks from '../schema/stacks';

const declared = [
  albums,
  blobs,
  exportsSchema,
  libraries,
  photoEdits,
  photos,
  renditions,
  replication,
  settings,
  shoots,
  stacks,
].flatMap((module) => Object.values(module).filter((value) => is(value, Table)));

interface ForeignKeyRow {
  id: number;
  seq: number;
  from: string;
  table: string;
  on_delete: string;
}

/** One foreign key, written the same way whichever side it was read from. */
const spell = (columns: readonly string[], table: string, onDelete: string | undefined): string =>
  `${columns.join(',')} -> ${table} ${(onDelete ?? 'no action').toLowerCase()}`;

/**
 * The schema files and the generated SQL are two artefacts, and only `drizzle-kit generate` keeps
 * them in step. Editing a table and shipping without regenerating leaves a catalogue that is missing
 * whatever was added, so this compares what the modules declare against what a migrated database
 * actually holds.
 */
describe('the generated migrations carry what the schema declares', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const built = new Set(
    (
      db
        .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name),
  );

  it('builds every declared table, and no more', () => {
    const names = declared.map(getTableName).sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(built.has(name)).toBe(true);
    // `__drizzle_migrations` is the journal rather than part of the schema.
    built.delete('__drizzle_migrations');
    expect([...built].sort()).toEqual(names);
  });

  it('builds every column each table declares', () => {
    for (const table of declared) {
      const name = getTableName(table);
      const wanted = getTableConfig(table).columns.map((column) => column.name).sort();
      const actual = (db.query(`PRAGMA table_info(${JSON.stringify(name)})`).all() as { name: string }[])
        .map((column) => column.name)
        .sort();
      expect({ [name]: actual }).toEqual({ [name]: wanted });
    }
  });

  // Names alone would let everything that matters drift: a column that stopped being NOT NULL, a
  // default that moved, a key that gained a column. All of those keep the name they had, so a
  // schema edited without `drizzle-kit generate` behind it would ship looking identical.
  it('builds each column as the schema declares it, not merely under the same name', () => {
    for (const table of declared) {
      const name = getTableName(table);
      const config = getTableConfig(table);
      // A key of several columns is declared on the table rather than on any one of them, so
      // membership is the two places put together.
      const keyed = new Set(config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)));
      const wanted = Object.fromEntries(
        config.columns.map((column) => [
          column.name,
          {
            notNull: column.notNull,
            // An `integer` primary key is the rowid under another name, and SQLite fills it in
            // itself. drizzle reports that as a default; the SQL carries no `DEFAULT` clause, so
            // asking `table_info` about one would report a difference that is not there.
            hasDefault: column.hasDefault && !(column.primary && column.getSQLType() === 'integer'),
            primaryKey: column.primary || keyed.has(column.name),
          },
        ]),
      );
      const rows = db.query(`PRAGMA table_info(${JSON.stringify(name)})`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];
      const actual = Object.fromEntries(
        rows.map((column) => [
          column.name,
          { notNull: column.notnull === 1, hasDefault: column.dflt_value != null, primaryKey: column.pk > 0 },
        ]),
      );
      expect({ [name]: actual }).toEqual({ [name]: wanted });
    }
  });

  // An action that silently became `no action` is a row that outlives what owned it, which is the
  // whole reason these are declared. Both sides are spelled by the same function, so a difference
  // reported here is a difference in the key rather than in how the two were written down.
  it('builds every foreign key with the delete action the schema declares', () => {
    for (const table of declared) {
      const name = getTableName(table);
      const wanted = getTableConfig(table)
        .foreignKeys.map((key) => {
          const reference = key.reference();
          return spell(
            reference.columns.map((column) => column.name),
            getTableName(reference.foreignTable),
            key.onDelete,
          );
        })
        .sort();
      // One row per column, so a key of several arrives as several rows sharing an `id`.
      const columns = new Map<number, string[]>();
      const keys = db.query(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as ForeignKeyRow[];
      for (const row of keys) columns.set(row.id, [...(columns.get(row.id) ?? []), row.from]);
      const actual = keys
        .filter((row) => row.seq === 0)
        .map((row) => spell(columns.get(row.id)!, row.table, row.on_delete))
        .sort();
      expect({ [name]: actual }).toEqual({ [name]: wanted });
    }
  });
});
