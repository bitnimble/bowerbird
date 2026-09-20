import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Runtime settings the user can change from the app, as opposed to the deployment config in
// environment variables (§15).
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
