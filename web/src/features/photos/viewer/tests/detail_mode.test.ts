import { expect, test } from 'bun:test';
import { detailMode, detailPath, editPath, mockupPath } from '../detail_mode';

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
