import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * `column IN ('a', 'b')`, built from the same list the zod schema validates against so the two
 * cannot drift.
 */
export function oneOf(column: SQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  )})`;
}
