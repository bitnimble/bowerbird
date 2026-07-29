// The viewer's global settings, which decide which rendition a photo opens at
// (§10.2).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/db/migrations';
import { SettingsRepository } from '../../src/services/settings/settings_repository';

function repo(): { settings: SettingsRepository; db: Database } {
  const db = new Database(':memory:');
  runMigrations(db);
  return { settings: new SettingsRepository(db), db };
}

test('an untouched catalogue opens photos wherever they were left', () => {
  const { settings, db } = repo();
  expect(settings.get()).toEqual({ viewer_rendition_mode: 'remember', last_viewer_rendition: null });
  db.close();
});

test('each setting is written and read back independently', () => {
  const { settings, db } = repo();
  settings.update({ viewer_rendition_mode: 'max' });
  settings.update({ last_viewer_rendition: 'full' });
  expect(settings.get()).toEqual({ viewer_rendition_mode: 'max', last_viewer_rendition: 'full' });
  db.close();
});

// A value written by a newer build, or an older spelling of one, must not take
// the viewer down with it: these are preferences, and a photo has to open.
test('a value the app no longer understands reads as the default', () => {
  const { settings, db } = repo();
  db.query("INSERT INTO settings (key, value) VALUES ('viewer_rendition_mode', 'holographic')").run();
  expect(settings.get().viewer_rendition_mode).toBe('remember');
  db.close();
});

test('null clears what was remembered rather than storing it', () => {
  const { settings, db } = repo();
  settings.update({ last_viewer_rendition: 'max' });
  expect(settings.update({ last_viewer_rendition: null }).last_viewer_rendition).toBeNull();
  expect(db.query("SELECT COUNT(*) n FROM settings WHERE key = 'last_viewer_rendition'").get()).toEqual({ n: 0 });
  db.close();
});
