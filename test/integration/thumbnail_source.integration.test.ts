// The embedded-JPEG path lifts the camera's own rendering out of the RAW instead
// of demosaicing it (§10.3). It is a different LibRaw call chain from the render
// path, so it needs a real file to prove anything.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { createDatabase } from '../../src/db/connection';
import { readEmbeddedJpeg } from '../../src/services/processing/raw_decoder';
import { SettingsRepository } from '../../src/services/settings/settings_repository';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

test('the embedded preview is a decodable JPEG', async () => {
  const jpeg = readEmbeddedJpeg(FIXTURE);
  expect(jpeg).not.toBeNull();
  const meta = await sharp(jpeg!).metadata();
  expect(meta.format).toBe('jpeg');
  expect(meta.width).toBeGreaterThan(0);
  expect(meta.height).toBeGreaterThan(0);
});

test('the embedded preview carries its own EXIF orientation', async () => {
  // The render path bakes upright, the embedded path does not, so the worker has
  // to rotate. If this stops being true, portrait frames come out sideways.
  const jpeg = readEmbeddedJpeg(FIXTURE)!;
  const meta = await sharp(jpeg).metadata();
  expect(meta.orientation).toBe(8);

  const upright = await sharp(jpeg).rotate().toBuffer({ resolveWithObject: true });
  expect(upright.info.height).toBeGreaterThan(upright.info.width);
});

test('the import setting round-trips and falls back to a render', () => {
  const db = createDatabase(':memory:');
  const settings = new SettingsRepository(db);
  try {
    expect(settings.getThumbnailSource()).toBe('render');

    settings.setThumbnailSource('embedded');
    expect(settings.getThumbnailSource()).toBe('embedded');

    settings.setThumbnailSource('render');
    expect(settings.getThumbnailSource()).toBe('render');

    // A value written by hand or by a newer version must not break every scan.
    db.query('UPDATE settings SET value = ?').run('something-else');
    expect(settings.getThumbnailSource()).toBe('render');
  } finally {
    db.close();
  }
});
