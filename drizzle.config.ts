import { defineConfig } from 'drizzle-kit';

// 'turso' rather than 'sqlite' is what makes the generator reach for libSQL's ALTER COLUMN instead
// of rebuilding a table for every column change. We run libSQL locally, not Turso Cloud.
export default defineConfig({
  dialect: 'turso',
  schema: './src/db/schema/*.ts',
  out: './src/db/migrations',
  // Only the commands that connect read this; `generate` diffs against the snapshot and opens
  // nothing. It tracks `config.ts` so that `studio` and `push` cannot be pointed at a second
  // catalogue that quietly springs into existence beside the real one.
  dbCredentials: { url: `file:${process.env.DB_PATH ?? './bowerbird.db'}` },
});
