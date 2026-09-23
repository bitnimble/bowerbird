import { describe, expect, test } from 'bun:test';
import { PathSegment, route } from '../../../../src/schemas/route';
import { inViewer } from '../sidebar_state';

describe('the sidebar hides itself in the viewer', () => {
  test('every path a photo opens at', () => {
    expect(inViewer(route(PathSegment.photos(), 'abc'))).toBe(true);
    expect(inViewer(route(PathSegment.libraries(), 'lib-1', PathSegment.photos(), 'abc'))).toBe(true);
    expect(inViewer(route(PathSegment.libraries(), 'lib-1', PathSegment.bin(), PathSegment.photos(), 'abc'))).toBe(true);
    expect(inViewer(route(PathSegment.shoots(), 's-1', PathSegment.photos(), 'abc'))).toBe(true);
    expect(inViewer(route(PathSegment.albums(), 'a-1', PathSegment.photos(), 'abc'))).toBe(true);
    expect(inViewer(route(PathSegment.photos(), 'abc', PathSegment.mockup()))).toBe(true);
    expect(inViewer(route(PathSegment.shoots(), 's-1', PathSegment.photos(), 'abc', PathSegment.mockup()))).toBe(true);
  });

  test('and nothing else', () => {
    expect(inViewer(route(PathSegment.libraries(), 'lib-1'))).toBe(false);
    expect(inViewer(route(PathSegment.libraries(), 'lib-1', PathSegment.noShoot()))).toBe(false);
    expect(inViewer(route(PathSegment.stacks(), 'st-1', PathSegment.triage()))).toBe(false);
    expect(inViewer(route(PathSegment.libraries(), 'lib-1', PathSegment.stacks(), 'st-1', PathSegment.triage()))).toBe(false);
    expect(inViewer(route(PathSegment.settings()))).toBe(false);
  });
});
