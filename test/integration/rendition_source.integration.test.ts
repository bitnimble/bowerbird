// The embedded-JPEG path lifts the camera's own rendering out of the RAW instead
// of demosaicing it (§10.3). It is a different LibRaw call chain from the render
// path, so it needs a real file to prove anything.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/connection';
import { readEmbeddedJpeg, readRawHeader } from '../../src/services/processing/raw_decoder';
import { _for_testing_previewSummary } from '../../src/services/processing/rawshim_for_testing';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

test('the embedded preview is a decodable JPEG', () => {
  const jpeg = readEmbeddedJpeg(FIXTURE);
  expect(jpeg).not.toBeNull();
  // A body that embeds a bitmap preview instead is the case the caller falls
  // back on, so this is checked at the bytes rather than taken on trust.
  expect(Array.from(jpeg!.subarray(0, 2))).toEqual([0xff, 0xd8]);

  const decoded = _for_testing_previewSummary(FIXTURE);
  expect(decoded.width).toBeGreaterThan(0);
  expect(decoded.height).toBeGreaterThan(0);
});

test('the embedded preview carries its own EXIF orientation', () => {
  // The render path bakes upright, the embedded path does not, so the worker has
  // to rotate. If this stops being true, portrait frames come out sideways.
  expect(readRawHeader(FIXTURE).orientation).not.toBe(0);

  const upright = _for_testing_previewSummary(FIXTURE);
  // Only true if the orientation was applied: the preview is stored landscape.
  expect(upright.height).toBeGreaterThan(upright.width);
});

test('the rendition settings live on the library and round-trip', () => {
  const db = createDatabase(':memory:');
  const libraries = new LibrariesRepository(db);
  const id = '00000000-0000-4000-8000-0000000000c1';
  try {
    db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(id, '/tmp/x', 'lib', 'added_desc');

    // The default is the embedded JPEG, which needs no demosaic, and HDR is off
    // because it only means anything for a render.
    const created = libraries.getById(id)!;
    expect(created.rendition_source).toBe('embedded');
    expect(created.rendition_hdr).toBe(false);

    libraries.setRenditionSource(id, 'render');
    libraries.setRenditionHdr(id, true);
    const rendered = libraries.getById(id)!;
    expect(rendered.rendition_source).toBe('render');
    expect(rendered.rendition_hdr).toBe(true);

    // Stored as an integer, so it has to come back a boolean rather than 1.
    expect(typeof rendered.rendition_hdr).toBe('boolean');
  } finally {
    db.close();
  }
});
