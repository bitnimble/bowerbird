// What a reload has to bring back, and what a fresh visit must not have.
import { expect, test } from 'bun:test';
import { PathSegment, route } from '../../../../../../src/schemas/route';
import { asksAnything, gridUrlHref, readGridUrl } from '../grid_url';

const PAGE = `https://example.test${route(PathSegment.libraries(), 'lib-1')}`;

test('a position and a question survive a round trip through the address bar', () => {
  const state = { at: 4213, filters: { search: 'DSC02', takenFrom: '2024-03-01', takenTo: '2024-03-09' } };
  const href = gridUrlHref(PAGE, state);
  expect(readGridUrl(new URL(href).search)).toEqual(state);
});

test('nothing asked is nothing carried', () => {
  const href = gridUrlHref(`${PAGE}?at=12&q=beta&from=2024-03-01`, {
    at: 0,
    filters: { search: '', takenFrom: undefined, takenTo: undefined },
  });
  expect(href).toBe(PAGE);
  expect(asksAnything(readGridUrl('').filters)).toBe(false);
});

test('an unrelated parameter is left where it was', () => {
  expect(gridUrlHref(`${PAGE}?edit=1`, { at: 7, filters: {} })).toBe(`${PAGE}?edit=1&at=7`);
});

test('a hand-edited URL cannot hand the calendar a date it has no answer for', () => {
  const { at, filters } = readGridUrl('?at=nonsense&from=last%20tuesday&to=2024-3-9&q=beta');
  expect(at).toBe(0);
  expect(filters.takenFrom).toBeUndefined();
  expect(filters.takenTo).toBeUndefined();
  // The search is a filename fragment, so anything typed is a legitimate question.
  expect(filters.search).toBe('beta');
  expect(asksAnything(filters)).toBe(true);
});
