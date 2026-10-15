import { afterEach, beforeEach, expect, test } from 'bun:test';
import { registerDom } from '../../test_dom';

registerDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { HdrPictures } = await import('../hdr_pictures');
const { useHdrPicture } = await import('../hdr_picture');

const PUBLIC = `${import.meta.dir}/../../../public/hdr`;
const HDR = new Uint8Array(await Bun.file(`${PUBLIC}/swatches.avif`).arrayBuffer());
const SDR = new Uint8Array(await Bun.file(`${PUBLIC}/gamut-sdr.avif`).arrayBuffer());
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const SOURCE = { still: '/still.avif', tenBit: (match: string) => `/still.avif?match=${match}` };
const COPY = SOURCE.tenBit('mac-video');

let fetched: string[] = [];
const revoked: string[] = [];
URL.revokeObjectURL = (url: string): void => void revoked.push(url);

function serving(bytes: Uint8Array<ArrayBuffer>): (url: string) => Promise<Response> {
  return (url) => {
    fetched.push(url);
    return Promise.resolve(new Response(bytes));
  };
}

function throughVideo(bytes: Uint8Array<ArrayBuffer>): InstanceType<typeof HdrPictures> {
  return new HdrPictures(true, 'mac-video', serving(bytes));
}

beforeEach(() => {
  fetched = [];
  revoked.length = 0;
});

afterEach(cleanup);

test('where stills show as they are, the still is every file and nothing is rewrapped', async () => {
  const pictures = new HdrPictures(false, 'still', serving(HDR));
  expect(pictures.shownFile(SOURCE)).toBe(SOURCE.still);
  expect(pictures.pixelFile(SOURCE)).toBe(SOURCE.still);
  expect(await pictures.video(SOURCE)).toBeNull();
  expect(fetched).toEqual([]);

  const { result } = renderHook(() => useHdrPicture(SOURCE, { pictures }));
  expect(result.current.shown).toEqual({ kind: 'image', url: SOURCE.still });
});

test('through video, an HDR still is shown as an MP4 of its copy, held until released', async () => {
  const pictures = throughVideo(HDR);
  expect(pictures.shownFile(SOURCE)).toBe(COPY);

  const { result, unmount } = renderHook(() => useHdrPicture(SOURCE, { pictures }));
  expect(result.current.shown, 'nothing while the video is made').toBeNull();
  await act(async () => {});
  const shown = result.current.shown;
  expect(shown?.kind).toBe('video');
  expect(fetched).toEqual([COPY]);
  expect(pictures.isShown(SOURCE)).toBe(true);

  unmount();
  expect(revoked).toEqual([shown?.url ?? '']);
  expect(pictures.isShown(SOURCE)).toBe(false);
});

test('pixels of an HDR copy come from the still, whose SDR range is not coded for video', async () => {
  const pictures = throughVideo(HDR);
  await pictures.video(SOURCE);
  expect(pictures.pixelFile(SOURCE)).toBe(SOURCE.still);
});

test('through video, a file that is not HDR is shown and decoded from the copy URL, which is that file', async () => {
  for (const bytes of [SDR, JPEG]) {
    const pictures = throughVideo(bytes);
    const { result } = renderHook(() => useHdrPicture(SOURCE, { pictures }));
    await act(async () => {});
    expect(result.current.shown).toEqual({ kind: 'image', url: COPY });
    expect(pictures.pixelFile(SOURCE)).toBe(COPY);
  }
});

test('a video that will not play gives back the copy as an image, not the still', async () => {
  const pictures = throughVideo(HDR);
  const { result } = renderHook(() => useHdrPicture(SOURCE, { pictures }));
  await act(async () => {});
  act(() => result.current.failed());
  expect(result.current.shown).toEqual({ kind: 'image', url: COPY });
});
