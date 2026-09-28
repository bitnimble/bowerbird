import { expect, test } from 'bun:test';
import { LibraryActivity } from '../library_activity';

test('overlapping work counts each photo once until its last operation finishes', () => {
  const activity = new LibraryActivity();
  const first = activity.begin('library', 'rendering', 'photo');
  const second = activity.begin('library', 'rendering', 'photo');
  const other = activity.begin('other', 'rendering', 'photo');
  expect(activity.current('library')).toEqual([{ kind: 'rendering', count: 1 }]);
  first();
  first();
  expect(activity.current('library')).toEqual([{ kind: 'rendering', count: 1 }]);
  second();
  expect(activity.current('library')).toEqual([]);
  expect(activity.current('other')).toEqual([{ kind: 'rendering', count: 1 }]);
  other();
});

test('global tasks stay separate and failed work clears its activity', async () => {
  const activity = new LibraryActivity();
  const pending = Promise.withResolvers<void>();
  const run = activity.track(null, 'catalogue_backup', 'catalogue', () => pending.promise);
  expect(activity.current(null)).toEqual([{ kind: 'catalogue_backup', count: 1 }]);
  expect(activity.current('library')).toEqual([]);
  pending.reject(new Error('failed'));
  await expect(run).rejects.toThrow('failed');
  expect(activity.current(null)).toEqual([]);
});
