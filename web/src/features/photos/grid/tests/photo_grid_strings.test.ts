import { expect, test } from 'bun:test';
import { PhotoGridStrings } from '../photo_grid.strings';

test('a panorama and a merge are each read out as what they are', () => {
  expect(PhotoGridStrings.compositeName(3, 'panorama')).toBe('Panorama of 3 photos');
  expect(PhotoGridStrings.compositeName(3, 'assembly')).toBe('Merge of 3 photos');
  expect(PhotoGridStrings.tile(false, 3, 'x', 'assembly', null)).toBe('merge of 3 photos');
  expect(PhotoGridStrings.tile(false, 8, 'x', 'burst', null)).toBe('merge of 8 photos');
  expect(PhotoGridStrings.compositeName(8, 'burst')).toBe('Merge of 8 photos');
  expect(PhotoGridStrings.tile(false, 3, 'x', null, null)).toBe('stack of 3, photo x');
  expect(PhotoGridStrings.showCompositeFrames(3, 'assembly')).toBe(
    'Show the 3 frames of this merge',
  );
  expect(PhotoGridStrings.frameBandLabel(3, 'panorama')).toBe('3 frames of this panorama');
});

test('a stack the camera shot as one capture is read out as that capture', () => {
  expect(PhotoGridStrings.tile(false, 5, 'x', null, 'exposureBracket')).toBe(
    'exposure bracket stack of 5, photo x',
  );
  expect(PhotoGridStrings.tile(false, 4, 'x', null, 'pixelShift')).toBe(
    'pixel shift stack of 4, photo x',
  );
  expect(PhotoGridStrings.showStack('x', 'focusBracket')).toBe(
    'Show the focus bracket stack x is in',
  );
  expect(PhotoGridStrings.bandLabel(5, 'exposureBracket')).toBe(
    '5 photos in this exposure bracket stack',
  );
});
