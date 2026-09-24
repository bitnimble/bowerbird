/**
 * Planar PQ, which is what an HDR render is and the one thing the import cannot carry: what to
 * divide its samples by to read them on the ten-bit scale the shader's ranges use, and how many
 * chroma pixels it holds per luma one.
 *
 * **4:4:4 as well as 4:2:0, because a rendition is written either.** A still whose 4:2:0 encode
 * would speckle is written full chroma (`job::CHROMA_LEAK_TILE_FRACTION`).
 *
 * Null for anything else, and narrowing this list costs a picture rather than a path: the ranges
 * and the YUV matrix are video-range BT.2020's, so a frame of another range has to take the
 * import - which is the one path that cannot carry PQ, and draws what it is given flat. Twelve
 * bits is what a rendition is written at (`avif.rs`); ten is still taken because a library
 * carries files written before it changed.
 */
export function planarLayout(frame: VideoFrame, rotation: 0 | 90 | 180 | 270 = 0): { depth: number; chroma: number } | null {
  const space = frame.colorSpace;
  const layout = {
    I420P10: { depth: 1, chroma: 0.5 },
    I420P12: { depth: 4, chroma: 0.5 },
    I444P10: { depth: 1, chroma: 1 },
    I444P12: { depth: 4, chroma: 1 },
  }[String(frame.format)];
  if (layout == null || String(space.transfer) !== 'pq' || space.fullRange === true) return null;
  // Only turns this stage can map between coded and displayed pixels stay on the HDR path.
  const sideways = rotation === 90 || rotation === 270;
  const width = sideways ? frame.codedHeight : frame.codedWidth;
  const height = sideways ? frame.codedWidth : frame.codedHeight;
  if (width !== frame.displayWidth || height !== frame.displayHeight) return null;
  return layout;
}
