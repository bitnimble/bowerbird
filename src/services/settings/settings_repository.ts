import type { Database } from 'bun:sqlite';
import {
  ViewerRenditionModeSchema,
  ViewerRenditionSchema,
  type Settings,
  type UpdateSettingsRequest,
} from '../../schemas/settings';

// App-wide settings, as opposed to the per-library ones on the `libraries` row
// (§10.2) and the deployment config in environment variables (§15). Key/value
// rather than a one-row table: every one of these is a small independent
// preference, and adding one should not need a migration.
export class SettingsRepository {
  constructor(private readonly db: Database) {}

  get(): Settings {
    // Anything the app has never written, or wrote under an older spelling, is
    // read as the default rather than failing the whole request: these are
    // preferences, and the viewer has to open with or without them.
    const mode = ViewerRenditionModeSchema.safeParse(this.read('viewer_rendition_mode'));
    const last = ViewerRenditionSchema.safeParse(this.read('last_viewer_rendition'));
    return {
      viewer_rendition_mode: mode.success ? mode.data : 'remember',
      last_viewer_rendition: last.success ? last.data : null,
    };
  }

  update(updates: UpdateSettingsRequest): Settings {
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) this.db.query('DELETE FROM settings WHERE key = ?').run(key);
      else if (value !== undefined) this.write(key, value);
    }
    return this.get();
  }

  private read(key: string): string | null {
    const row = this.db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
  }
}
