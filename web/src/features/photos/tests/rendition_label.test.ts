import { expect, test } from 'bun:test';
import { renditionLabel } from '../renditions';
import { RenditionsStrings } from '../renditions.strings';

test("a finished picture's render is its edit only once it is edited", () => {
  const unedited = { is_raw: false, is_edited: false };
  expect(renditionLabel('embedded', unedited)).toBe(RenditionsStrings.original());
  expect(renditionLabel('full', unedited)).toBe(RenditionsStrings.original());
  expect(renditionLabel('full', { ...unedited, is_edited: true })).toBe(RenditionsStrings.edited());
  expect(renditionLabel('max', { ...unedited, is_edited: true })).toBe(RenditionsStrings.edited());
  expect(renditionLabel('embedded', { ...unedited, is_edited: true })).toBe(
    RenditionsStrings.original(),
  );
  expect(renditionLabel('full', { is_raw: true, is_edited: true })).toBe(
    RenditionsStrings.renderedRaw(),
  );
});

test('a photo not yet loaded is labelled as a RAW', () => {
  expect(renditionLabel('embedded', null)).toBe(RenditionsStrings.embeddedJpeg());
  expect(renditionLabel('max')).toBe(RenditionsStrings.renderedRawMaxQuality());
});
