// Which HDR renditions exist, and what they are called on disk and over HTTP
// (DESIGN §10.7).
//
// The vocabulary only. Building one is `native/rawshim` - the grade, the argv and the
// encoders all moved there so the graded frame, ~115MB at 24MP, stops crossing the
// FFI boundary to reach an encoder that was never on this side of it. What is left
// here is what routing and path-building need, which is every consumer outside the
// worker.
//
// The still is an AVIF, which Chrome renders as HDR on Android 14+ and on
// desktop, and Safari renders on macOS - including at 4:4:4, confirmed on an
// HDR display. Firefox honours no HDR image tagging at all - a PQ-tagged PNG and
// an untagged one read back identically - so for Firefox the same pixels are also
// encoded as a one-frame video, since its video pipeline does composite HDR on
// Windows by passing through to the compositor and the monitor. Neither can be
// checked from script, because anything read back through a canvas has already
// been tone-mapped, so both exist to be looked at on real hardware alongside an
// SDR reference to compare against.

// PQ only, plus the SDR reference to compare it against. HLG was carried for a
// while and never earned it: everything that renders HDR at all renders PQ, and
// PQ is absolute where HLG is relative to the display's own range, which makes
// it the wrong curve for judging whether a given panel reaches a given nits
// value.
export const HDR_VARIANTS = ['pq', 'sdr'] as const;
export type HdrVariant = (typeof HDR_VARIANTS)[number];

// 'still-baseline' is the same AVIF at 4:2:0, and exists only as a control.
// 4:4:4 is AVIF's Advanced profile (AV1 High), which a decoder may refuse while
// still claiming AVIF support - only Baseline is mandatory. Apple decodes images
// through the OS, and that stack has no 4:4:4 path for VP9, so whether it has
// one for AVIF is unknown. Without a 4:2:0 control beside it, a still failing on
// an Apple device cannot be told apart from a failure to handle HDR at all.
export const HDR_MEDIA = ['still', 'still-baseline', 'video'] as const;
export type HdrMedium = (typeof HDR_MEDIA)[number];

function isStill(medium: HdrMedium): boolean {
  return medium === 'still' || medium === 'still-baseline';
}

export function isHdrVariant(value: string): value is HdrVariant {
  return (HDR_VARIANTS as readonly string[]).includes(value);
}

export function isHdrMedium(value: string): value is HdrMedium {
  return (HDR_MEDIA as readonly string[]).includes(value);
}

export function extensionFor(medium: HdrMedium): string {
  return isStill(medium) ? '.avif' : '.mp4';
}

export function contentTypeFor(medium: HdrMedium): string {
  return isStill(medium) ? 'image/avif' : 'video/mp4';
}
