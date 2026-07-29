import type { Database } from 'bun:sqlite';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings, type UpdateSettingsRequest } from '../../schemas/settings';

// Values are stored as text, so the default's type says what to read one back
// as. Anything else (a nullable string) is already what it will be parsed as.
function typed(fallback: unknown, raw: string): unknown {
  if (typeof fallback === 'number') return Number(raw);
  if (typeof fallback === 'boolean') return raw === 'true';
  return raw;
}

// Everything the user can change that is not a property of one library (§10.2):
// the viewer's preferences and the server's own tuning, both live for the
// running process. Only the listen address and the database path stay in the
// environment (§15), because they are what has to be known before this table can
// be read. Key/value rather than a column each: they are read one at a time and
// never queried across, and adding one should not need a migration.
export class SettingsRepository {
  private cache: Settings | null = null;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(private readonly db: Database) {}

  get(): Settings {
    return (this.cache ??= this.read());
  }

  /** Called after every change, for the parts of the server that are configured once and re-configured on edit. */
  onChange(listener: (settings: Settings) => void): void {
    this.listeners.add(listener);
  }

  update(updates: UpdateSettingsRequest): Settings {
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) this.db.query('DELETE FROM settings WHERE key = ?').run(key);
      else if (value !== undefined) this.write(key, String(value));
    }
    this.cache = null;
    const settings = this.get();
    for (const listener of this.listeners) listener(settings);
    return settings;
  }

  // Anything the app has never written, or wrote under an older spelling, is
  // read as the default rather than failing the whole request: a bad row must
  // not stop the viewer opening or the server booting.
  private read(): Settings {
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    const rows = this.db.query('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    for (const { key, value } of rows) {
      const field = SettingsSchema.shape[key as keyof Settings];
      if (field == null) continue;
      const parsed = field.safeParse(typed(DEFAULT_SETTINGS[key as keyof Settings], value));
      if (parsed.success) settings[key] = parsed.data;
    }
    return settings as Settings;
  }

  private write(key: string, value: string): void {
    this.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
  }
}
