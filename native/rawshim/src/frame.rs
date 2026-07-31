// A decoded frame, owned by an ordinary Rust value.
//
// This is what replaces `BbImage`. The difference is not the fields - they are
// nearly the same - but who owns them and for how long. `BbImage` was leaked with
// `Box::into_raw` so JavaScript could hold it between calls, which meant its
// lifetime was a convention rather than something the compiler knew, and every
// read of its pixels went through `slice::from_raw_parts` with a lifetime nobody
// checked. A `Frame` is owned by whatever scope made it and borrowed with real
// references, so the borrow checker enforces what the comments used to.
//
// **Samples are typed, not bytes reinterpreted.** A 16-bit decode holds
// `Vec<u16>`, not a `Vec<u8>` read back as `u16` - which the old code could not
// do, because it had to hand a single `*mut u8` across the boundary and free it as
// one allocation. Reconstituting a `Vec<u16>` from those bytes is undefined (the
// allocator is owed the layout it gave out, and the alignments differ), so the old
// decode wrote bytes and every reader transmuted. Owning the right type removes
// both the transmute and the alignment question.

/// Interleaved RGB samples at the depth the decode produced.
pub enum Pixels {
    /// 8-bit sRGB, three channels.
    Eight(Vec<u8>),
    /// 16-bit scene-linear, three channels.
    Sixteen(Vec<u16>),
}

impl Pixels {
    pub fn depth(&self) -> u32 {
        match self {
            Pixels::Eight(_) => 8,
            Pixels::Sixteen(_) => 16,
        }
    }

    /// How many samples there are, whatever their width.
    pub fn len(&self) -> usize {
        match self {
            Pixels::Eight(data) => data.len(),
            Pixels::Sixteen(data) => data.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub pixels: Pixels,
    /// Whether LibRaw demosaiced at half size (10.4).
    pub halved: bool,
    /// Whether the frame came straight out of `imgdata.image` rather than through
    /// `dcraw_make_mem_image`. Only the differential decode test reads it, and only
    /// to check that its two arms actually took different routes.
    pub direct: bool,
}

impl Frame {
    pub fn new(width: usize, height: usize, pixels: Pixels) -> Frame {
        Frame { width, height, pixels, halved: false, direct: false }
    }

    /// The 8-bit samples, borrowed. None for a 16-bit frame.
    ///
    /// Separate accessors per depth rather than one returning bytes, because the two
    /// are not interchangeable and reading either as the other renders half a frame.
    /// The borrow is a real one: the compiler will not let the `Frame` be dropped or
    /// moved while it is out, which is the whole reason this type exists.
    pub fn rgb8(&self) -> Option<crate::vips::RgbRef<'_>> {
        match &self.pixels {
            Pixels::Eight(data) => {
                Some(crate::vips::RgbRef { width: self.width, height: self.height, data })
            }
            Pixels::Sixteen(_) => None,
        }
    }

    /// The 8-bit samples, borrowed mutably. None for a 16-bit frame.
    pub fn rgb8_mut(&mut self) -> Option<&mut [u8]> {
        match &mut self.pixels {
            Pixels::Eight(data) => Some(data),
            Pixels::Sixteen(_) => None,
        }
    }

    /// The 16-bit samples, borrowed. None for an 8-bit frame.
    pub fn samples16(&self) -> Option<&[u16]> {
        match &self.pixels {
            Pixels::Sixteen(data) => Some(data),
            Pixels::Eight(_) => None,
        }
    }

    /// The 16-bit samples, borrowed mutably, for a stage that transforms in place.
    ///
    /// The grade and the PQ transfer are both sample-for-sample at the same index,
    /// so they write into the frame rather than allocating beside it (10.7).
    pub fn samples16_mut(&mut self) -> Option<&mut [u16]> {
        match &mut self.pixels {
            Pixels::Sixteen(data) => Some(data),
            Pixels::Eight(_) => None,
        }
    }

    /// Takes the 16-bit samples, consuming the frame.
    ///
    /// For the last reader, which no longer needs a `Frame` around them - the encode
    /// wants the samples and the size, and holding the frame as well is what used to
    /// keep a decode resident across the longest stage of the job.
    pub fn into_samples16(self) -> Option<Vec<u16>> {
        match self.pixels {
            Pixels::Sixteen(data) => Some(data),
            Pixels::Eight(_) => None,
        }
    }

    /// Whether the frame holds as many samples as its dimensions claim.
    ///
    /// Checked where a frame is built from something outside this module, so a short
    /// buffer is one clear failure rather than a panic somewhere downstream.
    pub fn is_consistent(&self) -> bool {
        self.pixels.len() == self.width * self.height * 3
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_depth_answers_only_its_own_accessor() {
        // The mistake this type exists to prevent: one buffer read at the wrong
        // width. There is no accessor that will hand 16-bit samples out as bytes,
        // so it is not expressible rather than merely discouraged.
        let eight = Frame::new(2, 2, Pixels::Eight(vec![0u8; 12]));
        assert!(eight.rgb8().is_some());
        assert!(eight.samples16().is_none());

        let sixteen = Frame::new(2, 2, Pixels::Sixteen(vec![0u16; 12]));
        assert!(sixteen.rgb8().is_none());
        assert!(sixteen.samples16().is_some());
    }

    #[test]
    fn a_short_buffer_is_reported_rather_than_trusted() {
        assert!(Frame::new(2, 2, Pixels::Eight(vec![0u8; 12])).is_consistent());
        assert!(!Frame::new(2, 2, Pixels::Eight(vec![0u8; 11])).is_consistent());
        assert!(Frame::new(2, 2, Pixels::Sixteen(vec![0u16; 12])).is_consistent());
        assert!(!Frame::new(2, 2, Pixels::Sixteen(vec![0u16; 11])).is_consistent());
    }
}
