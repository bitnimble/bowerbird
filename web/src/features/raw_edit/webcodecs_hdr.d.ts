// The two places the bundled lib.dom is behind the browser.
//
// `VideoPixelFormat` there is `"BGRA" | ... | "RGBX"` and `VideoTransferCharacteristics`
// is `"bt709" | "iec61966-2-1" | "smpte170m"` - which is the WebCodecs spec as written,
// and the reason DESIGN §10.7 concluded HDR could not be fed to a `VideoFrame` at all.
// Chrome 149 accepts `I444P10`, `I420P10` and `transfer: "pq"`; measured, not read off a
// spec. Both are type aliases rather than interfaces, so neither can be widened by
// declaration merging - hence one cast, at the single construction site.

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' });
  readonly writable: WritableStream<VideoFrame>;
}

/**
 * The standard shape, which is what Safari 18+ implements. Worker scope only, and unlike
 * Chromium's it is not itself a track - it owns one, and that track transfers.
 */
declare class VideoTrackGenerator {
  constructor();
  readonly track: MediaStreamTrack;
  readonly writable: WritableStream<VideoFrame>;
}

/** A PQ frame, at whichever depth the browser will accept one. */
type HdrVideoFrameBufferInit = Omit<VideoFrameBufferInit, 'format' | 'colorSpace'> & {
  format: 'I444P10' | 'I444';
  colorSpace: {
    primaries: 'bt2020';
    transfer: 'pq';
    matrix: 'bt2020-ncl';
    fullRange: boolean;
  };
};
