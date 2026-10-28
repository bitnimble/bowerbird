/// The auxiliary picture that carries a photograph's highlights, and the terms that apply it.
///
/// **An SDR base plus a gain map is how a phone stores an HDR photograph**, and it is the only way
/// a picture in a transfer with no headroom can have any: the base renders correctly on a display
/// that knows nothing about this, and the map says what each pixel would have been. ISO 21496-1 is
/// the spelling; `heif::gain_map` and `jpeg_gain::read` are where each container's is found.
pub struct GainMap {
    /// Three channels interleaved at the map's own resolution - which is usually half the
    /// picture's and legally anything - and at its own coded depth, which [`GainMap::last`]
    /// carries. A single-channel map is replicated on the way in, which costs a plane and removes
    /// a branch from every pixel of the kernel.
    pub samples: Vec<u16>,
    pub width: usize,
    pub height: usize,
    /// The code value meaning a recovery of one, which is the map's depth and not the picture's.
    pub last: f32,
    pub terms: Reconstruction,
}

/// How a map's recovery values become the gain applied to the base.
///
/// **Two spellings, and they are different curves rather than different constants.** ISO's gain is
/// exponential in the recovery and Apple's is linear in it, so at half recovery a headroom of 8
/// means 2.83x under one and 4.5x under the other - which is a stop and a half through every
/// highlight. Named apart so a reader cannot be handed one arm's terms under the other's rule.
pub enum Reconstruction {
    /// ISO 21496-1, per channel: `(base + offset_base) * 2^lerp(min, max, r^(1/gamma))` less
    /// `offset_alternate`.
    Iso {
        /// log2 of the gain at recovery 0 and at recovery 1.
        min: [f32; 3],
        max: [f32; 3],
        gamma: [f32; 3],
        offset_base: [f32; 3],
        offset_alternate: [f32; 3],
    },
    /// Apple's own, from `apple_gain`: `base * (1 + (headroom - 1) * r)`, one headroom for all
    /// three channels because the map itself is monochrome.
    Apple { headroom: f32 },
}

impl GainMap {
    /// Whether this map would change anything, which a map with no range to lerp across would not.
    pub fn does_anything(&self) -> bool {
        let reaches = match &self.terms {
            Reconstruction::Iso { min, max, .. } => (0..3).any(|c| min[c] != 0.0 || max[c] != 0.0),
            Reconstruction::Apple { headroom } => *headroom > 1.0,
        };
        self.width > 0
            && self.height > 0
            && self.samples.len() >= self.width * self.height * 3
            && reaches
    }

    pub fn brightest(&self, base: f64) -> f64 {
        self.terms.brightest(base)
    }
}

impl Reconstruction {
    /// The brightest any channel at `base` can come out, in units of diffuse white.
    pub fn brightest(&self, base: f64) -> f64 {
        match self {
            Reconstruction::Iso {
                min,
                max,
                offset_base,
                offset_alternate,
                ..
            } => (0..3)
                .map(|c| {
                    let gain = f64::from(min[c].max(max[c])).exp2();
                    (base + f64::from(offset_base[c])) * gain - f64::from(offset_alternate[c])
                })
                .fold(base, f64::max),
            Reconstruction::Apple { headroom } => base * f64::from(*headroom).max(1.0),
        }
    }
}
