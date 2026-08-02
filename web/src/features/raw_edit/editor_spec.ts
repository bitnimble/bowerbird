import type { Settings } from '../../../../src/schemas/settings';

// What the wasm editor has to be told before it can grade the way a rendition does.
//
// The server reads all of this from the library for its own renders, and the editor used
// to inline the shipping defaults instead - so a library whose peak, anchor or denoise had
// been moved showed one picture in the viewer and produced a different one on disk. The
// field names are the Rust struct's (`wasm::EditorSpec`), since this crosses as JSON.

/**
 * Longest edge a drag grades at.
 *
 * Not a setting: resolution is the disposable part while the slider moves, and this is
 * the size at which the exact camera-space grade still lands inside a frame's budget.
 * Tone and colour are never approximated, only pixel count.
 */
const INTERACTIVE_EDGE = 960;

export type EditorSpec = {
  longEdge: number;
  interactiveEdge: number;
  grade: {
    peakNits: number;
    referenceWhiteNits: number;
    whiteQuantile: number;
  };
  strengths: {
    luma: number;
    chroma: number;
    sharpen: number;
    defringe: number;
  };
} & Sink;

/** What the editor writes its frames into, which is the route's half of the spec. */
export type Sink = {
  /** `wasm::Sink`: planes for a `VideoFrame`, a whole PNG, or a whole AVIF. */
  sink: 'video' | 'still' | 'avif';
  /** Only the video sink reads it. A browser capability rather than a preference. */
  tenBit: boolean;
};

export function editorSpec(settings: Settings, longEdge: number, sink: Sink): EditorSpec {
  return {
    longEdge,
    interactiveEdge: INTERACTIVE_EDGE,
    grade: {
      peakNits: settings.hdr_peak_nits,
      referenceWhiteNits: settings.hdr_reference_white_nits,
      whiteQuantile: settings.hdr_white_quantile,
    },
    strengths: {
      luma: settings.raw_denoise_luma,
      chroma: settings.raw_denoise_chroma,
      sharpen: settings.raw_sharpen,
      defringe: settings.raw_defringe,
    },
    ...sink,
  };
}
