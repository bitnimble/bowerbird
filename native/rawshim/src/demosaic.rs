//! Ratio Corrected Demosaicing on the GPU.
//!
//! The algorithm is specified in `docs/rcd-algorithm-spec.md`, which is the normative document and
//! was written clean-room: every implementation of RCD in the wild is GPL-3, so one agent read
//! those and wrote the specification in mathematics, a second audited it for copyrightable
//! expression, and this file was written from the result without its author reading any of them.
//!
//! Six stages, each a pure map over its site set, so each is one dispatch and nothing inside a
//! stage depends on anything else the same stage writes.

/// Pixels at the frame edge that RCD does not write, filled by a cheap interpolation instead.
///
/// The specification's reach analysis composes to 10: the low-pass reaches 1, the directional
/// kernel 3, its energy 4, the refinement 5, and the two chroma stages 7 and 10. `assemble`'s
/// colour smoothing reads 2 past that.
pub const MARGIN: u32 = 12;

const STAGES: [&str; 7] = [
    "seed",
    "low_pass",
    "fields",
    "green_at_chroma",
    "chroma_at_chroma",
    "chroma_at_greens",
    "assemble",
];

pub struct Rcd {
    frame: wgpu::BindGroupLayout,
    planes: wgpu::BindGroupLayout,
    pipelines: Vec<wgpu::ComputePipeline>,
    assemble_layout: wgpu::BindGroupLayout,
    /// The pairs `assemble_rec2020` leaves for `assemble_blown`, and the dispatch that walks them.
    blown_layout: wgpu::BindGroupLayout,
    assemble: wgpu::ComputePipeline,
    /// The same entry point compiled for a 6x6 period, which is the one thing the two patterns
    /// share a walk over.
    assemble_xtrans: wgpu::ComputePipeline,
    blown_args: wgpu::ComputePipeline,
    assemble_blown: wgpu::ComputePipeline,
    assemble_blown_xtrans: wgpu::ComputePipeline,
    /// One pipeline per reduction factor: the block's side is a generic in the shader so both walks
    /// unroll, which as a uniform they did not.
    assemble_halved: wgpu::ComputePipeline,
    assemble_thirded: wgpu::ComputePipeline,
}

pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Rcd> {
    static BUILT: std::sync::OnceLock<Option<Rcd>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Rcd::new(gpu)).as_ref()
}

/// What the builder below writes, for `wgsl_layout`, which holds it against the struct the shader
/// declares. RCD's own group 0 is `mosaic.slang`'s `Shape`, pinned by `cfa::shape_block`.
#[cfg(test)]
pub(crate) fn assemble_block() -> usize {
    std::mem::size_of::<Assemble>()
}

impl Rcd {
    fn new(gpu: &crate::gpu::Gpu) -> Option<Rcd> {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rcd"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/rcd.wgsl")).into(),
            ),
        });

        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };

        // Split in two so no single stage declares more than the eight storage buffers a device is
        // required to offer: the mosaic rides with the uniform, the seven working planes are their
        // own group.
        let frame = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("rcd frame"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                storage(1, true),
            ],
        });
        let planes = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("rcd planes"),
            entries: &(0..7).map(|b| storage(b, false)).collect::<Vec<_>>(),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("rcd"),
            bind_group_layouts: &[Some(&frame), Some(&planes)],
            ..Default::default()
        });

        // Every stage here runs on a Bayer pattern and no other - `record` sends the rest to the
        // demultiplexing - so the period `mosaic.slang` compiles against is fixed at 2x2 and its
        // modulo folds to a mask.
        let bayer = crate::cfa::Cfa::bayer([0, 1, 1, 2])?;
        let pipelines = STAGES
            .iter()
            .map(|name| {
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(name),
                    layout: Some(&pipeline_layout),
                    module: &module,
                    entry_point: Some(name),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: crate::wgsl_overrides::for_entry(
                            "rcd.wgsl",
                            name,
                            &bayer.constants(),
                        ),
                        ..Default::default()
                    },
                    cache: None,
                })
            })
            .collect();

        // The colour transform and the crop, in their own module and their own layout: they read
        // the plane RCD wrote and write the frame everything downstream holds, so they share
        // neither group with the stages above.
        let assemble_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("assemble"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/assemble.wgsl")).into(),
            ),
        });
        // Group 0 is `mosaic.slang`'s and has exactly the shape RCD's own does - the frame's
        // description beside the conditioned mosaic - so the layout is reused rather than declared
        // twice. `assemble.slang` says why the photosites have to be read directly rather than
        // inferred from the interpolation.
        let assemble_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("assemble"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                storage(1, true),
                storage(2, false),
                storage(3, true),
            ],
        });
        let blown_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("assemble blown"),
            entries: &[storage(0, false), storage(1, false)],
        });
        let assemble_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("assemble"),
                bind_group_layouts: &[Some(&frame), Some(&assemble_layout)],
                ..Default::default()
            });
        let listing_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("assemble listing"),
                bind_group_layouts: &[Some(&frame), Some(&assemble_layout), Some(&blown_layout)],
                ..Default::default()
            });
        let assembling = |entry: &str, cfa: &crate::cfa::Cfa, layout: &wgpu::PipelineLayout| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(layout),
                module: &assemble_module,
                entry_point: Some(entry),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: crate::wgsl_overrides::for_entry(
                        "assemble.wgsl",
                        entry,
                        &cfa.constants(),
                    ),
                    ..Default::default()
                },
                cache: None,
            })
        };
        // The only entry points either pattern reaches, so the only ones compiled twice. The two
        // reduced walks are each one pattern's by construction: a 2x2 site is Bayer's and the 3x3
        // window is X-Trans's.
        let xtrans = crate::cfa::Cfa::new(6, 6, &[1; 36])?;
        let listing = &listing_pipeline_layout;
        let assemble = assembling("assemble_rec2020", &bayer, listing);
        let assemble_xtrans = assembling("assemble_rec2020", &xtrans, listing);
        let blown_args = assembling("blown_args", &bayer, listing);
        let assemble_blown = assembling("assemble_blown", &bayer, listing);
        let assemble_blown_xtrans = assembling("assemble_blown", &xtrans, listing);
        let assemble_halved = assembling("assemble_halved", &bayer, &assemble_pipeline_layout);
        let assemble_thirded = assembling("assemble_thirded", &xtrans, &assemble_pipeline_layout);

        Some(Rcd {
            frame,
            planes,
            pipelines,
            assemble_layout,
            blown_layout,
            assemble,
            assemble_xtrans,
            blown_args,
            assemble_blown,
            assemble_blown_xtrans,
            assemble_halved,
            assemble_thirded,
        })
    }

    /// `mosaic.slang`'s group 0, for another pass over the same mosaic.
    pub(crate) fn frame_layout(&self) -> &wgpu::BindGroupLayout {
        &self.frame
    }
}

/// Where a tile's own pixels come from and where they go, which is everything `assemble.slang` needs
/// besides the two buffers.
///
/// **Two spaces, and the whole job of this struct is carrying a rectangle between them.** `stride`
/// and `crop` describe the region RCD ran over, which is a piece of the sensor's mosaic; `dest` and
/// `frame` describe the cropped picture the samples land in. They are different pictures at
/// different origins, and were the same four `usize` before.
///
/// What the types do not carry is the *turn*: `frame` is the unoriented picture and [`out`] is the
/// same picture after it, which is an axis swap within one space rather than a space of its own.
#[derive(Clone, Copy)]
pub struct Placement {
    /// Row stride of the source plane, in pixels: the region RCD ran over, halo included.
    pub stride: crate::px::Span<crate::px::Sensor>,
    /// This tile's rectangle inside that region.
    pub crop: crate::px::Rect<crate::px::Sensor>,
    /// Where it lands in the unoriented cropped frame.
    pub dest: crate::px::At<crate::px::Photograph>,
    /// The whole unoriented cropped frame.
    pub frame: crate::px::Size<crate::px::Photograph>,
    /// `rawler`'s orientation, as `Orientation::to_u32` numbers it.
    pub orientation: u32,
    /// Photosites a side in the block one output pixel is read from, on the route that skips the
    /// demosaic. 1 everywhere else, which that route is not taken for.
    pub reduce: u32,
}

/// The side of the square of destination words one workgroup owns, which `assemble.slang`'s `PATCH`
/// has to agree with: the shader folds its 64 lanes into that square and this decides how many
/// squares there are.
const PATCH: u32 = 8;

/// A tile's destination words as rows of a rectangle rather than one span.
#[derive(Clone, Copy)]
struct Grid {
    /// The first destination row this tile owns.
    row: usize,
    /// Where the tile starts inside a row, in words.
    word: usize,
    /// How many words of each row are the tile's, and how many rows there are.
    across: usize,
    rows: usize,
}

impl Placement {
    /// The oriented frame's size, which is the destination's own.
    pub fn out(&self) -> (usize, usize) {
        let (width, height) = self.frame.raw();
        match transposes(self.orientation) {
            true => (height, width),
            false => (width, height),
        }
    }

    /// Where this tile's pixels land in the oriented frame.
    fn oriented_rect(&self) -> (usize, usize, usize, usize) {
        let (frame_w, frame_h) = self.frame.raw();
        let (dest_x, dest_y) = self.dest.raw();
        let (_, _, crop_w, crop_h) = self.crop.raw();
        let (last_x, last_y) = (frame_w - 1, frame_h - 1);
        let corner = |x: usize, y: usize| -> (usize, usize) {
            match self.orientation {
                1 => (last_x - x, y),
                2 => (last_x - x, last_y - y),
                3 => (x, last_y - y),
                4 => (y, x),
                5 => (last_y - y, x),
                6 => (last_y - y, last_x - x),
                7 => (y, last_x - x),
                _ => (x, y),
            }
        };
        // Both corners, because every case above either flips an axis or swaps the two, so which of
        // them is the minimum is not fixed.
        let a = corner(dest_x, dest_y);
        let b = corner(dest_x + crop_w - 1, dest_y + crop_h - 1);
        (a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1))
    }

    /// The destination words this tile can reach, as a half-open range.
    fn words(&self) -> std::ops::Range<usize> {
        let (out_width, _) = self.out();
        let (x0, y0, x1, y1) = self.oriented_rect();
        let first = (y0 * out_width + x0) * 3;
        let last = (y1 * out_width + x1) * 3 + 2;
        first / 2..last / 2 + 1
    }

    /// This tile's own words as a grid of (words across a destination row, rows), or None where the
    /// destination does not divide into whole words that way.
    ///
    /// **What this is worth is that the tile stops dispatching over its bounding span.** A quarter
    /// turn sends a destination row to a source column, so a tile's first and last words are
    /// hundreds of rows apart and the span between them covers the frame's whole width - three
    /// quarters of which belongs to other tiles and returns immediately. Walking the rows instead
    /// dispatches the tile and nothing else, and puts a wave's reads on adjacent source columns
    /// rather than one column of scattered rows.
    ///
    /// None unless every row of the destination is a whole number of words and this tile starts on
    /// one of them: otherwise a row's last word is shared with the next row's first, and two
    /// invocations of one dispatch would read-modify-write it against each other.
    fn word_grid(&self) -> Option<Grid> {
        let (out_width, _) = self.out();
        let (x0, y0, x1, y1) = self.oriented_rect();
        if (out_width * 3) % 2 != 0 || (x0 * 3) % 2 != 0 || ((x1 + 1) * 3) % 2 != 0 {
            return None;
        }
        let first = x0 * 3 / 2;
        Some(Grid {
            row: y0,
            word: first,
            across: (x1 + 1) * 3 / 2 - first,
            rows: y1 + 1 - y0,
        })
    }

    /// The workgroups this tile wants, in the shape [`Grid`] chose for it.
    ///
    /// A row per `y` where the grid holds, so `id.y` is the destination row and `id.x` the word
    /// across it; the folded span otherwise, which is what `lanes::linear` unfolds.
    fn dispatch(&self) -> (u32, u32) {
        match self.word_grid() {
            Some(grid) => (
                (grid.across as u32).div_ceil(PATCH).max(1),
                (grid.rows as u32).div_ceil(PATCH).max(1),
            ),
            None => crate::base::groups(self.words().len()),
        }
    }

    /// The same for `assemble.slang`'s pair-owned walk: a pair of pixels is three words, and the
    /// span's pairs run from the one holding its first word to the one holding its last.
    fn pair_dispatch(&self) -> (u32, u32) {
        match self.word_grid() {
            Some(grid) => (
                ((grid.across / 3) as u32).div_ceil(PATCH).max(1),
                (grid.rows as u32).div_ceil(PATCH).max(1),
            ),
            None => {
                let words = self.words();
                crate::base::groups((words.end - 1) / 3 - words.start / 3 + 1)
            }
        }
    }

    /// Where this tile's binding starts, in words.
    ///
    /// A storage binding's offset must be a multiple of `minStorageBufferOffsetAlignment`, 256
    /// bytes and so 64 words on every adapter this runs on. Aligned down, which only ever widens
    /// the window the tile can see and never narrows it.
    fn base_word(&self) -> usize {
        self.words().start / OFFSET_WORDS * OFFSET_WORDS
    }

    /// The binding: this tile's span rather than the whole frame.
    ///
    /// Binding the frame entire is 144MB at 24MP against a default `maxStorageBufferBindingSize`
    /// of 128MiB. It happens to work where the device asked for the adapter's maximum and got it,
    /// which is not a thing to rest on: the failure is a validation error, and a dropped dispatch
    /// reads as a very fast tick rather than as something wrong.
    fn binding<'a>(&self, buffer: &'a wgpu::Buffer) -> wgpu::BufferBinding<'a> {
        let base = self.base_word();
        let end = self.words().end.max(base + 1);
        wgpu::BufferBinding {
            buffer,
            offset: (base * 4) as u64,
            size: std::num::NonZeroU64::new(((end - base) * 4) as u64),
        }
    }
}

/// `minStorageBufferOffsetAlignment` is 256 bytes, which is 64 of these words.
const OFFSET_WORDS: usize = 64;

/// The four orientations that swap the frame's axes.
fn transposes(orientation: u32) -> bool {
    matches!(orientation, 4 | 5 | 6 | 7)
}

/// What `assemble.slang` needs to turn a demosaiced pixel into Rec.2020, which [`Placement`] is the
/// other half of.
///
/// The two travel together from the file that read them to the dispatch that uses them, and neither
/// means anything without the other: the ceilings are in the mosaic's units, which is the domain the
/// matrix's input is in.
#[derive(Clone, Copy)]
pub struct Colour {
    /// The sensor's own camera-to-Rec.2020 3x3 (`decode_rawler::camera_to_rec2020`), which is not
    /// the fitted camera match - that one is the grade's.
    pub matrix: [[f32; 3]; 3],
    /// Where each channel's photosites saturated (`decode_rawler::channel_ceilings`), which is what
    /// tells a blown pixel from a channel that merely clipped.
    pub ceiling: [f32; 3],
}

/// `Params` in `assemble.slang`: the named words, the padding that rounds them to a 16-byte
/// boundary, and three rows, each carrying a channel's ceiling in its fourth lane.
///
/// The one place the two spaces meet a shader, which reads them as undifferentiated words.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Assemble {
    stride: u32,
    crop_left: u32,
    crop_top: u32,
    crop_width: u32,
    crop_height: u32,
    dest_x: u32,
    dest_y: u32,
    frame_width: u32,
    frame_height: u32,
    orientation: u32,
    out_width: u32,
    out_height: u32,
    first_word: u32,
    base_word: u32,
    tile_row: u32,
    tile_word: u32,
    /// Zero where the destination's rows are not whole words, which is what tells the shader to
    /// walk the tile's whole span instead.
    tile_across: u32,
    tile_rows: u32,
    /// Photosites a side in the block one output pixel is read from, which only `assemble_reduced`
    /// reads: 2 for a Bayer site, 3 for the smallest X-Trans window holding every colour.
    reduce: u32,
    /// Where the mosaic this dispatch reads starts in the one its highlight field was measured
    /// over, and that field's cells.
    field_left: u32,
    field_top: u32,
    field_width: u32,
    field_height: u32,
    field_cell: u32,
    colour_reading: f32,
    colour_blown: f32,
    pad: [u32; 2],
    rows: [[f32; 4]; 3],
}

fn assemble_params(at: &Placement, colour: Colour, seen: crate::highlight::Seen<'_>) -> Assemble {
    let (out_width, out_height) = at.out();
    let (crop_left, crop_top, crop_w, crop_h) = at.crop.raw();
    let (dest_x, dest_y) = at.dest.raw();
    let (frame_w, frame_h) = at.frame.raw();
    let grid = at.word_grid();
    let mut rows = [[0.0f32; 4]; 3];
    for (row, (from, ceiling)) in rows
        .iter_mut()
        .zip(colour.matrix.iter().zip(colour.ceiling))
    {
        *row = [from[0], from[1], from[2], ceiling];
    }
    Assemble {
        stride: at.stride.raw() as u32,
        crop_left: crop_left as u32,
        crop_top: crop_top as u32,
        crop_width: crop_w as u32,
        crop_height: crop_h as u32,
        dest_x: dest_x as u32,
        dest_y: dest_y as u32,
        frame_width: frame_w as u32,
        frame_height: frame_h as u32,
        orientation: at.orientation,
        out_width: out_width as u32,
        out_height: out_height as u32,
        first_word: at.words().start as u32,
        base_word: at.base_word() as u32,
        tile_row: grid.map_or(0, |g| g.row) as u32,
        tile_word: grid.map_or(0, |g| g.word) as u32,
        tile_across: grid.map_or(0, |g| g.across) as u32,
        tile_rows: grid.map_or(0, |g| g.rows) as u32,
        reduce: at.reduce,
        field_left: seen.origin.x.raw() as u32,
        field_top: seen.origin.y.raw() as u32,
        field_width: seen.field.width as u32,
        field_height: seen.field.height as u32,
        field_cell: seen.field.cell.raw() as u32,
        colour_reading: seen.colouring.reading,
        colour_blown: seen.colouring.blown,
        pad: [0; 2],
        rows,
    }
}

/// Demosaics a Bayer mosaic and hands back `crop` of it in Rec.2020, as the interleaved `u16` every
/// stage after the decode reads.
///
/// **The colour and the crop are part of the dispatch rather than of the readback**, so what comes
/// back is the cropped frame rather than the raw plane and its halo; `assemble.slang` says what
/// matrixing and quantising on the host costs. The `crop` is in the mosaic's own coordinates, which
/// for a tile is where its halo ends.
///
/// `mosaic` is expected already conditioned: black subtracted and divided by the white level,
/// so it sits in roughly the unit interval. That is
/// not cosmetic - both numerical guards in the algorithm are chosen for that scale, and feeding raw
/// sensor counts makes them irrelevant while feeding very small values makes them dominate.
///
/// `cfa` is the sensor's 2x2 pattern read row-major from the top-left of the frame, with 0 red,
/// 1 green and 2 blue. Bayer only: a pattern that is not two greens on a diagonal is refused,
/// because every stage here pairs rows and columns into 2x2 sites.
/// `into` is the whole oriented frame, two half-float samples to a word, and this tile writes its
/// own rectangle of it. The caller allocates it once for every tile and reads it back once at the
/// end.
///
/// A pixel on all three of `colour`'s ceilings takes the colour of the light around it, as much of
/// it as `seen`'s `Colouring` keeps.
#[allow(clippy::too_many_arguments)]
pub async fn demosaic_into(
    gpu: &'static crate::gpu::Gpu,
    rcd: &Rcd,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    at: &Placement,
    colour: Colour,
    seen: crate::highlight::Seen<'_>,
    into: &crate::gpu::Buffer,
    shape_group: &wgpu::BindGroup,
) -> Option<()> {
    demosaic_settled_into(
        gpu,
        rcd,
        mosaic,
        cfa,
        at,
        colour,
        seen,
        into,
        shape_group,
        |_, _| (),
    )
    .await
}

/// [`demosaic_into`], with `settle` recorded between the demosaic and the colour pass: it is handed
/// the plane RCD wrote - three `f32` a site of `mosaic` - to rewrite in place.
#[allow(clippy::too_many_arguments)]
pub async fn demosaic_settled_into(
    gpu: &'static crate::gpu::Gpu,
    rcd: &Rcd,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    at: &Placement,
    colour: Colour,
    seen: crate::highlight::Seen<'_>,
    into: &crate::gpu::Buffer,
    shape_group: &wgpu::BindGroup,
    settle: impl FnOnce(&mut crate::gpu::Recording<'static>, &crate::gpu::Buffer),
) -> Option<()> {
    let Recorded {
        mut recording, rgb, ..
    } = record(gpu, rcd, mosaic, cfa, shape_group)?;
    settle(&mut recording, &rgb);
    recording.holding(into);

    let assemble_params = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("assemble params"),
        contents: bytemuck::bytes_of(&assemble_params(at, colour, seen)),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let assemble_group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("assemble"),
        layout: &rcd.assemble_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: assemble_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: rgb.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Buffer(at.binding(into)),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: seen.field.buffer.as_entire_binding(),
            },
        ],
    });
    let (x, y) = at.pair_dispatch();
    let blown = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("assemble blown"),
        size: 16,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    // Its own buffer: the blown pass binds `blown` read-write, which no dispatch may also read its
    // arguments from.
    let blown_dispatch = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("assemble blown dispatch"),
        size: 12,
        usage: wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let blown_pairs = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("assemble blown pairs"),
        size: (u64::from(x) * u64::from(y) * 64 * 4).max(4),
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    recording.encoder().clear_buffer(&blown, 0, None);
    let blown_group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("assemble blown"),
        layout: &rcd.blown_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: blown.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: blown_pairs.as_entire_binding(),
            },
        ],
    });
    let bayer = cfa.is_bayer();
    for (pipeline, dispatch) in [
        (
            if bayer {
                &rcd.assemble
            } else {
                &rcd.assemble_xtrans
            },
            Some((x, y)),
        ),
        (&rcd.blown_args, Some((1, 1))),
        (
            if bayer {
                &rcd.assemble_blown
            } else {
                &rcd.assemble_blown_xtrans
            },
            None,
        ),
    ] {
        if dispatch.is_none() {
            recording
                .encoder()
                .copy_buffer_to_buffer(&blown, 0, &blown_dispatch, 0, 12);
        }
        let mut pass = recording
            .encoder()
            .begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("assemble"),
                timestamp_writes: None,
            });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, shape_group, &[]);
        pass.set_bind_group(1, &assemble_group, &[]);
        pass.set_bind_group(2, &blown_group, &[]);
        match dispatch {
            Some((x, y)) => pass.dispatch_workgroups(x, y, 1),
            None => pass.dispatch_workgroups_indirect(&blown_dispatch, 0),
        }
    }

    // **One submit per tile, and that is load-bearing.** A word at the tile's own edge holds one
    // sample of this tile and one of its neighbour, so it is read and put back rather than
    // overwritten - which is only safe if the neighbour's write has already landed.
    recording.submit();
    crate::gpu::finished(gpu).await
}

/// The reduced frame, read straight off the mosaic, with no demosaic between.
///
/// A frame no larger than the sensor over `at.reduce` needs no interpolation: a block that side
/// already carries every colour.
///
/// The factor is the pattern's: 2 for a Bayer site, 3 for the smallest X-Trans window that holds
/// every colour. What the caller chooses is whether to reduce at all.
///
/// It is the same destination write as [`demosaic_into`], down to the orientation and the shared
/// boundary words; only the fetch differs, and `assemble.slang` keeps the two adjacent.
pub async fn reduce_into(
    gpu: &crate::gpu::Gpu,
    rcd: &Rcd,
    mosaic: &crate::condition::Mosaic,
    at: &Placement,
    colour: Colour,
    seen: crate::highlight::Seen<'_>,
    into: &crate::gpu::Buffer,
    shape_group: &wgpu::BindGroup,
) -> Option<()> {
    let mut recording = gpu.record();
    recording.holding(into);
    let params = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("reduce params"),
        contents: bytemuck::bytes_of(&assemble_params(at, colour, seen)),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("reduce"),
        layout: &rcd.assemble_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params.as_entire_binding(),
            },
            // This route reads the mosaic as its plane where the demosaiced one reads RCD's;
            // group 0 carries the same buffer again, as the photosites the fills ask about.
            wgpu::BindGroupEntry {
                binding: 1,
                resource: mosaic.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Buffer(at.binding(into)),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: seen.field.buffer.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording
            .encoder()
            .begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("reduce"),
                timestamp_writes: None,
            });
        pass.set_pipeline(match at.reduce {
            3 => &rcd.assemble_thirded,
            _ => &rcd.assemble_halved,
        });
        pass.set_bind_group(0, shape_group, &[]);
        pass.set_bind_group(1, &group, &[]);
        let (x, y) = at.dispatch();
        pass.dispatch_workgroups(x, y, 1);
    }
    recording.submit();
    crate::gpu::finished(gpu).await
}

/// Room for a whole oriented frame, and the readback that empties it.
pub fn frame_buffer(gpu: &crate::gpu::Gpu, pixels: usize) -> crate::gpu::Buffer {
    gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("rcd rec2020"),
        size: (((pixels * 3).div_ceil(2) * 4).max(4)) as u64,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// The finished frame, on the host.
pub async fn read_frame(
    gpu: &crate::gpu::Gpu,
    frame: &crate::gpu::Buffer,
    pixels: usize,
) -> Option<Vec<u16>> {
    let bytes = ((pixels * 3).div_ceil(2) * 4).max(4) as u64;
    let mut recording = gpu.record();
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("rcd readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    recording
        .encoder()
        .copy_buffer_to_buffer(frame, 0, &readback, 0, bytes);
    recording.submit();

    let mut out = vec![0u16; pixels * 3];
    crate::gpu::read_back(gpu, &readback, |mapped| {
        for (sample, pair) in out.iter_mut().zip(mapped.chunks_exact(2)) {
            *sample = u16::from_le_bytes([pair[0], pair[1]]);
        }
    })
    .await?;
    Some(out)
}

/// The same reconstruction, handed back as the interleaved `f32` plane RCD writes.
///
/// **For the probes rather than for a picture**: `demosaic_psnr` measures against a synthetic field
/// and the unit test against a known one, and both need the values before the camera matrix clamps
/// the negatives a reconstruction is allowed to produce. Nothing that renders takes this route -
/// it is the same dispatch, read one stage earlier.
pub async fn demosaic_plane<T>(
    gpu: &'static crate::gpu::Gpu,
    rcd: &Rcd,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    consume: impl FnOnce(&[u8]) -> T,
) -> Option<T> {
    let margin = match cfa.is_bayer() {
        true => MARGIN,
        false => crate::lslcd::MARGIN,
    };
    let (_shape, shape_group) = shape_group(gpu, rcd, cfa, mosaic, margin);
    let Recorded {
        mut recording,
        rgb,
        width,
        height,
    } = record(gpu, rcd, mosaic, cfa, &shape_group)?;
    let plane_bytes = (width * height * std::mem::size_of::<f32>()) as u64;
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("rcd plane readback"),
        size: plane_bytes * 3,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    recording
        .encoder()
        .copy_buffer_to_buffer(&rgb, 0, &readback, 0, plane_bytes * 3);
    recording.submit();
    crate::gpu::read_back(gpu, &readback, consume).await
}

/// The demosaic this pattern gets, recorded but not submitted, with the plane it writes.
///
/// **The fork is on the pattern and nothing else.** RCD pairs rows and columns into 2x2 sites at
/// every stage, so it answers for the patterns that have such a site and declines the rest; the
/// demultiplexing answers for any period it can decompose, which today is X-Trans. A pattern neither
/// takes is a decode that reads nothing rather than one that renders in the wrong colours.
fn record(
    gpu: &'static crate::gpu::Gpu,
    rcd: &Rcd,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    shape_group: &wgpu::BindGroup,
) -> Option<Recorded> {
    match cfa.is_bayer() {
        true => record_rcd(gpu, rcd, mosaic, shape_group),
        false => crate::lslcd::record(gpu, crate::lslcd::device(gpu)?, mosaic, cfa, shape_group),
    }
}

/// `mosaic.slang`'s group 0: the frame's description beside the photosites it describes.
///
/// The same two bindings whichever demosaic ran and whichever entry point reads them next, which is
/// what lets one pattern layer serve RCD, the demultiplexing and the assembly.
///
/// **Build once per region and hold it across its tiles.** On the reduced read a grid tile takes,
/// each tile is one cheap dispatch, so a per-tile buffer and descriptor set is CPU work nothing
/// hides: on the integrated adapter that costs a 61MP render 198ms against a 105.7ms budget.
///
/// The buffer comes back with the group because it has to outlive it, and a recording's would not:
/// each tile submits its own.
pub fn shape_group(
    gpu: &crate::gpu::Gpu,
    rcd: &Rcd,
    cfa: &crate::cfa::Cfa,
    mosaic: &crate::condition::Mosaic,
    margin: u32,
) -> (crate::gpu::Buffer, wgpu::BindGroup) {
    let shape = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("mosaic shape"),
        contents: bytemuck::bytes_of(&cfa.shape(mosaic.width, mosaic.height, margin)),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("mosaic shape"),
        layout: &rcd.frame,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: shape.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: mosaic.buffer.as_entire_binding(),
            },
        ],
    });
    (shape, group)
}

/// A demosaic recorded and not yet submitted: the pass, the plane it writes, and the description of
/// the frame that `assemble.slang` reads next out of the same group 0.
pub struct Recorded {
    pub recording: crate::gpu::Recording<'static>,
    pub rgb: crate::gpu::Buffer,
    pub width: usize,
    pub height: usize,
}

/// RCD's own dispatches, recorded but not submitted, with the plane they write.
fn record_rcd(
    gpu: &'static crate::gpu::Gpu,
    rcd: &Rcd,
    mosaic: &crate::condition::Mosaic,
    shape_group: &wgpu::BindGroup,
) -> Option<Recorded> {
    let (width, height) = (mosaic.width, mosaic.height);
    if width < (2 * MARGIN as usize) + 4 || height < (2 * MARGIN as usize) + 4 {
        return None;
    }

    let mut lap = crate::clock::laps("    rcd ");

    let pixels = width * height;
    let plane_bytes = (pixels * std::mem::size_of::<f32>()) as u64;

    let mut recording = gpu.record();
    recording.holding(&mosaic.buffer);

    macro_rules! plane {
        ($label:expr, $bytes:expr) => {
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some($label),
                size: $bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
    }
    let lowpass = plane!("rcd lowpass", plane_bytes);
    let field_axis = plane!("rcd axis field", plane_bytes);
    let field_diag = plane!("rcd diagonal field", plane_bytes);
    let green = plane!("rcd green", plane_bytes);
    let red = plane!("rcd red", plane_bytes);
    let blue = plane!("rcd blue", plane_bytes);
    let rgb = plane!("rcd rgb", plane_bytes * 3);
    lap("allocate");

    let plane_group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("rcd planes"),
        layout: &rcd.planes,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: lowpass.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: field_axis.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: field_diag.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: green.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: red.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: blue.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: rgb.as_entire_binding(),
            },
        ],
    });

    {
        let mut pass = recording
            .encoder()
            .begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("rcd"),
                timestamp_writes: None,
            });
        pass.set_bind_group(0, shape_group, &[]);
        pass.set_bind_group(1, &plane_group, &[]);
        let groups_x = width.div_ceil(8) as u32;
        let groups_y = height.div_ceil(8) as u32;
        // In order: the stages have real dependencies on each other (the specification's §12), and
        // a compute pass gives each dispatch a barrier against the last.
        for pipeline in &rcd.pipelines {
            pass.set_pipeline(pipeline);
            pass.dispatch_workgroups(groups_x, groups_y, 1);
        }
    }

    lap("record");
    Some(Recorded {
        recording,
        rgb,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use crate::highlight::Colouring;

    /// The patch the host counts workgroups in, against the one the shader folds its lanes into.
    ///
    /// **Disagreeing here is a torn frame rather than a failure.** The host decides how many
    /// workgroups a tile gets from this number and the shader decides which word each lane owns
    /// from its own copy: a shader patch larger than the host's leaves the tail of every tile
    /// unwritten, and a smaller one writes the same words twice while never reaching the rest.
    /// Declared twice because a `static const` is folded into its use sites and never reaches the
    /// WGSL, so the `.slang` is what this reads.
    #[test]
    fn the_patch_is_the_one_the_shader_folds_into() {
        const SLANG: &str = include_str!("../../../slang/assemble.slang");
        let opener = "static const uint PATCH = ";
        let start = SLANG.find(opener).expect("assemble declares PATCH");
        let rest = &SLANG[start + opener.len()..];
        let literal = &rest[..rest.find(';').expect("the declaration ends")];
        let declared: u32 = literal.trim().parse().expect("PATCH is a number");
        assert_eq!(
            declared,
            super::PATCH,
            "the shader and this host patch the dispatch differently"
        );
    }

    /// The seam between what RCD writes and what the border fill writes.
    ///
    /// **A stage may only read a site an earlier stage actually wrote.** §10's reaches are
    /// cumulative from the mosaic, so each stage can compute nearer the edge than the final margin
    /// of 10 - and it has to, because the stage after it reads past its own output. Gating them all
    /// at 10 left stage E reading green at `r - 2` on the first interior row, where stage C had
    /// declined to write and the seed's zero was still sitting: a ring of wrong colour a few pixels
    /// wide, around every frame, on every photograph.
    ///
    /// Measured on a field smooth enough that the interior is nearly exact, so anything the seam
    /// does stands out against it. `demosaic_psnr` cannot see this - it crops 16 pixels off each
    /// side, "comfortably more than the algorithm's own margin", which is exactly the band at issue.
    #[test]
    fn the_seam_reconstructs_as_well_as_the_interior() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };

        let (w, h) = (96usize, 96usize);
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        // One smooth ramp with a constant offset per channel, so every colour difference is
        // constant over the frame - which is the assumption RCD interpolates under, and the only
        // kind of field it reconstructs to within rounding. A field whose channels vary
        // *differently* measures the algorithm's modelling error instead, which at 0.13 here
        // swamps what this test is looking for.
        let truth = |r: usize, c: usize, channel: usize| -> f32 {
            let (x, y) = (c as f32 / w as f32, r as f32 / h as f32);
            let base = 0.3 + 0.3 * x + 0.2 * y;
            base + match channel {
                0 => 0.10,
                1 => 0.0,
                _ => -0.05,
            }
        };
        let mosaic: Vec<f32> = (0..h)
            .flat_map(|r| (0..w).map(move |c| truth(r, c, cfa.colour_at(r, c) as usize)))
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
        let rgb = pollster::block_on(super::demosaic_plane(gpu, rcd, &uploaded, &cfa, |bytes| {
            bytes
                .chunks_exact(4)
                .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
                .collect::<Vec<f32>>()
        }))
        .expect("the demosaic runs");

        let margin = super::MARGIN as usize;
        let worst = |rows: std::ops::Range<usize>, cols: std::ops::Range<usize>| {
            let mut worst = 0f32;
            for r in rows {
                for c in cols.clone() {
                    for channel in 0..3 {
                        let got = rgb[(r * w + c) * 3 + channel];
                        worst = worst.max((got - truth(r, c, channel)).abs());
                    }
                }
            }
            worst
        };

        // The top seam, away from the left and right ones - a band spanning the full width would
        // carry the vertical seams into every row it measured, including the interior's.
        let seam = worst(margin..margin + 4, margin + 8..w - margin - 8);
        let interior = worst(h / 2 - 2..h / 2 + 2, w / 2 - 2..w / 2 + 2);
        // Generous against the interior, because the seam legitimately has less evidence to work
        // from. Measured with the flat margin the seam was off by 0.148 against an interior of
        // 5.2e-6 - a factor of nearly thirty thousand, so the bar has room to spare.
        assert!(
            seam < interior.max(1e-5) * 100.0,
            "the seam is off by {seam} where the interior is off by {interior}",
        );
    }

    /// Read noise about black reconstructs about black, in every channel, and nothing runs away
    /// through the ratio where a low-pass sits at or below it.
    #[test]
    fn noise_about_black_demosaics_to_black() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };

        let (w, h) = (256usize, 256usize);
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mosaic: Vec<f32> = (0..w * h)
            .map(|_| {
                let mut sum = 0.0;
                for _ in 0..3 {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    sum += (seed >> 40) as f32 / 16777216.0 - 0.5;
                }
                sum * 0.01
            })
            .collect();

        let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
        let rgb = pollster::block_on(super::demosaic_plane(gpu, rcd, &uploaded, &cfa, |bytes| {
            bytes
                .chunks_exact(4)
                .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
                .collect::<Vec<f32>>()
        }))
        .expect("the demosaic runs");

        let margin = super::MARGIN as usize;
        for channel in 0..3 {
            let values: Vec<f64> = (margin..h - margin)
                .flat_map(|r| (margin..w - margin).map(move |c| (r * w + c) * 3 + channel))
                .map(|at| f64::from(rgb[at]))
                .collect();
            let worst = values.iter().fold(0f64, |worst, v| worst.max(v.abs()));
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            // The noise's own reach is 0.015; a ratio taken through zero lands anywhere at all.
            assert!(worst < 0.05, "channel {channel} reached {worst}");
            // A floor at zero lifts this noise's mean by 0.002.
            assert!(mean.abs() < 0.0003, "channel {channel} averaged {mean:.5}");
        }
    }

    /// The colour transform and the crop, over the entry point that renders.
    ///
    /// **Nothing in the fast suite reached `demosaic_into` before this.** The test above takes
    /// `demosaic_plane`, and the GPU fixtures start from frames that are already decoded - so a
    /// `vec3u` in `assemble.slang`'s params, which WGSL aligns to sixteen and the host wrote at
    /// four, put the matrix rows sixteen bytes from where they were read and coloured every frame
    /// out of the padding. `test:native` was green; it took decoding a real RAW to see it.
    ///
    /// So this asks the three things that layout can break, on a frame small enough to run in
    /// milliseconds: a matrix whose rows differ (a row read from the wrong offset lands on the
    /// wrong channel), a crop whose origin is neither zero nor square (a stride or an origin read
    /// out of the padding reads zero and the crop lands at the frame's corner), and an odd pixel
    /// count (the tail word a pair-per-invocation kernel leaves half-written).
    #[test]
    fn the_assemble_pass_colours_and_crops_where_it_is_told() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };

        let (w, h) = (64usize, 48usize);
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        // Flat per channel, so RCD reconstructs it exactly and what is left to measure is the
        // matrix and the crop rather than the reconstruction.
        let level = |channel: usize| -> f32 { [0.5, 0.25, 0.125][channel] };
        let mosaic: Vec<f32> = (0..h)
            .flat_map(|r| (0..w).map(move |c| level(cfa.colour_at(r, c) as usize)))
            .collect();
        let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);

        // Rows that differ from each other and from the identity, so a row read at the wrong
        // offset cannot agree by coincidence.
        let matrix = [[0.8, 0.1, 0.05], [0.02, 0.9, 0.03], [0.01, 0.06, 0.7]];
        // Odd width, odd origin, odd sample count: 21 * 13 * 3 is 819, which is not a whole
        // number of words.
        let crop = (7usize, 5usize, 21usize, 13usize);
        let at = super::Placement {
            stride: crate::px::Span::exact(w),
            crop: crate::px::Rect::exact(crop.0, crop.1, crop.2, crop.3),
            dest: crate::px::At::ORIGIN,
            frame: crate::px::Size::exact(crop.2, crop.3),
            orientation: 0,
            reduce: 1,
        };
        let (out_w, out_h) = at.out();
        let frame = super::frame_buffer(gpu, out_w * out_h);
        // Ceilings nothing in the fixture reaches, so what is measured is the matrix and the crop
        // rather than the highlight reconstruction beside them.
        let colour = super::Colour {
            matrix,
            ceiling: [1.0; 3],
        };
        let (_shape, group) = super::shape_group(gpu, rcd, &cfa, &uploaded, super::MARGIN);
        let field = crate::highlight::measure(gpu, &uploaded, &cfa, colour.ceiling)
            .expect("the highlight field");
        pollster::block_on(super::demosaic_into(
            gpu,
            rcd,
            &uploaded,
            &cfa,
            &at,
            colour,
            field.seen(),
            &frame,
            &group,
        ))
        .expect("the demosaic runs");
        let out = crate::resident::levels_of(
            &pollster::block_on(super::read_frame(gpu, &frame, out_w * out_h))
                .expect("the frame reads back"),
        );

        assert_eq!(
            out.len(),
            crop.2 * crop.3 * 3,
            "the crop's own size comes back"
        );
        let want: Vec<f32> = (0..3)
            .map(|channel| {
                let value: f32 = (0..3).map(|c| matrix[channel][c] * level(c)).sum();
                value * 65535.0
            })
            .collect();
        // Away from the frame's edge, where RCD's own margin is border-filled rather than
        // reconstructed - the crop above sits inside it, but the assertion says so rather than
        // trusting the arithmetic that put it there.
        for pixel in 0..crop.2 * crop.3 {
            let got = [out[pixel * 3], out[pixel * 3 + 1], out[pixel * 3 + 2]];
            for channel in 0..3 {
                let off = f64::from(got[channel] - want[channel]);
                assert!(
                    off.abs() <= 2.0 + stored_within(f64::from(want[channel])),
                    "pixel {pixel} channel {channel} is {} against {}, over a flat field",
                    got[channel],
                    want[channel],
                );
            }
        }
        // And the channels are not one value three times, which every assertion above would pass
        // if the matrix had been read as zeroes and the frame come back black.
        assert!(
            want[0] > want[1] && want[1] > want[2],
            "the fixture's channels are distinct"
        );
        assert!(want[2] > 0.0, "the fixture is not black");
    }

    /// A pixel blown in all three channels comes back neutral; one with a channel still reading
    /// keeps its colour.
    ///
    /// **The two halves of the same rule, and the pair is the point.** The conditioning clips each
    /// photosite at its own saturation, so the ceilings are the white balance gains - and a pixel
    /// left sitting on all three leaves for the colour matrix in the *illuminant's* ratios, which on
    /// this body is 1 : 0.49 : 0.72 and renders a sun pink. Raising them to the pixel's own maximum
    /// is what puts it back on the grey axis.
    ///
    /// Asserting only that would be satisfied by clipping every channel at the smallest gain, which
    /// is the same neutral bought by discarding a stop of unsaturated red and blue - a magenta light
    /// rendered white. So the second field is blown in red and blue with green still well under its
    /// ceiling, and it has to come back magenta.
    ///
    /// Flat fields, so RCD reconstructs each exactly and what is measured is the reconstruction
    /// rather than the interpolation under it. The matrix is the identity for the same reason: a
    /// camera 3x3 mixes the channels and a neutral would no longer be three equal numbers.
    #[test]
    fn a_pixel_blown_in_every_channel_comes_back_neutral() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };

        // An R8's gains, scaled as `white_balance_gains` scales them. The identity matrix for the
        // reason above.
        let ceiling = [1.0f32, 0.48831692, 0.71626157];
        let colour = super::Colour {
            matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            ceiling,
        };

        let at = flat_field(gpu, rcd, colour, ceiling);
        let spread = at.iter().copied().fold(f32::MIN, f32::max)
            - at.iter().copied().fold(f32::MAX, f32::min);
        assert!(
            spread <= 2.0,
            "a pixel on all three ceilings came back {at:?}, which is the illuminant's own ratios"
        );
        assert!(
            at[0] > 60000.0,
            "the blown pixel is not neutral by being dark: {at:?}"
        );

        // Red and blue on their ceilings, green at a third of its own: a magenta light whose green
        // photosite never came close, which the clip must not walk to white.
        let at = flat_field(gpu, rcd, colour, [ceiling[0], ceiling[1] / 3.0, ceiling[2]]);
        assert!(
            at[1] * 2.0 < at[0] && at[1] * 2.0 < at[2],
            "a magenta light with green to spare came back {at:?}"
        );
    }

    /// A light that clips two channels with the third far under keeps the ratios its ceilings
    /// state: the broadband estimate for the clipped red, `g²/b`, is many times red's ceiling
    /// here, and a channel is never raised past what its own silicon could have read.
    ///
    /// DSC00982's torch, in miniature - red and green on their ceilings, blue at a thirtieth of
    /// its own - which the uncapped estimate rendered deep red where the camera renders orange.
    #[test]
    fn a_deep_orange_light_is_not_raised_past_its_ceilings() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };
        let ceiling = [1.0f32, 0.3042, 0.4513];
        let colour = super::Colour {
            matrix: IDENTITY_F32,
            ceiling,
        };
        let level = [ceiling[0], ceiling[1], ceiling[2] * 0.035];

        let at = flat_field(gpu, rcd, colour, level);
        // The ratios of the ceilings themselves, through the identity: red at full scale, green at
        // its ceiling's fraction of red, blue where the photosite put it. Within a few percent,
        // which is the interpolation's own margin; the uncapped estimate put green at a sixth of
        // this.
        let want = level.map(|v| f64::from(v) * 65535.0);
        for c in 0..3 {
            assert!(
                (f64::from(at[c]) - want[c]).abs() <= 0.03 * want[c],
                "channel {c} came back {} against {} - {at:?}",
                at[c],
                want[c]
            );
        }
    }

    /// A broadband highlight bright enough to run two channels out keeps the third's account of
    /// how bright it was, rather than the two ceilings' ratio.
    ///
    /// **Green's ceiling is the lowest on every body here, so every blown highlight needs green
    /// raised past it.** The A7CR's gains put green at 0.358 where blue reaches 1.0: a neutral
    /// bright enough to clip red as well leaves green a third under both its neighbours, which is
    /// DSC04519's daylit rock rendering as a magenta band a stop and a half wide. Red is raised
    /// too: left on its own ceiling under the blue still reading, the same highlight comes back
    /// blue, which is a tungsten lamp's rim on a wall.
    #[test]
    fn a_blown_neutral_is_not_left_at_greens_ceiling() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };
        // The A7CR's gains, as `white_balance_gains` scales them.
        let ceiling = [0.6052f32, 0.358, 1.0];
        let colour = super::Colour {
            matrix: IDENTITY_F32,
            ceiling,
        };
        // A neutral at 0.68, which red and green have both run out under.
        let level = [ceiling[0], ceiling[1], 0.68];

        let at = flat_field(gpu, rcd, colour, level);
        let want = f64::from(level[2]) * 65535.0;
        for c in 0..3 {
            assert!(
                (f64::from(at[c]) - want).abs() <= 0.03 * want,
                "channel {c} came back {} against the neutral {want:.0} blue states - {at:?}",
                at[c],
            );
        }
    }

    const IDENTITY_F32: [[f32; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

    /// A sensor colour the matrix takes outside Rec.2020 comes back at the gamut's floor with its
    /// luma and its hue, not with one channel zeroed and the other two left where they were.
    ///
    /// The A7CR's matrix on a saturated red: the blue row lands below zero. Zeroing blue alone
    /// keeps red and green at the matrix's answer, which is a brighter and differently coloured
    /// pixel than the one that scales its chroma toward its own luma until blue reaches the floor.
    #[test]
    fn a_colour_outside_rec2020_is_brought_in_without_turning() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };

        let matrix = [
            [0.899, 0.306, -0.205],
            [-0.05, 1.473, -0.423],
            [-0.001, -0.236, 1.237],
        ];
        let colour = super::Colour {
            matrix,
            ceiling: [1.0; 3],
        };
        let level = [0.6f32, 0.15, 0.01];

        let m: [f64; 3] = std::array::from_fn(|r| {
            (0..3)
                .map(|c| f64::from(matrix[r][c]) * f64::from(level[c]))
                .sum()
        });
        assert!(
            m[2] < 0.0,
            "the case needs a matrix output below zero, got {m:?}"
        );
        // The positive part's, as `in_gamut` takes it: the negative channel is what the rule is for
        // and green's weight is the largest of the three, so the triple's own luma subtracts the
        // out-of-gamut channel from the in-gamut ones. `prelude.slang` carries the measurement.
        let luma = |v: [f64; 3]| {
            let weights = crate::hdr_fit::LUMA;
            (0..3).map(|c| weights[c] * v[c].max(0.0)).sum::<f64>()
        };
        let want: [f64; 3] = crate::hdr_fit::in_gamut(m).map(|v| v * 65535.0);

        let got = flat_field(gpu, rcd, colour, level);
        assert!(
            got[2] > 0.0,
            "blue lands on the floor, not on zero: {got:?}"
        );
        for c in 0..3 {
            assert!(
                (f64::from(got[c]) - want[c]).abs() <= 2.0 + stored_within(want[c]),
                "channel {c} came back {} against {:.1} - {got:?} for {want:?}",
                got[c],
                want[c]
            );
        }
        let (got_luma, l) = (luma(got.map(f64::from)), luma(m));
        assert!(
            (got_luma - l * 65535.0).abs() <= 3.0 + stored_within(l * 65535.0),
            "luma moved: {got_luma} against {}",
            l * 65535.0
        );
        // And it is not the per-channel clamp, which would have left red at the matrix's own answer.
        assert!(
            f64::from(got[0]) < m[0] * 65535.0 - 10.0,
            "red was not scaled toward luma: {got:?}"
        );
    }

    /// IMG_0275's sun, where `reconstructed` was tuned. The disc, blown in every channel, comes back
    /// white rather than in the illuminant's pink, and the falloff keeps its warmth without a
    /// magenta ring where the second channel runs out.
    #[test]
    fn the_sun_comes_back_white_at_its_disc() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };
        let window = RealWindow::read(
            gpu,
            rcd,
            "sun-disc",
            (768, 640),
            R8_COLOUR,
            Colouring::DEFAULT,
        );
        window
            .snapshot(gpu)
            .check("highlights/sun-disc", WINDOW_TOLERANCE);
        let census = window.census();
        census.blown_is_neutral("the sun's disc", 100_000);
        census.nothing_near_clipping_is_magenta("the sun");
    }

    /// DSC04519's lamp-lit rock, where red and green run out with blue still reading: left at
    /// green's ceiling, that is a magenta band a stop and a half wide around every blown patch.
    #[test]
    fn a_blown_rock_does_not_turn_magenta() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };
        let read =
            |colouring| RealWindow::read(gpu, rcd, "lit-rock", (1248, 704), A7CR_COLOUR, colouring);
        read(Colouring::DEFAULT)
            .snapshot(gpu)
            .check("highlights/lit-rock", WINDOW_TOLERANCE);
        // The lamp's tint stays faintly on the blown face by default, so neutral is read with none.
        let census = read(Colouring::at(0.5)).census();
        census.blown_is_neutral("the rock's blown patches", 100_000);
        census.nothing_near_clipping_is_magenta("the rock");
    }

    /// DSC05443's painted temple beams: saturated colour a few pixels across, which a demosaic or a
    /// chroma stage that blurs colour past what the sensor resolved washes out.
    #[test]
    fn painted_beams_keep_their_fine_colour() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };
        RealWindow::read(
            gpu,
            rcd,
            "painted-beams",
            (1280, 704),
            BEAMS_COLOUR,
            Colouring::DEFAULT,
        )
        .snapshot(gpu)
        .check("demosaic/painted-beams", WINDOW_TOLERANCE);
    }

    const WINDOW_TOLERANCE: crate::snapshot::Tolerance = crate::snapshot::Tolerance {
        worst: 256,
        mean: 1.5,
    };

    const R8_COLOUR: super::Colour = super::Colour {
        matrix: [
            [0.9192243, 0.16314033, -0.08228286],
            [-0.05530379, 1.5033377, -0.44804686],
            [-0.012427266, -0.30576313, 1.3179761],
        ],
        ceiling: [1.0, 0.48831666, 0.7162613],
    };

    const A7CR_COLOUR: super::Colour = super::Colour {
        matrix: [
            [0.8990233, 0.3062718, -0.20521326],
            [-0.05023299, 1.4729892, -0.42276916],
            [-0.0013742517, -0.23608698, 1.237247],
        ],
        ceiling: [0.60524476, 0.35804197, 1.0],
    };

    const BEAMS_COLOUR: super::Colour = super::Colour {
        ceiling: [1.0, 0.35629785, 0.5588031],
        ..A7CR_COLOUR
    };

    /// A window of a real photograph's conditioned mosaic (`examples/mosaic_crop.rs`), RGGB from its
    /// origin, through the demosaic and the colour pass, inset past RCD's margin.
    struct RealWindow {
        mosaic: Vec<f32>,
        stride: usize,
        ceiling: [f32; 3],
        width: usize,
        height: usize,
        rgb: Vec<u16>,
    }

    impl RealWindow {
        const INSET: usize = 16;

        fn read(
            gpu: &'static crate::gpu::Gpu,
            rcd: &'static super::Rcd,
            name: &str,
            (w, h): (usize, usize),
            colour: super::Colour,
            colouring: crate::highlight::Colouring,
        ) -> RealWindow {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../test/fixtures/mosaics/{name}.f32"));
            let bytes = std::fs::read(path).expect("the window's mosaic");
            assert_eq!(
                bytes.len(),
                w * h * 4,
                "{name}.f32 is the wrong size; an LFS pointer needs `git lfs pull`"
            );
            let mosaic: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
                .collect();
            let (width, height) = (w - 2 * Self::INSET, h - 2 * Self::INSET);
            let rgb = demosaiced(
                gpu,
                rcd,
                &mosaic,
                (w, h),
                (Self::INSET, Self::INSET, width, height),
                colour,
                colouring,
            );
            RealWindow {
                mosaic,
                stride: w,
                ceiling: colour.ceiling,
                width,
                height,
                rgb,
            }
        }

        /// How full each colour's photosites are about an output pixel, as `assemble.slang`'s
        /// `fills_at` measures it.
        fn fill(&self, x: usize, y: usize) -> [f32; 3] {
            let cfa = rggb();
            let (mx, my) = (x + Self::INSET, y + Self::INSET);
            let mut sum = [0.0f32; 3];
            let mut seen = [0.0f32; 3];
            for sy in my - 1..=my + 1 {
                for sx in mx - 1..=mx + 1 {
                    let colour = usize::from(cfa.colour_at(sy, sx)).min(2);
                    sum[colour] += self.mosaic[sy * self.stride + sx];
                    seen[colour] += 1.0;
                }
            }
            std::array::from_fn(|c| sum[c] / seen[c] / self.ceiling[c])
        }

        fn pixel(&self, x: usize, y: usize) -> [f64; 3] {
            let at = (y * self.width + x) * 3;
            [0, 1, 2].map(|c| f64::from(crate::resident::level_of_bits(self.rgb[at + c])))
        }

        fn census(&self) -> Census {
            let mut census = Census::default();
            for y in 0..self.height {
                for x in 0..self.width {
                    let fill = self.fill(x, y);
                    let p = self.pixel(x, y);
                    let hi = p[0].max(p[1]).max(p[2]);
                    if fill.iter().all(|f| *f >= 0.995) {
                        census.blown += 1;
                        let spread = (hi - p[0].min(p[1]).min(p[2])) / hi.max(1.0);
                        census.blown_spread = census.blown_spread.max(spread);
                    }
                    if fill.iter().any(|f| *f >= 0.75) {
                        census.near += 1;
                        if p[1] < 0.95 * p[0].min(p[2]) {
                            census.magenta += 1;
                        }
                    }
                }
            }
            census
        }

        fn snapshot(&self, gpu: &'static crate::gpu::Gpu) -> crate::snapshot::Snapshot {
            let levels = crate::hdr::levels_of(gpu, &self.rgb, self.width, self.height, 0.995)
                .expect("the window has levels");
            let resident =
                crate::resident::Resident::upload(gpu, &self.rgb, self.width, self.height);
            crate::snapshot::Snapshot::crops(
                crate::snapshot::Frame::Scene(
                    &resident,
                    crate::snapshot::Anchoring {
                        levels: levels.anchored(),
                        reference_white_nits: crate::light::Light::exactly(203.0),
                    },
                ),
                &[crate::px::Rect::<crate::px::Pinned>::exact(
                    0,
                    0,
                    self.width,
                    self.height,
                )],
            )
        }
    }

    #[derive(Default)]
    struct Census {
        /// Pixels whose photosites are full in every colour, and the widest any of them strays
        /// from neutral as a share of its brightest channel.
        blown: usize,
        blown_spread: f64,
        /// Pixels with any colour three quarters full, and those whose green sits more than 5%
        /// under both red and blue.
        near: usize,
        magenta: usize,
    }

    impl Census {
        fn blown_is_neutral(&self, what: &str, at_least: usize) {
            assert!(
                self.blown >= at_least,
                "{what} holds {} blown pixels, which no longer covers it",
                self.blown
            );
            assert!(
                self.blown_spread <= 0.005,
                "{what} came back {:.1}% off neutral where every photosite ran out",
                self.blown_spread * 100.0
            );
        }

        fn nothing_near_clipping_is_magenta(&self, what: &str) {
            let share = self.magenta as f64 / self.near.max(1) as f64;
            assert!(
                share <= 0.005,
                "{:.2}% of {what}'s {} pixels near clipping came back magenta",
                share * 100.0,
                self.near
            );
        }
    }

    /// The middle pixel of a flat field at `level`, one value per CFA colour, through the demosaic
    /// and the colour pass with `colour`.
    ///
    /// Flat, so RCD reconstructs it exactly and what is measured is the colour pass rather than
    /// the interpolation under it.
    fn flat_field(
        gpu: &'static crate::gpu::Gpu,
        rcd: &'static super::Rcd,
        colour: super::Colour,
        level: [f32; 3],
    ) -> [f32; 3] {
        let (w, h) = (64usize, 48usize);
        let crop = (8usize, 8usize, 24usize, 16usize);
        let cfa = &rggb();
        let mosaic: Vec<f32> = (0..h)
            .flat_map(|r| (0..w).map(move |c| level[cfa.colour_at(r, c) as usize]))
            .collect();
        let samples = demosaiced(
            gpu,
            rcd,
            &mosaic,
            (w, h),
            crop,
            colour,
            crate::highlight::Colouring::DEFAULT,
        );
        middle_of(&samples, crop.2, crop.3)
    }

    fn rggb() -> crate::cfa::Cfa {
        crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap()
    }

    /// `crop` of an RGGB `mosaic` through the demosaic and the colour pass, unturned, as stored.
    fn demosaiced(
        gpu: &'static crate::gpu::Gpu,
        rcd: &'static super::Rcd,
        mosaic: &[f32],
        (w, h): (usize, usize),
        crop: (usize, usize, usize, usize),
        colour: super::Colour,
        colouring: crate::highlight::Colouring,
    ) -> Vec<u16> {
        let uploaded = crate::condition::Mosaic::upload(gpu, mosaic, w, h);
        let at = super::Placement {
            stride: crate::px::Span::exact(w),
            crop: crate::px::Rect::exact(crop.0, crop.1, crop.2, crop.3),
            dest: crate::px::At::ORIGIN,
            frame: crate::px::Size::exact(crop.2, crop.3),
            orientation: 0,
            reduce: 1,
        };
        let frame = super::frame_buffer(gpu, crop.2 * crop.3);
        let cfa = rggb();
        let (_shape, group) = super::shape_group(gpu, rcd, &cfa, &uploaded, super::MARGIN);
        let field = crate::highlight::measure(gpu, &uploaded, &cfa, colour.ceiling)
            .expect("the highlight field");
        pollster::block_on(super::demosaic_into(
            gpu,
            rcd,
            &uploaded,
            &cfa,
            &at,
            colour,
            field.seen().coloured(colouring),
            &frame,
            &group,
        ))
        .expect("the demosaic runs");
        pollster::block_on(super::read_frame(gpu, &frame, crop.2 * crop.3)).expect("it reads back")
    }

    fn middle_of(samples: &[u16], width: usize, height: usize) -> [f32; 3] {
        let middle = ((height / 2) * width + width / 2) * 3;
        std::array::from_fn(|c| crate::resident::level_of_bits(samples[middle + c]))
    }

    /// A disc blown in every channel borrows a vivid surround's colour and comes back white under a
    /// pale one, at the default Highlight recovery.
    #[test]
    fn a_blown_disc_takes_a_vivid_lights_colour_and_not_a_pale_ones() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };
        let pink = blown_disc(gpu, rcd, [0.9, 0.18, 0.63]);
        assert!(
            pink[1] < 0.5 * pink[0] && pink[1] < 0.5 * pink[2],
            "under a pink light the disc came back {pink:?}"
        );
        let cream = blown_disc(gpu, rcd, [0.9, 0.81, 0.72]);
        let spread = (cream[0].max(cream[1]).max(cream[2]) - cream[0].min(cream[1]).min(cream[2]))
            / cream[0].max(cream[1]).max(cream[2]);
        assert!(
            spread <= 0.02,
            "under a cream light the disc came back {cream:?}"
        );
    }

    /// The middle pixel of a disc on every ceiling, inside a flat `surround`, through the demosaic
    /// and the colour pass at the identity.
    fn blown_disc(
        gpu: &'static crate::gpu::Gpu,
        rcd: &'static super::Rcd,
        surround: [f32; 3],
    ) -> [f32; 3] {
        let side = 256usize;
        let cfa = &rggb();
        let centre = side as f32 / 2.0;
        let mosaic: Vec<f32> = (0..side)
            .flat_map(|r| {
                (0..side).map(move |c| {
                    let (dx, dy) = (c as f32 - centre, r as f32 - centre);
                    match dx * dx + dy * dy < 40.0 * 40.0 {
                        true => 1.0,
                        false => surround[cfa.colour_at(r, c) as usize],
                    }
                })
            })
            .collect();
        let inner = side - 2 * RealWindow::INSET;
        let samples = demosaiced(
            gpu,
            rcd,
            &mosaic,
            (side, side),
            (RealWindow::INSET, RealWindow::INSET, inner, inner),
            super::Colour {
                matrix: IDENTITY_F32,
                ceiling: [1.0; 3],
            },
            crate::highlight::Colouring::DEFAULT,
        );
        middle_of(&samples, inner, inner)
    }

    /// Half a step of the half float a level near `level` is stored as: what storing it can move it.
    fn stored_within(level: f64) -> f64 {
        level.abs() / 2048.0
    }

    /// Every orientation, against the permutation `orient_for_test` does on the host.
    ///
    /// **The inverse is the half that can be wrong on its own.** The shader is indexed by
    /// destination word, so it maps each output pixel *back* to a source one - and six of the eight
    /// cases are their own inverse while the two quarter turns are each other's, which is exactly
    /// the kind of table that reads fine and is transposed. Written from scratch it was: Transverse
    /// swaps which of the frame's two lasts bounds each axis, because a transposing turn puts the
    /// height on `x`, and the first version of this had it the other way round.
    ///
    /// A gradient with a distinct value per pixel, so a transposition cannot agree by symmetry the
    /// way a square of flat blocks would.
    #[test]
    fn every_orientation_lands_where_the_host_permutation_did() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(rcd) = super::device(gpu) else {
            return;
        };

        // Not square, so a transposing turn has to change the frame's shape rather than only move
        // its pixels - which a square fixture cannot see.
        let (w, h) = (96usize, 64usize);
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let mosaic: Vec<f32> = (0..w * h)
            .map(|at| 0.15 + 0.7 * (at % w) as f32 / w as f32 + 0.1 * (at / w) as f32 / h as f32)
            .collect();
        let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);

        // Inset from the edge so RCD's own margin is not the thing being compared.
        let crop = (16usize, 16usize, 48usize, 24usize);
        let identity = super::Colour {
            matrix: IDENTITY_F32,
            ceiling: [1.0; 3],
        };
        let unturned = demosaiced(
            gpu,
            rcd,
            &mosaic,
            (w, h),
            crop,
            identity,
            crate::highlight::Colouring::DEFAULT,
        );

        for orientation in 1..8u32 {
            let at = super::Placement {
                stride: crate::px::Span::exact(w),
                crop: crate::px::Rect::exact(crop.0, crop.1, crop.2, crop.3),
                dest: crate::px::At::ORIGIN,
                frame: crate::px::Size::exact(crop.2, crop.3),
                orientation,
                reduce: 1,
            };
            let (out_w, out_h) = at.out();
            let frame = super::frame_buffer(gpu, out_w * out_h);
            let (_shape, group) = super::shape_group(gpu, rcd, &cfa, &uploaded, super::MARGIN);
            let field = crate::highlight::measure(gpu, &uploaded, &cfa, identity.ceiling)
                .expect("the highlight field");
            pollster::block_on(super::demosaic_into(
                gpu,
                rcd,
                &uploaded,
                &cfa,
                &at,
                identity,
                field.seen(),
                &frame,
                &group,
            ))
            .expect("the demosaic runs");
            let turned = pollster::block_on(super::read_frame(gpu, &frame, out_w * out_h))
                .expect("it reads back");

            let (want, want_w, want_h) =
                crate::orientation::orient_for_test(unturned.clone(), crop.2, crop.3, orientation);
            assert_eq!(
                (out_w, out_h),
                (want_w, want_h),
                "orientation {orientation} sizes"
            );
            let worst = turned
                .iter()
                .zip(&want)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .expect("samples");
            assert_eq!(
                worst, 0,
                "orientation {orientation} differs by {worst} counts"
            );
        }
    }
}
