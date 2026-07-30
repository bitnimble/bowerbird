// Everything the user can change that is not a property of one library: which
// rendition a photo opens at (§10.2) and the server's own tuning (§15).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/db/migrations';
import { DEFAULT_SETTINGS } from '../../src/schemas/settings';
import { SettingsRepository } from '../../src/services/settings/settings_repository';

function repo(): { settings: SettingsRepository; db: Database } {
  const db = new Database(':memory:');
  runMigrations(db);
  return { settings: new SettingsRepository(db), db };
}

test('an untouched catalogue reads every setting as its default', () => {
  const { settings, db } = repo();
  expect(settings.get()).toEqual(DEFAULT_SETTINGS);
  db.close();
});

test('each setting is written and read back independently', () => {
  const { settings, db } = repo();
  settings.update({ viewer_rendition_mode: 'max' });
  settings.update({ last_viewer_rendition: 'full' });
  expect(settings.get()).toEqual({ ...DEFAULT_SETTINGS, viewer_rendition_mode: 'max', last_viewer_rendition: 'full' });
  db.close();
});

// Stored as text, so a number read back as "4" would silently turn every
// arithmetic use of it into string concatenation.
test('numbers and booleans survive the round trip as numbers and booleans', () => {
  const { settings, db } = repo();
  settings.update({ processing_concurrency: 8, hdr_white_quantile: 0.85, watch_enabled: false });
  expect(settings.get().processing_concurrency).toBe(8);
  expect(settings.get().hdr_white_quantile).toBe(0.85);
  expect(settings.get().watch_enabled).toBe(false);
  db.close();
});

// A value written by a newer build, or an older spelling of one, must not take
// the viewer down with it: these are preferences, and a photo has to open.
test('a value the app no longer understands reads as the default', () => {
  const { settings, db } = repo();
  db.query("INSERT INTO settings (key, value) VALUES ('viewer_rendition_mode', 'holographic')").run();
  db.query("INSERT INTO settings (key, value) VALUES ('grid_rendition_quantizer', 'lots')").run();
  expect(settings.get().viewer_rendition_mode).toBe('remember');
  expect(settings.get().grid_rendition_quantizer).toBe(DEFAULT_SETTINGS.grid_rendition_quantizer);
  db.close();
});

test('null clears what was remembered rather than storing it', () => {
  const { settings, db } = repo();
  settings.update({ last_viewer_rendition: 'max' });
  expect(settings.update({ last_viewer_rendition: null }).last_viewer_rendition).toBeNull();
  expect(db.query("SELECT COUNT(*) n FROM settings WHERE key = 'last_viewer_rendition'").get()).toEqual({ n: 0 });
  db.close();
});

// The watcher, the schedulers and the log level are configured from these once
// and re-configured on edit, so a change that never reaches them is a knob that
// silently does nothing until the next restart.
test('a change reaches the parts of the server configured from it', () => {
  const { settings, db } = repo();
  const seen: number[] = [];
  settings.onChange((s) => seen.push(s.prune_every_days));
  settings.update({ prune_every_days: 3 });
  expect(seen).toEqual([3]);
  db.close();
});
