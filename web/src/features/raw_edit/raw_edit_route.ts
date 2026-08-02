import { needsHdrVideo } from 'avif-hdr-video';
import type { Sink } from './editor_spec';

// How a graded frame reaches this browser's compositor.
//
// Three blessed platforms, and each takes a different route for a reason that was
// measured rather than chosen. Nothing here is a preference: every branch is a capability
// the browser either has or refuses, so this is written as probes and findings. DESIGN
// 21.2 records what each one found.

/**
 * `track` - Chromium, anywhere. It accepts a 10-bit `VideoFrame` and composites a PQ
 * track, which is also the cheapest route there is: no encode, no blob, no decode, just
 * planes handed to a sink.
 *
 * `still` - Safari on macOS and iOS. WebKit validates I420 and NV12 alone, so a track
 * there is 8-bit, and Apple's guidance for the layer behind a `MediaStream` is that
 * sample buffers need 10 bits or more to reach EDR - a PQ tag on 8 bits is accepted and
 * then tone-mapped, which on an XDR panel is a washed-out picture. A PNG goes through
 * Core Graphics instead, which reads CICP and has no bit-depth floor, and carries 16 bits
 * at 4:4:4. The better frame, the worse drag.
 *
 * `rewrap` - Firefox. It composites HDR through video and only video, and every route to
 * a video frame in-page is capped at 8 bits, which it then will not composite either. So
 * the frame is encoded to a real 10-bit AV1 in wasm and rewrapped into an MP4 the same
 * way a rendition is (DESIGN 10.7.2) - the one route here that pays for an encode.
 */
export type Route = 'track' | 'still' | 'rewrap';

// None of these can change within a page load, and the components asking are rendered on
// every slider tick - and one of them builds a `VideoFrame` to find out.
function once<T>(measure: () => T): () => T {
  let answer: { value: T } | null = null;
  return () => (answer ??= { value: measure() }).value;
}

/**
 * Whether this browser will build a 10-bit `VideoFrame`.
 *
 * Measured rather than read off a spec, because the spec is wrong in both directions:
 * `VideoPixelFormat` lists neither `I444P10` nor `I420P10` and Chromium accepts both,
 * while Safari 26.4 and Firefox reject every 10-bit format there is.
 */
export const supportsTenBit = once((): boolean => {
  try {
    // Two bytes a sample and three full-resolution planes, so this is the smallest legal
    // frame in the format the track route packs.
    new VideoFrame(new Uint8Array(2 * 2 * 3 * 2), {
      format: 'I444P10',
      codedWidth: 2,
      codedHeight: 2,
      timestamp: 0,
    } as unknown as VideoFrameBufferInit).close();
    return true;
  } catch {
    return false;
  }
});

/**
 * The route this browser has to take, given what it will and will not composite.
 *
 * Gecko is picked out by `needsHdrVideo`, the package's own user-agent sniff, rather than
 * by a second one here. Normally the wrong tool, and here the only one: the failure is
 * that Gecko renders a PQ still *wrongly* rather than refusing it, so there is nothing
 * for a feature test to catch, and `(dynamic-range: high)` answers a different question
 * and answers it false on Firefox even on an HDR display.
 *
 * The still is the fallback rather than the rewrap, so an engine nobody here has measured
 * pays for no encode it may not need. It is also the arm Safari reaches.
 *
 * `?route=` exists so e2e can force still/rewrap on one engine and assert on those
 * routes' encoded bytes; production never needs it.
 */
export function routeFor(): Route {
  const forced = new URLSearchParams(location.search).get('route');
  if (forced === 'track' || forced === 'still' || forced === 'rewrap') return forced;
  if (supportsTenBit()) return 'track';
  return needsHdrVideo() ? 'rewrap' : 'still';
}

/** What the wasm editor has to be told to produce this route's frames. */
export function sinkFor(route: Route): Sink {
  return {
    sink: route === 'track' ? 'video' : route === 'still' ? 'still' : 'avif',
    tenBit: route === 'track',
  };
}
