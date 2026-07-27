// One vocabulary for every derived copy of a photo (DESIGN §10.2).
//
// These used to be three trees with three names - `thumbnails/`, `previews/` and
// `lossless/` - which meant `thumbnails/full` was a 3840px image the viewer
// showed by default and `previews/` was the one thing the viewer did *not* show
// by default. They are all the same idea at different sizes and dynamic ranges,
// so they are all renditions now, and each one exists for a stated reason:
//
//   grid      800px SDR, the library grid. Always SDR whatever the library is
//             set to: a wall of HDR tiles is punishing to look at, and it would
//             put a linear decode and two encoder passes on every import.
//   full      3840px, the photo view. HDR when the library asks for it.
//   max       native resolution, the pixel-peeping view. HDR likewise.
//
// The camera's embedded JPEG is deliberately not in this list. It is the original
// bytes, served straight out of the RAW like the RAW itself, never resized into
// HDR or transcoded into AVIF and called a rendition of its own.

export const RENDITIONS = ['grid', 'full', 'max'] as const;
export type Rendition = (typeof RENDITIONS)[number];

export function isRendition(value: string): value is Rendition {
  return (RENDITIONS as readonly string[]).includes(value);
}

// HDR is stored beside the SDR copy rather than replacing it, so turning the
// setting off does not throw away work that turning it back on would redo. The
// video twin gets its own directory rather than sitting beside the still it
// belongs to, because the orphan sweep keys on the one extension a directory is
// supposed to hold, and two in one directory would have it delete the video as a
// superseded format on every pass (§10.6).
export function renditionDir(rendition: Rendition, hdr: boolean, video = false): string {
  if (!hdr) return rendition;
  return video ? `${rendition}-hdr-video` : `${rendition}-hdr`;
}

// The one-frame AV1 twin of an HDR rendition, for Firefox on Windows (§10.7).
// Only HDR has one: there is nothing an SDR video would show that the still does
// not.
export function renditionExtension(video: boolean): string {
  return video ? '.mp4' : '.avif';
}

// Every directory a rendition can live in, paired with the one extension it
// holds, for the sweeps that clear a photo's derived copies and remove orphans.
export function renditionDirs(): { dir: string; extension: string }[] {
  return RENDITIONS.flatMap((rendition) => [
    { dir: renditionDir(rendition, false), extension: renditionExtension(false) },
    { dir: renditionDir(rendition, true), extension: renditionExtension(false) },
    { dir: renditionDir(rendition, true, true), extension: renditionExtension(true) },
  ]);
}

export function renditionContentType(video: boolean): string {
  return video ? 'video/mp4' : 'image/avif';
}
