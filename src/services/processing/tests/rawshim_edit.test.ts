// What this side of the boundary still owns. The framing itself moved: `edit::encode` writes
// the reply in the shape the page reads, padding and all, and pins it in
// `native/rawshim/src/edit.rs` - so there is nothing here that takes a frame apart to check
// it, and nothing that puts one back together.
import { describe, it, expect } from 'bun:test';
import { headerOf, prepareEditAsync } from '../rawshim_edit';

// The specimens below are the ones that cross into the native library, and they are the ones
// that used to segfault Bun: the completion arrived through a `JSCallback` marked `threadsafe`,
// entered from the thread doing the open. Five crashes in forty runs of these, against none of
// the pure ones. `test/integration/threadsafe_callback.integration.test.ts` keeps it gone -
// nothing a test here could catch a runtime crash with.

// Nothing else bounds how many opens run at once. It used to block this thread, which
// serialised it by accident; a thread per call does not, and the client cannot cancel work
// the native side has already begun - so opening the editor, pressing Escape and opening it
// again leaves the first decode running with the second beside it. Ten of those is ten
// simultaneous LibRaw decodes of the same 61MP RAW, several gigabytes, and the process.
//
// A missing file rather than a fixture: the dedup happens before the work does, and the
// request being refused is what makes this fast and what pins the release.
describe('opens in flight', () => {
  const request = {
    rawFilePath: '/nonexistent/never-was.arw',
    longEdge: 8000,
    grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 },
    strengths: { luma: 1, chroma: 1, sharpen: 1, defringe: 1 },
  };

  // Settled before the assertion rather than after it, so a failing one does not also leave
  // a rejection with nobody holding it - which Bun reports against whichever test is
  // running by then, and that is not this one.
  it('share one, when they are the same open', async () => {
    const first = prepareEditAsync(request);
    const second = prepareEditAsync({ ...request });
    const done = Promise.allSettled([first, second]);
    expect(second).toBe(first);
    await done;
  });

  it('do not share one across different requests', async () => {
    const first = prepareEditAsync(request);
    const other = prepareEditAsync({ ...request, longEdge: 4000 });
    const done = Promise.allSettled([first, other]);
    expect(other).not.toBe(first);
    await done;
  });

  // The other half: held only while it is in flight, or the second visit to a photo would
  // be answered by the first visit's frame forever.
  it('are let go of once they have finished', async () => {
    const first = prepareEditAsync(request);
    await first.catch(() => {});
    const second = prepareEditAsync({ ...request });
    expect(second).not.toBe(first);
    await second.catch(() => {});
  });

  // A failed open is a reply like any other, and the only part of it this side reads. The
  // reason has to survive: without it the route answers "could not open this RAW" with no
  // sign of which of a decode's several ways of failing happened.
  it('reports the reason a refused open came back with', async () => {
    const failed = await prepareEditAsync(request).catch((error: unknown) => error);
    expect(String(failed)).toContain('never-was.arw');
  });
});

describe('headerOf', () => {
  // Reads the header without touching what follows it, which is the whole point: at 61MP the
  // samples are 361MB and the server has no use for a single one of them.
  it('reads the header out of a framed reply', () => {
    const header = { ok: true, width: 3, height: 2 };
    const json = new TextEncoder().encode(`${JSON.stringify(header)}  `);
    const framed = new Uint8Array(4 + json.byteLength + 12);
    new DataView(framed.buffer).setUint32(0, json.byteLength, true);
    framed.set(json, 4);

    expect(headerOf(framed)).toMatchObject({ ok: true, width: 3, height: 2 });
  });

  // The padding is JSON's own whitespace and is handed to `JSON.parse` rather than trimmed,
  // which is why it has to be spaces: a NUL is "Unrecognized token" there.
  it('parses a header padded out to a multiple of four', () => {
    const json = new TextEncoder().encode('{"ok":true} ');
    const framed = new Uint8Array(4 + json.byteLength);
    new DataView(framed.buffer).setUint32(0, json.byteLength, true);
    framed.set(json, 4);

    expect(json.byteLength % 4).toBe(0);
    expect(headerOf(framed).ok).toBe(true);
  });
});
