// The rewrap is the whole AVIF fetched again, and the flip between a render and the
// camera's JPEG is the gesture it sits behind - so what this pins is that flipping back
// costs nothing, and that the memory it buys that with is bounded by the open photograph.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PathSegment, route } from '../../../../../../src/schemas/route';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { HdrTwins, useHdrVideo, useTenBitCopiesAhead } = await import('../hdr_video');

let made = 0;
const revoked: string[] = [];
let twins = new HdrTwins();

URL.revokeObjectURL = (url: string): void => void revoked.push(url);

const FULL = `${route(PathSegment.image(), 'p1', PathSegment.renditions(), 'full')}?v=1`;
const MAX = `${route(PathSegment.image(), 'p1', PathSegment.renditions(), 'max')}?v=1`;
const tenBit = (source: string): string => `${source}&bits=10`;

beforeEach(() => {
  made = 0;
  revoked.length = 0;
  twins = new HdrTwins(
    (source) => {
      made += 1;
      return Promise.resolve(`blob:${source}`);
    },
    () => true,
  );
});

afterEach(cleanup);

test('the twin stands for the still and is rewrapped from its 10-bit copy', async () => {
  const { result } = renderHook(() => useHdrVideo('p1', FULL, tenBit(FULL), true, twins));
  await act(async () => {});
  expect(result.current.twin).toEqual({ still: FULL, url: `blob:${tenBit(FULL)}` });
});

test("the neighbours' copies are asked for ahead, by HEAD, once per set", async () => {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    asked.push(`${init?.method} ${url}`);
    return Promise.resolve(new Response(null));
  }) as typeof fetch;
  try {
    const { rerender } = renderHook(
      ({ urls }: { urls: string[] }) => useTenBitCopiesAhead(urls, twins),
      { initialProps: { urls: [tenBit(FULL), tenBit(MAX)] } },
    );
    rerender({ urls: [tenBit(FULL), tenBit(MAX)] });
    await act(async () => {});
    expect(asked).toEqual([`HEAD ${tenBit(FULL)}`, `HEAD ${tenBit(MAX)}`]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('flipping to the camera JPEG and back rewraps once', async () => {
  const { result, rerender } = renderHook(
    ({ source, hdr }: { source: string; hdr: boolean }) =>
      useHdrVideo('p1', source, tenBit(source), hdr, twins),
    { initialProps: { source: FULL, hdr: true } },
  );
  await act(async () => {});
  expect(result.current.twin).toEqual({ still: FULL, url: `blob:${tenBit(FULL)}` });

  // Pressing I: the render is not what is on screen, so there is nothing to show through a
  // video - but the twin is not thrown away, because pressing O is what comes next.
  rerender({
    source: route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'),
    hdr: false,
  });
  await act(async () => {});
  expect(result.current.twin).toBeNull();

  rerender({ source: FULL, hdr: true });
  await act(async () => {});
  expect(result.current.twin).toEqual({ still: FULL, url: `blob:${tenBit(FULL)}` });
  expect(made, 'the second look at the render is free').toBe(1);
  expect(revoked).toEqual([]);
});

test('both renditions of one photograph are held, and both go when it does', async () => {
  const { result, rerender, unmount } = renderHook(
    ({ source }: { source: string }) => useHdrVideo('p1', source, tenBit(source), true, twins),
    { initialProps: { source: FULL } },
  );
  await act(async () => {});
  rerender({ source: MAX });
  await act(async () => {});
  expect(result.current.twin).toEqual({ still: MAX, url: `blob:${tenBit(MAX)}` });

  // The picker flips between these two, so neither is dropped for the other.
  rerender({ source: FULL });
  await act(async () => {});
  expect(result.current.twin).toEqual({ still: FULL, url: `blob:${tenBit(FULL)}` });
  expect(made).toBe(2);
  expect(revoked).toEqual([]);

  // Stepping to another photograph is what bounds it: an MP4 is resident whole for as long
  // as its URL is alive, so a session walking a collection would otherwise keep every one.
  unmount();
  expect([...revoked].sort()).toEqual([`blob:${tenBit(FULL)}`, `blob:${tenBit(MAX)}`].sort());
});

test('a rebuilt rendition drops the twin of the version it replaced', async () => {
  const rebuilt = FULL.replace('v=1', 'v=2');
  const { rerender } = renderHook(
    ({ source }: { source: string }) => useHdrVideo('p1', source, tenBit(source), true, twins),
    { initialProps: { source: FULL } },
  );
  await act(async () => {});
  rerender({ source: rebuilt });
  await act(async () => {});
  expect(revoked).toEqual([`blob:${tenBit(FULL)}`]);
});

test('a twin that will not play gives the still back, and is not made again', async () => {
  const { result, rerender } = renderHook(
    ({ source }: { source: string }) => useHdrVideo('p1', source, tenBit(source), true, twins),
    { initialProps: { source: FULL } },
  );
  await act(async () => {});
  act(() => result.current.failed());
  expect(result.current.twin).toBeNull();
  expect(revoked).toEqual([`blob:${tenBit(FULL)}`]);

  rerender({ source: MAX });
  await act(async () => {});
  rerender({ source: FULL });
  await act(async () => {});
  expect(result.current.twin).toBeNull();
  expect(made).toBe(2);
});
