// `rawler`'s `Orientation`, numbered as `decode_rawler::orient` walks it on the host.
module orientation;

/// Which pixel of the unoriented frame an upright one came from, for an invocation that owns an
/// output pixel. `frame` is the unoriented frame's size.
///
/// Every case is its own inverse but the two quarter turns, which are each other's.
public uint2 unoriented(uint2 upright, uint2 frame, uint orientation)
{
    let last = frame - 1;
    let ox = upright.x;
    let oy = upright.y;
    switch (orientation) {
    case 1: { return uint2(last.x - ox, oy); }          // HorizontalFlip
    case 2: { return uint2(last.x - ox, last.y - oy); } // Rotate180
    case 3: { return uint2(ox, last.y - oy); }          // VerticalFlip
    case 4: { return uint2(oy, ox); }                   // Transpose
    case 5: { return uint2(oy, last.y - ox); }          // Rotate90's inverse
    // Transverse: `ox` runs over the frame's *height* and `oy` over its width, so the two lasts
    // swap here where they do not in the forward direction.
    case 6: { return uint2(last.x - oy, last.y - ox); }
    case 7: { return uint2(last.x - oy, ox); }          // Rotate270's inverse
    default: { return uint2(ox, oy); }                  // Normal, Unknown
    }
}
