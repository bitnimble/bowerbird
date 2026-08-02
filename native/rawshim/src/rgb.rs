// Interleaved 8-bit RGB, owned and borrowed.
//
// Plain buffers, named for what they are rather than for what produced them. They lived
// in `vips` because that is what first returned one, which kept every consumer of a
// pixel buffer - the fit, the pixel maths, the frame - nominally dependent on libvips.
// That is a build-time dependency a browser cannot satisfy, for types containing a width,
// a height and some bytes.

/// Interleaved 8-bit RGB, owned. What an operation produces.
pub struct Rgb {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Rgb {
    pub fn as_ref(&self) -> RgbRef<'_> {
        RgbRef {
            width: self.width,
            height: self.height,
            data: &self.data,
        }
    }
}

/// Interleaved 8-bit RGB, borrowed. What an operation reads.
///
/// Every entry point takes one of these rather than `&Rgb`, so pixels held by something
/// else - a decode handle TypeScript is keeping alive, most of the time - can be operated
/// on where they lie. The owned form was the whole surface once, and it meant a ~45MB
/// copy at each end of every call for images no caller ever wanted materialised.
#[derive(Clone, Copy)]
pub struct RgbRef<'a> {
    pub width: usize,
    pub height: usize,
    pub data: &'a [u8],
}
