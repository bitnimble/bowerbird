import { expect, test } from 'bun:test';
import { detailMode, detailPath, editPath, isPrintRequest, mockupPath } from '../detail_mode';

const PHOTO = '/shoots/s-1/photos/abc';

test('each address names the mode it opens in', () => {
  expect(detailMode(PHOTO)).toBe('view');
  expect(detailMode(`${PHOTO}/edit`)).toBe('edit');
  expect(detailMode(`${PHOTO}/mockup`)).toBe('print');
});

test('the editor and the mockup hang off the photo whatever mode is open', () => {
  expect(editPath(PHOTO)).toBe(`${PHOTO}/edit`);
  expect(editPath(`${PHOTO}/mockup`)).toBe(`${PHOTO}/edit`);
  expect(mockupPath(`${PHOTO}/edit`)).toBe(`${PHOTO}/mockup`);
  expect(detailPath(`${PHOTO}/edit`)).toBe(PHOTO);
  expect(detailPath(`${PHOTO}/mockup`)).toBe(PHOTO);
  expect(detailPath(PHOTO)).toBe(PHOTO);
});

test('a way into the mockup names the print and the rendition it prints', () => {
  for (const rendition of ['embedded', 'full', 'max']) {
    expect(isPrintRequest({ proof: 'print3d', rendition })).toBe(true);
  }
  expect(isPrintRequest({ proof: 'print', rendition: 'max' })).toBe(true);
  expect(isPrintRequest({ proof: 'print3d' })).toBe(false);
  expect(isPrintRequest({ proof: 'print3d', rendition: 'grid' })).toBe(false);
  expect(isPrintRequest({ proof: 'hdr', rendition: 'max' })).toBe(false);
  expect(isPrintRequest(null)).toBe(false);
});
