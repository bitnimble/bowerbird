// The rewrap is the whole AVIF fetched again, and the flip between a render and the
// camera's JPEG is the gesture it sits behind - so what this pins is that flipping back
// costs nothing, and that the memory it buys that with is bounded by the open photograph.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { PathSegment, route } from '../../../../../../src/schemas/route';
import { registerDom } from '../../../../test_dom';

let made = 0;
const revoked: string[] = [];

void mock.module('avif-hdr-video', () => ({
  needsHdrVideo: (): boolean => true,
  orientationOfAvif: (): 0 => 0,
  hdrVideoUrl: (source: string): Promise<string> => {
    made += 1;
    return Promise.resolve(`blob:${source}`);
  },
}));

registerDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useHdrVideo } = await import('../hdr_video');

URL.revokeObjectURL = (url: string): void => void revoked.push(url);

const FULL = `${route(PathSegment.image(), 'p1', PathSegment.renditions(), 'full')}?v=1`;
const MAX = `${route(PathSegment.image(), 'p1', PathSegment.renditions(), 'max')}?v=1`;

beforeEach(() => {
  made = 0;
  revoked.length = 0;
});

afterEach(cleanup);


test('flipping to the camera JPEG and back rewraps once', async () => {
  const { result, rerender } = renderHook(
    ({ source, hdr }: { source: string; hdr: boolean }) => useHdrVideo('p1', source, hdr),
    { initialProps: { source: FULL, hdr: true } },
  );
  await act(async () => {});
  expect(result.current).toEqual({ still: FULL, url: `blob:${FULL}` });

  // Pressing I: the render is not what is on screen, so there is nothing to show through a
  // video - but the twin is not thrown away, because pressing O is what comes next.
  rerender({ source: route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'), hdr: false });
  await act(async () => {});
  expect(result.current).toBeNull();

  rerender({ source: FULL, hdr: true });
  await act(async () => {});
  expect(result.current).toEqual({ still: FULL, url: `blob:${FULL}` });
  expect(made, 'the second look at the render is free').toBe(1);
  expect(revoked).toEqual([]);
});

test('both renditions of one photograph are held, and both go when it does', async () => {
  const { result, rerender, unmount } = renderHook(
    ({ source }: { source: string }) => useHdrVideo('p1', source, true),
    { initialProps: { source: FULL } },
  );
  await act(async () => {});
  rerender({ source: MAX });
  await act(async () => {});
  expect(result.current).toEqual({ still: MAX, url: `blob:${MAX}` });

  // The picker flips between these two, so neither is dropped for the other.
  rerender({ source: FULL });
  await act(async () => {});
  expect(result.current).toEqual({ still: FULL, url: `blob:${FULL}` });
  expect(made).toBe(2);
  expect(revoked).toEqual([]);

  // Stepping to another photograph is what bounds it: an MP4 is resident whole for as long
  // as its URL is alive, so a session walking a collection would otherwise keep every one.
  unmount();
  expect([...revoked].sort()).toEqual([`blob:${FULL}`, `blob:${MAX}`].sort());
});
