// What a report carries about a photograph, and - the half that matters - what it does not:
// nothing at all unless the reader asked, and never the original where they asked for the
// identifying data to go but the file is too large to carry.
import { expect, test } from 'bun:test';
import type { PhotoDetail } from '../../../../../src/schemas/photos';
import type { ExportRequest } from '../../../../../src/schemas/export';
import { exportsApi } from '../../../api/exports';
import { photosApi } from '../../../api/photos';
import { restoreApiAfterTests } from '../../../test_api';
import { attachmentsFor, rawFits, ReportTooLarge, REQUEST_CEILING } from '../photo_attachments';

restoreApiAfterTests();

const MB = 1024 * 1024;

function photo(over: Partial<PhotoDetail> = {}): PhotoDetail {
  return { id: 'ph-1', has_embedded: true, file_size: 25 * MB, ...over } as unknown as PhotoDetail;
}

function stub(): { asked: string[]; exported: ExportRequest[] } {
  const asked: string[] = [];
  const exported: ExportRequest[] = [];
  photosApi.attachment = (photoId, form, scrub = false) => {
    asked.push(`${photoId}/${form}${scrub ? '?scrub' : ''}`);
    const mediaType = form === 'full' ? 'image/avif' : form === 'analysis' ? 'application/octet-stream' : 'image/jpeg';
    return Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mediaType, filename: 'DSC00853.ARW' });
  };
  exportsApi.create = (body: ExportRequest) => {
    exported.push(body);
    return Promise.resolve({ bytes: new Uint8Array([4, 5]), mediaType: 'image/jpeg', filename: 'DSC00853.jpg' });
  };
  return { asked, exported };
}

test('the camera JPEG, both renders and the measurements, scrubbed on the way out', async () => {
  const { asked, exported } = stub();

  const attached = await attachmentsFor({ photo: photo(), raw: false, strip: true });

  expect(asked).toEqual(['ph-1/embedded?scrub', 'ph-1/full', 'ph-1/analysis']);
  expect(attached.map((part) => part.filename)).toEqual([
    'ph-1-embedded.jpg',
    'ph-1-full.avif',
    'ph-1-analysis.bin',
    'ph-1-sdr.jpg',
  ]);
  expect(exported[0]?.options).toMatchObject({ format: 'jpeg', quality: 95, exportHdr: false });
});

test('the original rides along only when it was asked for', async () => {
  const { asked } = stub();

  await attachmentsFor({ photo: photo(), raw: true, strip: true });

  expect(asked).toContain('ph-1/original?scrub');
});

test('leaving the identifying data in asks for the file unscrubbed', async () => {
  const { asked } = stub();

  await attachmentsFor({ photo: photo(), raw: true, strip: false });

  expect(asked).toEqual(['ph-1/embedded', 'ph-1/full', 'ph-1/analysis', 'ph-1/original']);
});

test('a photograph with no camera JPEG is not asked for one', async () => {
  const { asked } = stub();

  await attachmentsFor({ photo: photo({ has_embedded: false }), raw: false, strip: true });

  expect(asked).toEqual(['ph-1/full', 'ph-1/analysis']);
});

test('a picture that will not build leaves the rest of the report standing', async () => {
  stub();
  photosApi.attachment = (_photoId, form) =>
    form === 'full' ?
      Promise.reject(new Error('never rendered'))
    : Promise.resolve({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg', filename: null });

  const attached = await attachmentsFor({ photo: photo(), raw: false, strip: true });

  expect(attached.map((part) => part.filename)).toEqual(['ph-1-embedded.jpg', 'ph-1-analysis.jpg', 'ph-1-sdr.jpg']);
});

test('an original that will not fit beside the pictures is refused before it is fetched', async () => {
  const { asked } = stub();

  await expect(
    attachmentsFor({ photo: photo({ file_size: REQUEST_CEILING }), raw: true, strip: true }),
  ).rejects.toBeInstanceOf(ReportTooLarge);
  expect(asked).not.toContain('ph-1/original?scrub');
});

test('an original larger than the request Sentry will take is not offered', () => {
  expect(rawFits(photo({ file_size: 39 * MB }))).toBe(true);
  expect(rawFits(photo({ file_size: 41 * MB }))).toBe(false);
  expect(rawFits(photo({ file_size: null }))).toBe(false);
});
