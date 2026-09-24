//! A finished picture's code values into the frame the pipeline reads, on the device.
//!
//! **The rendered half of [`crate::condition`] and [`crate::demosaic`] at once.** A RAW is
//! conditioned into a mosaic and then demosaiced into a Rec.2020 `u16` frame; a JPEG, a PNG, a HEIC
//! or an AVIF has no mosaic, so the same journey is one pass - undo the transfer, apply the gain
//! map, convert the primaries, crop, halve and turn upright. `linearise.slang` is that pass, and
//! everything below it in the pipeline is the code the RAWs run.
//!
//! The codes are held on the device between windows for the reason the mosaic is: the editor
//! re-prepares a photograph a band at a time, a loupe asks for tile after tile of one open, and a
//! rendition job asks for every size in turn. Each of those is this pass over a rectangle.

use crate::px::{Photograph, Rect, Size};


pub struct Linearise {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

/// Infallible for [`crate::condition::device`]'s reason: the kernel asks for nothing beyond storage
/// buffers, so a shader that would not build is a panic rather than a `None` anybody could handle.
pub fn device(gpu: &'static crate::gpu::Gpu) -> &'static Linearise {
    static BUILT: std::sync::OnceLock<Linearise> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Linearise::new(gpu))
}

impl Linearise {
    fn new(gpu: &crate::gpu::Gpu) -> Linearise {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("linearise"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/linearise.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let write = wgpu::BufferBindingType::Storage { read_only: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("linearise"),
            entries: &[
                entry(0, wgpu::BufferBindingType::Uniform),
                entry(1, read),
                entry(2, read),
                entry(3, read),
                entry(4, write),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("linearise"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("linearise"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("linearise"),
            compilation_options: Default::default(),
            cache: None,
        });
        Linearise { layout, pipeline }
    }
}

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
    fn does_anything(&self) -> bool {
        let reaches = match &self.terms {
            Reconstruction::Iso { min, max, .. } => {
                (0..3).any(|c| min[c] != 0.0 || max[c] != 0.0)
            }
            Reconstruction::Apple { headroom } => *headroom > 1.0,
        };
        self.width > 0
            && self.height > 0
            && self.samples.len() >= self.width * self.height * 3
            && reaches
    }

    /// Whether the transfer's own ceiling has to make room for this map, which is what
    /// `transfer::Coding::white_level` asks.
    ///
    /// Both arms reach at most `transfer::HDR_HEADROOM`: Apple's mapping clamps at three stops by
    /// construction, and an ISO map beyond that is brought inside the container by `within` rather
    /// than by moving diffuse white, since where white sits is what makes two files comparable.
    pub fn lifts(&self) -> bool {
        self.does_anything()
    }
}

/// A decoded picture where the kernel can reach it: the codes, what they mean, and the turn the
/// file asked for.
///
/// **Held rather than linearised once**, because a window of it is this pass over a rectangle and
/// the editor asks for many. The codes are `u16` whatever the file's depth is, packed two to a word
/// exactly as [`crate::resident::Resident`] packs samples - which is what lets `Resident::upload`
/// be the one uploader.
///
/// ponytail: an 8-bit picture holds two bytes a sample here where one would do. Pack four to a word
/// and give the kernel a second fetch if a phone-sized library ever makes the plane the thing that
/// does not fit.
pub struct Picture {
    codes: crate::resident::Resident,
    table: crate::gpu::Buffer,
    gain: crate::gpu::Buffer,
    gain_size: (usize, usize),
    terms: Option<GainMap>,
    /// The picture as its bytes are laid out, before the turn.
    pub stored: Size<Photograph>,
    /// What the file says the picture's top-left is, in `rawler`'s numbering.
    pub upright: rawler::decoders::Orientation,
    pub coding: crate::transfer::Coding,
}

impl Picture {
    /// Uploads a decoded picture and everything the kernel reads beside it.
    ///
    /// `codes` is interleaved RGB at `coding.depth` bits, left-aligned in nothing - a code is the
    /// value the decoder produced, and the table is indexed by it directly.
    pub fn upload(
        gpu: &'static crate::gpu::Gpu,
        codes: &[u16],
        width: usize,
        height: usize,
        coding: crate::transfer::Coding,
        upright: rawler::decoders::Orientation,
        gain: Option<GainMap>,
    ) -> Option<Picture> {
        if width == 0 || height == 0 || codes.len() < width * height * 3 {
            return None;
        }
        let codes = crate::resident::Resident::upload(gpu, codes, width, height);
        Some(Picture::on_device(gpu, codes, coding, upright, gain))
    }

    /// The same, for codes already on the device.
    pub fn on_device(
        gpu: &'static crate::gpu::Gpu,
        codes: crate::resident::Resident,
        coding: crate::transfer::Coding,
        upright: rawler::decoders::Orientation,
        gain: Option<GainMap>,
    ) -> Picture {
        let (width, height) = codes.size();
        let terms = gain.filter(GainMap::does_anything);
        let table = float_storage(gpu, &coding.table());
        // One word either way, because a binding may not be empty and the kernel's `gain_width`
        // is what says whether it is read at all.
        let (gain_size, samples) = match &terms {
            Some(map) => ((map.width, map.height), map.samples.as_slice()),
            None => ((0, 0), [0u16, 0].as_slice()),
        };
        Picture {
            codes,
            table,
            gain: packed_storage(gpu, samples),
            gain_size,
            terms,
            stored: Size::exact(width, height),
            upright,
            coding,
        }
    }

    /// The level this picture's diffuse white sits at in the frames it produces.
    ///
    /// **A finished picture states its white where a RAW's has to be measured**, which is the whole
    /// difference between grading one and grading the other: the transfer says where white is, and
    /// the gain map says whether the container had to make room above it.
    pub fn white_level(&self) -> crate::light::Light<crate::light::Level> {
        crate::light::Light::measured(self.coding.white_level(self.terms.is_some()))
    }

    /// The picture's size the way a reader sees it, which is the stored size with a quarter turn
    /// applied where the file asked for one.
    pub fn upright_size(&self) -> Size<Photograph> {
        match crate::orientation::transposes(self.upright) {
            true => Size::exact(self.stored.height.raw(), self.stored.width.raw()),
            false => self.stored,
        }
    }

    /// One rectangle of the picture as a scene-linear Rec.2020 frame, on the device.
    ///
    /// `window` is in the *upright* picture's own pixels, which is the space every caller above
    /// this names a region in (`crate::view`).
    pub fn window(
        &self,
        gpu: &'static crate::gpu::Gpu,
        kernels: &Linearise,
        window: Rect<Photograph>,
        scale: crate::view::Scale,
    ) -> Option<crate::resident::Resident> {
        let step = match scale {
            crate::view::Scale::Full => 1usize,
            crate::view::Scale::Half => 2usize,
        };
        // **Trimmed to whole steps before the turn, not after.** A halved window covers
        // `out * step` source pixels, and the shader walks the stored rectangle forward from its
        // origin - so a window mapped back untrimmed discards the stored raster's *far* edge,
        // which under a flip or a rotation is the upright picture's *near* one. The frame then
        // comes back shifted a pixel and missing the wrong column.
        let (out_w, out_h) = (window.size.width.raw() / step, window.size.height.raw() / step);
        if out_w == 0 || out_h == 0 {
            return None;
        }
        // The rectangle back through the turn, so it names the stored raster the codes are in.
        let stored = crate::orientation::unoriented_rect(
            crate::Tile {
                left: window.at.x.raw(),
                top: window.at.y.raw(),
                width: out_w * step,
                height: out_h * step,
            },
            self.stored.width.raw(),
            self.stored.height.raw(),
            self.upright,
        );
        // The unoriented output, which is what the kernel's turn is defined against: a quarter
        // turn swaps the two, and the halving applies to both the same way.
        let (frame_w, frame_h) = match crate::orientation::transposes(self.upright) {
            true => (out_h, out_w),
            false => (out_w, out_h),
        };

        let out = crate::resident::Resident::empty(gpu, out_w, out_h);
        let mut recording = gpu.record();
        // Every buffer the pass reads as well as the one it writes: `gpu::Buffer`'s `Drop` is a
        // `destroy`, not a refcount release, and both callers hand this a `Picture` they drop as
        // soon as the window is out - while the dispatch is submitted and not yet complete.
        recording.holding(out.buffer());
        recording.holding(self.codes.buffer());
        recording.holding(&self.table);
        recording.holding(&self.gain);
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("linearise params"),
            contents: &self.block(stored, step, (frame_w, frame_h), (out_w, out_h)),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("linearise"),
            layout: &kernels.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.codes.buffer().as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.table.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: self.gain.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: out.buffer().as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels.pipeline);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(out.words());
            pass.dispatch_workgroups(x, y, 1);
        }
        recording.submit();
        Some(out)
    }

    /// Which reconstruction the kernel's gain arm runs, as `linearise.slang`'s `GAIN_*` numbers.
    fn gain_mode(&self) -> u32 {
        match self.terms.as_ref().map(|it| &it.terms) {
            Some(Reconstruction::Apple { .. }) => 1,
            _ => 0,
        }
    }

    /// Apple's headroom, and one where the map is ISO's or absent - which leaves that arm the
    /// identity rather than something the kernel has to test for.
    fn apple_headroom(&self) -> f32 {
        match self.terms.as_ref().map(|it| &it.terms) {
            Some(Reconstruction::Apple { headroom }) => headroom.max(1.0),
            _ => 1.0,
        }
    }

    /// The uniform block, written by hand: see `crate::wgsl_layout` for why the two sides are
    /// held together by a test rather than by care.
    fn block(
        &self,
        stored: crate::Tile,
        step: usize,
        frame: (usize, usize),
        out: (usize, usize),
    ) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(BLOCK_BYTES);
        for word in [
            self.stored.width.raw() as u32,
            self.stored.height.raw() as u32,
            stored.left as u32,
            stored.top as u32,
            step as u32,
            frame.0 as u32,
            frame.1 as u32,
            crate::orientation::code(self.upright),
            out.0 as u32,
            out.1 as u32,
            self.gain_size.0 as u32,
            self.gain_size.1 as u32,
        ] {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        let white = self.white_level().raw() as f32;
        let last = self.terms.as_ref().map_or(1.0, |it| it.last.max(1.0));
        bytes.extend_from_slice(&white.to_le_bytes());
        bytes.extend_from_slice(&last.to_le_bytes());
        // A `uint` in the float run rather than a thirteenth word above, which would leave the
        // `float4`s below starting off a sixteen-byte boundary.
        bytes.extend_from_slice(&self.gain_mode().to_le_bytes());
        bytes.extend_from_slice(&self.apple_headroom().to_le_bytes());
        // The gain map's terms, and a run of neutral ones where there is no map or where Apple's
        // arm reads its headroom above instead: `gain_width` is what turns the branch off, so
        // these only have to be finite.
        let iso = match self.terms.as_ref().map(|it| &it.terms) {
            Some(Reconstruction::Iso { min, max, gamma, offset_base, offset_alternate }) => {
                [*min, *max, *gamma, *offset_base, *offset_alternate]
            }
            _ => [[0.0; 3], [0.0; 3], [1.0; 3], [0.0; 3], [0.0; 3]],
        };
        for triple in iso {
            for value in [triple[0], triple[1], triple[2], 0.0] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        for row in self.coding.matrix {
            for value in [row[0], row[1], row[2], 0.0] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        bytes
    }
}

/// What [`Picture::block`] writes, for `wgsl_layout` to hold against the shader's own struct.
pub(crate) const BLOCK_BYTES: usize = 12 * 4 + 4 * 4 + 8 * 16;

fn float_storage(gpu: &crate::gpu::Gpu, values: &[f32]) -> crate::gpu::Buffer {
    let mut bytes = Vec::with_capacity(values.len().max(1) * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    if bytes.is_empty() {
        bytes.extend_from_slice(&0f32.to_le_bytes());
    }
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("linearise table"),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

fn packed_storage(gpu: &crate::gpu::Gpu, samples: &[u16]) -> crate::gpu::Buffer {
    let mut bytes = Vec::with_capacity(samples.len().div_ceil(2) * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    while bytes.len() % 4 != 0 || bytes.is_empty() {
        bytes.push(0);
    }
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("gain map"),
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::px::At;
    use crate::transfer::{Coding, Curve, Primaries};

    /// A source whose primaries reach outside Rec.2020, which is what an ICC profile or a `cHRM`
    /// chunk can state and what `in_gamut` exists for. ProPhoto's green against Rec.2020's other
    /// two, so a pure green code lands with two negative channels and nothing else moves.
    const WIDE: Primaries = Primaries {
        red: (0.708, 0.292),
        green: (0.159_6, 0.840_4),
        blue: (0.131, 0.046),
        white: (0.3127, 0.3290),
    };

    /// The pass pulls a colour Rec.2020 cannot make towards its own luma rather than clamping the
    /// channels that went negative.
    ///
    /// **The failure is a flat region, not a wrong pixel.** Clipping where a channel happened to
    /// cross leaves the other two where the matrix put them, so every colour past the edge lands on
    /// the same hue and a gradient through it goes flat. `demosaic`'s
    /// `the_colour_pass_pulls_a_colour_inside_the_gamut` is the same claim about the RAWs' pass,
    /// measured on a photograph; this is the rendered family's, which meets it wherever a file
    /// carries wide primaries.
    #[test]
    fn a_colour_outside_rec2020_comes_back_pulled_towards_its_luma() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so the gamut pull was not run.");
            return;
        };
        let coding = Coding::of(WIDE, Curve::Linear, 8);
        let picture =
            Picture::upload(gpu, &[0, 255, 0], 1, 1, coding, rawler::decoders::Orientation::Normal, None)
                .expect("the picture uploads");
        let window = Rect { at: At::ORIGIN, size: picture.upright_size() };
        let frame = picture
            .window(gpu, device(gpu), window, crate::view::Scale::Full)
            .expect("the pass runs");
        let samples = pollster::block_on(frame.into_host()).expect("the frame reads back");

        // What the matrix alone gives, before anything holds it inside the primaries.
        let matrix = WIDE.to_rec2020();
        let raw: Vec<f64> = (0..3).map(|channel| f64::from(matrix[channel][1])).collect();
        let lowest = raw.iter().copied().fold(f64::INFINITY, f64::min);
        assert!(lowest < 0.0, "this green is inside Rec.2020, so the test proves nothing");

        // `prelude::in_gamut`: mixed towards a grey of its own luma, which is the one quantity the
        // pull leaves alone.
        let pulled = crate::hdr_fit::in_gamut([raw[0], raw[1], raw[2]]);
        for channel in 0..3 {
            let want = pulled[channel].clamp(0.0, 1.0) * 65535.0;
            let got = f64::from(samples[channel]);
            assert!((got - want).abs() <= 2.0, "channel {channel}: {got} against {want}");
        }
        // The assertion a per-channel clamp would fail: green is the one that did *not* cross, and
        // clamping the two that did would have left it exactly where the matrix put it.
        let clamped = raw[1] * 65535.0;
        assert!(
            f64::from(samples[1]) < clamped - 100.0,
            "green came back at {} where a clamp leaves {clamped}",
            samples[1],
        );
    }
}

