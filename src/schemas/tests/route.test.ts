import { expect, test } from 'bun:test';
import { PathSegment, route } from '../route';

test('a route is its segments under a single leading slash', () => {
  expect(route()).toBe('/');
  expect(route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits())).toBe('/api/photos/p1/edits');
  expect(route(PathSegment.settings(), PathSegment.optionalParam('tab'))).toBe('/settings/:tab?');
  expect(route(PathSegment.param('id'), PathSegment.any())).toBe('/:id/*');
});

test('no segment carries a slash of its own', () => {
  const built = (segment: (name: string) => string): string => segment('x');
  for (const [name, segment] of Object.entries(PathSegment)) {
    expect(built(segment), name).not.toContain('/');
  }
});
