import type { Database } from 'bun:sqlite';
import { THUMBNAIL_SOURCES, type ThumbnailSource } from '../processing/processing_types';

const DEFAULT_THUMBNAIL_SOURCE: ThumbnailSource = 'render';
const KEY_THUMBNAIL_SOURCE = 'import.thumbnail_source';

// Settings the user changes from the app, as opposed to the deployment config in
// environment variables. A key/value table rather than a column per setting: they
// are read once per use and never queried across.
export class SettingsRepository {
  constructor(private readonly db: Database) {}

  // Source used for photos indexed from now on. Existing thumbnails are left
  // alone; changing this is not a retroactive reprocess.
  getThumbnailSource(): ThumbnailSource {
    const row = this.db.query('SELECT value FROM settings WHERE key = ?').get(KEY_THUMBNAIL_SOURCE) as
      | { value: string }
      | null;
    const value = row?.value;
    // An unknown value means the row was written by a newer version, or by hand.
    // Falling back beats failing every scan.
    return THUMBNAIL_SOURCES.includes(value as ThumbnailSource) ? (value as ThumbnailSource) : DEFAULT_THUMBNAIL_SOURCE;
  }

  setThumbnailSource(source: ThumbnailSource): void {
    this.db
      .query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY_THUMBNAIL_SOURCE, source);
  }
}
