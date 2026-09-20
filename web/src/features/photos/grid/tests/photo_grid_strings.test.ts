import { expect, test } from 'bun:test';
import { PhotoGridStrings } from '../photo_grid.strings';

test('a panorama and a merge are each read out as what they are', () => {
  expect(PhotoGridStrings.compositeName(3, 'panorama')).toBe('Panorama of 3 photos');
  expect(PhotoGridStrings.compositeName(3, 'assembly')).toBe('Merge of 3 photos');
  expect(PhotoGridStrings.tile(false, 3, 'x', 'assembly')).toBe('merge of 3 photos');
  expect(PhotoGridStrings.tile(false, 3, 'x', null)).toBe('stack of 3, photo x');
  expect(PhotoGridStrings.showCompositeFrames(3, 'assembly')).toBe('Show the 3 frames of this merge');
  expect(PhotoGridStrings.frameBandLabel(3, 'panorama')).toBe('3 frames of this panorama');
});
