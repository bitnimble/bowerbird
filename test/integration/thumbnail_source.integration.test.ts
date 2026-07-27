// The embedded-JPEG path lifts the camera's own rendering out of the RAW instead
// of demosaicing it (§10.3). It is a different LibRaw call chain from the render
// path, so it needs a real file to prove anything.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { createDatabase } from '../../src/db/connection';
import { readEmbeddedJpeg } from '../../src/services/processing/raw_decoder';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';

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

test('the preview settings live on the library and round-trip', () => {
  const db = createDatabase(':memory:');
  const libraries = new LibrariesRepository(db);
  const id = '00000000-0000-4000-8000-0000000000c1';
  try {
    db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(id, '/tmp/x', 'added_desc');

    // The default is the embedded JPEG, which needs no demosaic, and HDR is off
    // because it only means anything for a render.
    const created = libraries.getById(id)!;
    expect(created.preview_source).toBe('embedded');
    expect(created.preview_hdr).toBe(false);

    // The video is its own opt-in, off even once HDR is on: it is a second
    // encode per photo for a file only Firefox reads (§10.7).
    expect(created.preview_hdr_video).toBe(false);

    libraries.setPreviewSource(id, 'render');
    libraries.setPreviewHdr(id, true);
    const hdrOnly = libraries.getById(id)!;
    expect(hdrOnly.preview_source).toBe('render');
    expect(hdrOnly.preview_hdr).toBe(true);
    expect(hdrOnly.preview_hdr_video).toBe(false);

    libraries.setPreviewHdrVideo(id, true);
    const withVideo = libraries.getById(id)!;
    expect(withVideo.preview_hdr_video).toBe(true);

    // Stored as integers, so they have to come back booleans rather than 1.
    expect(typeof withVideo.preview_hdr).toBe('boolean');
    expect(typeof withVideo.preview_hdr_video).toBe('boolean');
  } finally {
    db.close();
  }
});
