// A decoded frame, owned by an ordinary Rust value.
//
// **Owned by a scope, not by a convention.** A frame leaked across the FFI with `Box::into_raw`
// so JavaScript can hold it between calls has a lifetime the compiler does not know, and every
// read of its pixels goes through `slice::from_raw_parts` with a lifetime nobody checks. A
// `Frame` is owned by whatever made it and borrowed with real references, so the borrow checker
// enforces what a comment otherwise has to.
//
// **Samples are typed, not bytes reinterpreted.** A 16-bit decode holds `Vec<u16>`, not a
// `Vec<u8>` read back as `u16`. Handing a single `*mut u8` across a boundary and freeing it as
// one allocation forces the latter, and reconstituting a `Vec<u16>` from those bytes is
// undefined - the allocator is owed the layout it gave out, and the alignments differ - so every
// reader ends up transmuting. Owning the right type removes both the transmute and the alignment
// question.

/// A frame's samples where a shader can read them, however they got there.
///
/// A `Cow` in all but name: `Resident` is not `Clone` - a frame is hundreds of megabytes and an
/// implicit copy of one is not a thing to offer - so the two arms are spelt out.
pub enum OnDevice<'a> {
    Held(&'a crate::resident::Resident),
    Uploaded(crate::resident::Resident),
}

impl std::ops::Deref for OnDevice<'_> {
    type Target = crate::resident::Resident;

    fn deref(&self) -> &crate::resident::Resident {
        match self {
            OnDevice::Held(frame) => frame,
            OnDevice::Uploaded(frame) => frame,
        }
    }
}

/// Interleaved RGB samples at the depth the decode produced.
pub enum Pixels {
    /// 8-bit sRGB, three channels.
    Eight(Vec<u8>),
    /// 16-bit scene-linear, three channels.
    Sixteen(Vec<u16>),
    /// The same, still in VRAM where the demosaic wrote it.
    ///
    /// **What the pipeline is handed.** Every stage after the decode is a shader, so reading the
    /// frame back here only to upload it again for the coding is 366MB each way at 61MP for nothing.
    /// [`Frame::to_host`] is the transfer, and it belongs at the one place a host stage reads - the
    /// camera match, which wants linear samples, and the sharpen.
    Resident(crate::resident::Resident),
}

impl Pixels {
    pub fn depth(&self) -> u32 {
        match self {
            Pixels::Eight(_) => 8,
            Pixels::Sixteen(_) | Pixels::Resident(_) => 16,
        }
    }

    /// How many samples there are, whatever their width.
    pub fn len(&self) -> usize {
        match self {
            Pixels::Eight(data) => data.len(),
            Pixels::Sixteen(data) => data.len(),
            Pixels::Resident(frame) => frame.samples(),
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
    /// Photosites a side in the block each pixel was combined off, rather than demosaiced (10.4).
    ///
    /// **1, 2 or 3, and not a boolean, because the factor is the sensor's.** A Bayer 2x2 is the
    /// smallest block holding every colour; X-Trans has none, and its smallest is the 3x3. Everything
    /// that reads this is recovering the sensor's own long edge from the frame's - the sharpen's
    /// sigma is measured in photosites - so a frame reduced by three and reported as halved carries a
    /// blur two thirds the width of the one it deconvolves.
    pub reduced: usize,
    /// The illuminant the decode balanced against, from the camera's own multipliers
    /// and its own matrix.
    ///
    /// Read here rather than recomputed downstream because the samples that come out
    /// carry no trace of what was divided out of them. None where the file recorded
    /// nothing usable, which is the same case `camera_multipliers` declines.
    pub as_shot: Option<crate::white_balance::AsShot>,
    /// The sensor's noise, as the denoise fitted it off this frame's mosaic.
    ///
    /// None where the decode had no adapter or a filter array that does not tile into 2x2
    /// sites. It is the only physical description of this photograph's noise anything
    /// downstream has, and unlike the ISO it can tell a pushed exposure from a clean one.
    pub noise: Option<crate::galosh::NoiseFit>,
    /// The particles this decode found on the cover glass, where it was the one to look.
    ///
    /// Travels beside the noise fit because it is the same kind of thing: measured off the mosaic,
    /// a property of the file rather than of any setting, and expensive enough that the caller keeps
    /// it. Every candidate, not the ones the reader's sensitivity keeps (`crate::dust`).
    pub dust: Option<Vec<crate::dust::Spot>>,
    /// The camera-to-rec2020 matrix the demosaic's `assemble` multiplied these samples by.
    ///
    /// Here for the reason `as_shot` is: the samples carry no trace of it, and a stage downstream
    /// that needs to know what the reconstruction's *noise* looks like cannot recover it from them.
    /// The defringe is that stage - RCD's channel correlations are a property of the lattice and so
    /// the same on every camera, but the frame it measures is past this, and `sigma.out = M.sigma.M'`
    /// needs the `M`. None for a frame no demosaic produced.
    pub matrix: Option<[[f32; 3]; 3]>,
    /// The level a neutral clips at, as a fraction of full scale.
    ///
    /// **What a display-referred read of these samples has to divide by.** The conditioning gives
    /// each channel its own ceiling so a highlight keeps the colour its unsaturated channels still
    /// carry (`decode_rawler::channel_ceilings`), which puts full scale at the *most* amplified
    /// channel's saturation - a level only a clipping sensor reaches. Nothing grading these samples
    /// can see that, the levels being a quantile of the frame itself; a read with no quantile
    /// would render every photograph by however far apart that camera's white balance put its
    /// channels.
    ///
    /// One for a frame that came from no sensor, which is every synthetic fixture.
    pub neutral_ceiling: f32,
    /// The camera's own multipliers, as R, G and B (`decode_rawler::channel_ceilings`).
    ///
    /// Here for the reason `matrix` above is: what the demosaic did to the *noise* cannot be read
    /// back off the samples. `galosh::NoiseFit` is fitted on the mosaic, before these are applied,
    /// and a channel scaled by `g` carries `g` times the shot variance and `g^2` times the read
    /// variance - so a model pushed forward without them has the two terms in the wrong ratio
    /// (`base::noise_through_balance`).
    ///
    /// Ones for a frame that came from no sensor, which is every synthetic fixture, and the case
    /// the correction collapses to a constant in.
    pub wb_gains: [f32; 3],
    /// The level the file states diffuse white at, for a finished picture; None for a RAW, whose
    /// white is a quantile of its own scene.
    pub stated_white: Option<crate::light::Light<crate::light::Level>>,
}

impl Frame {
    pub fn new(width: usize, height: usize, pixels: Pixels) -> Frame {
        Frame {
            width,
            height,
            pixels,
            reduced: 1,
            as_shot: None,
            noise: None,
            dust: None,
            matrix: None,
            neutral_ceiling: 1.0,
            wb_gains: [1.0; 3],
            stated_white: None,
        }
    }

    /// The white to anchor the levels at, where a caller `asked` for the file's own over the
    /// measured one.
    pub fn white_to_anchor(&self, asked: bool) -> Result<Option<crate::light::Light<crate::light::Level>>, String> {
        match (asked, self.stated_white) {
            (false, _) => Ok(None),
            (true, Some(white)) => Ok(Some(white)),
            (true, None) => Err("this photograph states no white to anchor at".to_string()),
        }
    }

    /// The 8-bit samples, borrowed. None for a 16-bit frame.
    ///
    /// Separate accessors per depth rather than one returning bytes, because the two
    /// are not interchangeable and reading either as the other renders half a frame.
    /// The borrow is a real one: the compiler will not let the `Frame` be dropped or
    /// moved while it is out, which is the whole reason this type exists.
    pub fn rgb8(&self) -> Option<crate::rgb::RgbRef<'_>> {
        match &self.pixels {
            Pixels::Eight(data) => Some(crate::rgb::RgbRef {
                width: self.width,
                height: self.height,
                data,
            }),
            Pixels::Sixteen(_) | Pixels::Resident(_) => None,
        }
    }

    /// The 8-bit samples, borrowed mutably. None for a 16-bit frame.
    pub fn rgb8_mut(&mut self) -> Option<&mut [u8]> {
        match &mut self.pixels {
            Pixels::Eight(data) => Some(data),
            Pixels::Sixteen(_) | Pixels::Resident(_) => None,
        }
    }

    /// The 16-bit samples, borrowed. None for an 8-bit frame, and for one still on the device -
    /// [`Frame::to_host`] is what brings that one within reach.
    pub fn samples16(&self) -> Option<&[u16]> {
        match &self.pixels {
            Pixels::Sixteen(data) => Some(data),
            Pixels::Eight(_) | Pixels::Resident(_) => None,
        }
    }

    /// The 16-bit samples, borrowed mutably, for a stage that transforms in place.
    ///
    /// The grade and the PQ transfer are both sample-for-sample at the same index,
    /// so they write into the frame rather than allocating beside it (10.7).
    pub fn samples16_mut(&mut self) -> Option<&mut [u16]> {
        match &mut self.pixels {
            Pixels::Sixteen(data) => Some(data),
            Pixels::Eight(_) | Pixels::Resident(_) => None,
        }
    }

    /// Takes the 16-bit samples, consuming the frame.
    ///
    /// For the last reader, which wants the samples and the size and not a `Frame` around them:
    /// holding one as well keeps a whole decode resident across the longest stage of the job.
    pub fn into_samples16(self) -> Option<Vec<u16>> {
        match self.pixels {
            Pixels::Sixteen(data) => Some(data),
            Pixels::Eight(_) | Pixels::Resident(_) => None,
        }
    }

    /// The frame on the device, for a stage about to run a shader over it.
    pub fn resident(&self) -> Option<&crate::resident::Resident> {
        match &self.pixels {
            Pixels::Resident(frame) => Some(frame),
            Pixels::Eight(_) | Pixels::Sixteen(_) => None,
        }
    }

    /// The same, uploading first where the frame is not there yet.
    ///
    /// For the callers that hold a decode on the host and want a stage that only runs on the
    /// device - the tests, the examples, and `debug`. The shipped path never uploads here: the
    /// decode leaves the frame resident and every stage after it takes it as it stands.
    pub fn on_device(&self, gpu: &'static crate::gpu::Gpu) -> Option<OnDevice<'_>> {
        match &self.pixels {
            Pixels::Resident(frame) => Some(OnDevice::Held(frame)),
            _ => Some(OnDevice::Uploaded(crate::resident::Resident::upload(
                gpu,
                self.samples16()?,
                self.width,
                self.height,
            ))),
        }
    }

    /// Takes the frame off the device, leaving it where every other accessor can reach it.
    ///
    /// The transfer, spelt as one call rather than hidden in the decode: a caller that needs host
    /// samples says so here, and one that is only going to run more shaders never does. Already on
    /// the host is not an error - it is the 8-bit decodes and everything that has been through this
    /// once - so this is safe to call wherever samples are wanted. None only where the map failed,
    /// which is the same answer the decode itself gives when the device will not answer.
    pub async fn to_host(mut self) -> Option<Frame> {
        let taken = std::mem::replace(&mut self.pixels, Pixels::Sixteen(Vec::new()));
        self.pixels = match taken {
            Pixels::Resident(frame) => Pixels::Sixteen(frame.into_host().await?),
            held => held,
        };
        Some(self)
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
