//! The viewer's stage drawn natively, for an Android TV: its WebView composites everything in SDR,
//! so the shell puts a window behind the page and the photograph is drawn into it by the browser's
//! own `stage.wgsl`, written as scRGB.

use super::{CANVAS_FORMAT, CANVAS_WHITE_NITS, Gpu, Texture};
use crate::avif::Coded;
use crate::hdr_fit;
use crate::light::{DisplayNits, Gain, Light};
use crate::px::{At, Canvas, Extent, Output, Place, Rect, Size, Span};

const STAGE_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/stage.wgsl"));

/// `ink` in `web/src/ui/tokens.stylex.ts`, what the page shows around the stage.
const INK: [u8; 3] = [0x14, 0x16, 0x1a];

/// `stage.slang`'s `SCRGB_WHITE`.
const SCRGB_WHITE_ID: &str = "0";

/// A still's planes on the device, drawn at whatever size its window is.
pub struct Picture {
    planes: [Texture; 3],
    /// As shown, after the file's turn.
    pub size: Size<Output>,
    depth: f32,
    chroma: f32,
    rotation: f32,
    /// The file's brightest light, against SDR white.
    source_peak: Gain,
}

impl Picture {
    /// One neutral light, `nits` everywhere and brightest, for the calibration's patch.
    pub fn flat(gpu: &Gpu, nits: f64) -> Option<Picture> {
        const SIDE: usize = 2;
        let signal = crate::tone::pq(Light::<DisplayNits>::exactly(nits)).raw();
        let luma = (64.0 + 876.0 * signal).round() as u16;
        let plane = |sample: u16| sample.to_le_bytes().repeat(SIDE * SIDE);
        let planes = [plane(luma), plane(512), plane(512)];
        Picture::upload(
            gpu,
            &Coded {
                planes: planes.each_ref().map(Vec::as_slice),
                strides: [SIDE * 2; 3],
                width: SIDE,
                height: SIDE,
                bits: 10,
                subsampled: false,
                rotation: 0,
                max_cll: Some(nits.ceil() as u16),
            },
        )
    }

    /// Each plane straight from the decoder's rows. None where a plane is past what this device
    /// holds in a texture.
    pub fn upload(gpu: &Gpu, coded: &Coded<'_>) -> Option<Picture> {
        let limit = gpu.limits().max_texture_dimension_2d as usize;
        if coded.width.max(coded.height) > limit {
            return None;
        }
        let (chroma_width, chroma_height) = match coded.subsampled {
            true => (coded.width.div_ceil(2), coded.height.div_ceil(2)),
            false => (coded.width, coded.height),
        };
        let planes = [0, 1, 2].map(|at| {
            let size = match at {
                0 => wgpu::Extent3d {
                    width: coded.width as u32,
                    height: coded.height as u32,
                    depth_or_array_layers: 1,
                },
                _ => wgpu::Extent3d {
                    width: chroma_width as u32,
                    height: chroma_height as u32,
                    depth_or_array_layers: 1,
                },
            };
            let plane = gpu.own_texture(&wgpu::TextureDescriptor {
                label: Some("stage plane"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R16Uint,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            gpu.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &plane,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                coded.planes[at],
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(coded.strides[at] as u32),
                    rows_per_image: Some(size.height),
                },
                size,
            );
            plane
        });
        let sideways = coded.rotation == 90 || coded.rotation == 270;
        let (width, height) = match sideways {
            true => (coded.height, coded.width),
            false => (coded.width, coded.height),
        };
        // A file that states no `clli` is rolled from PQ's ceiling, as the browser's stage does.
        let peak = coded.max_cll.map_or(Light::PQ_CEILING, |nits| {
            Light::<DisplayNits>::exactly(f64::from(nits))
        });
        Some(Picture {
            planes,
            size: Size::measured(width, height),
            depth: if coded.bits == 12 { 4.0 } else { 1.0 },
            chroma: if coded.subsampled { 0.5 } else { 1.0 },
            rotation: f32::from(coded.rotation),
            source_peak: Gain::of_ratio(peak.raw() / CANVAS_WHITE_NITS),
        })
    }
}

/// How a draw fits the display it lands on.
#[derive(Clone, Copy)]
pub struct Display {
    /// The display's peak against its SDR white, which highlights are rolled onto.
    pub headroom: Gain,
    /// The scRGB value the display shows SDR white at; 0 writes the browser's canvas encoding.
    pub white: Gain,
}

/// `picture` into `fit` on `target`, a view in [`CANVAS_FORMAT`], with the page's own ink around it.
pub fn draw(
    gpu: &Gpu,
    picture: &Picture,
    target: &wgpu::TextureView,
    fit: Rect<Canvas>,
    display: Display,
) {
    let sample = |across: Span<Canvas>, shown: Span<Output>| {
        Extent::<Canvas>::measured(1.0).onto(across, shown).raw() as f32
    };
    let (left, top, width, height) = fit.raw();
    // `stage.slang`'s `Colour`, field for field.
    let colour: [f32; 12] = [
        display.headroom.raw().max(1.0) as f32,
        CANVAS_WHITE_NITS as f32,
        sample(fit.size.width, picture.size.width),
        sample(fit.size.height, picture.size.height),
        picture.depth,
        picture.chroma,
        -(left as f32),
        -(top as f32),
        1.0,
        picture.rotation,
        0.0,
        picture.source_peak.raw() as f32,
    ];
    let pipeline = pipeline(gpu, display.white);
    let mut recording = gpu.record();
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("stage colour"),
        contents: bytemuck::cast_slice(&colour),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let [red, green, blue] = INK.map(|coded| hdr_fit::srgb_eotf(coded) * display.white.raw());
    let views = picture.planes.each_ref().map(Texture::view);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("stage"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&views[0]),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&views[1]),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(&views[2]),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: uniform.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording
            .encoder()
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("stage"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: red,
                            g: green,
                            b: blue,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
        pass.set_viewport(
            left as f32,
            top as f32,
            width as f32,
            height as f32,
            0.0,
            1.0,
        );
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    recording.submit();
}

pub(crate) fn pipeline(gpu: &Gpu, white: Gain) -> wgpu::RenderPipeline {
    static MODULE: std::sync::OnceLock<wgpu::ShaderModule> = std::sync::OnceLock::new();
    static BUILT: std::sync::Mutex<Vec<(u64, wgpu::RenderPipeline)>> =
        std::sync::Mutex::new(Vec::new());
    let mut built = BUILT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = white.raw().to_bits();
    if let Some((_, pipeline)) = built.iter().find(|(bits, _)| *bits == key) {
        return pipeline.clone();
    }
    let device = gpu.describing();
    let module = MODULE.get_or_init(|| {
        device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("stage"),
            source: wgpu::ShaderSource::Wgsl(STAGE_WGSL.into()),
        })
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("stage"),
        layout: None,
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vertex"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some("planar"),
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: crate::wgsl_overrides::for_entry(
                    "stage.wgsl",
                    "planar",
                    &[(SCRGB_WHITE_ID, white.raw())],
                ),
                ..Default::default()
            },
            targets: &[Some(CANVAS_FORMAT.into())],
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: Default::default(),
        cache: None,
    });
    built.push((key, pipeline.clone()));
    pipeline
}

pub fn measured(left: usize, top: usize, width: usize, height: usize) -> Rect<Canvas> {
    Rect {
        at: At {
            x: Place::measured(left),
            y: Place::measured(top),
        },
        size: Size::measured(width, height),
    }
}

/// A TV's window, behind the page, configured for scRGB.
#[cfg(target_os = "android")]
pub struct SurfaceStage {
    surface: wgpu::Surface<'static>,
    size: Size<Canvas>,
    alpha: wgpu::CompositeAlphaMode,
}

#[cfg(target_os = "android")]
impl SurfaceStage {
    /// An error where the window cannot take scRGB, which leaves the page drawing the photograph.
    ///
    /// # Safety
    /// `window` is an `ANativeWindow` that outlives the stage.
    #[expect(unsafe_code)]
    pub unsafe fn attach(
        gpu: &Gpu,
        window: std::ptr::NonNull<std::ffi::c_void>,
        size: Size<Canvas>,
    ) -> Result<SurfaceStage, String> {
        use wgpu::rwh::{
            AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
        };
        // SAFETY: the caller's.
        let surface = unsafe {
            gpu.instance
                .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle: Some(
                        RawDisplayHandle::Android(AndroidDisplayHandle::new()),
                    ),
                    raw_window_handle: RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(
                        window,
                    )),
                })
        }
        .map_err(|refused| format!("the window refused a surface: {refused}"))?;
        let capabilities = surface.get_capabilities(&gpu.answered);
        let offered = capabilities.color_spaces(CANVAS_FORMAT);
        if !offered.contains(wgpu::SurfaceColorSpaces::EXTENDED_SRGB_LINEAR) {
            return Err(format!("the window takes no scRGB, only {offered:?}"));
        }
        let alpha = [
            wgpu::CompositeAlphaMode::Opaque,
            wgpu::CompositeAlphaMode::Inherit,
        ]
        .into_iter()
        .find(|mode| capabilities.alpha_modes.contains(mode))
        .ok_or_else(|| {
            format!(
                "the window offers no opaque alpha: {:?}",
                capabilities.alpha_modes
            )
        })?;
        let mut stage = SurfaceStage {
            surface,
            size: Size::default(),
            alpha,
        };
        stage.resize(gpu, size);
        Ok(stage)
    }

    pub fn resize(&mut self, gpu: &Gpu, size: Size<Canvas>) {
        let (width, height) = size.raw();
        let size = Size::measured(width.max(1), height.max(1));
        if size == self.size {
            return;
        }
        self.configure(gpu, size);
    }

    /// `picture` into `fit`, which lies inside the window.
    pub fn present(
        &mut self,
        gpu: &Gpu,
        picture: &Picture,
        fit: Rect<Canvas>,
        display: Display,
    ) -> Result<(), String> {
        let (left, top, width, height) = fit.raw();
        let (window_width, window_height) = self.size.raw();
        if width == 0 || height == 0 || left + width > window_width || top + height > window_height
        {
            return Err(format!("{fit:?} is not inside the {:?} window", self.size));
        }
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.configure(gpu, self.size);
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(frame)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                    other => return Err(format!("the window gave no frame: {other:?}")),
                }
            }
            other => return Err(format!("the window gave no frame: {other:?}")),
        };
        let view = frame.texture.create_view(&Default::default());
        draw(gpu, picture, &view, fit, display);
        gpu.queue.present(frame);
        Ok(())
    }

    fn configure(&mut self, gpu: &Gpu, size: Size<Canvas>) {
        let (width, height) = size.raw();
        self.surface.configure(
            &gpu.device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: CANVAS_FORMAT,
                color_space: wgpu::SurfaceColorSpace::ExtendedSrgbLinear,
                width: width as u32,
                height: height as u32,
                present_mode: wgpu::PresentMode::Fifo,
                // A still: nothing queues behind the frame on screen, so no image waits spare.
                desired_maximum_frame_latency: 1,
                alpha_mode: self.alpha,
                view_formats: Vec::new(),
            },
        );
        self.size = size;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIDE: usize = 2;

    /// Two rows of limited-range PQ, 10-bit 4:4:4, a column per `(nits, blue, red)`, uploaded.
    fn picture(gpu: &Gpu, columns: &[(f32, u16, u16)], max_cll: u16) -> Picture {
        let width = columns.len();
        // Padded past the row, as libavif pads its rows to a stride.
        let stride = width * 2 + 6;
        let plane = |value: &dyn Fn(&(f32, u16, u16)) -> u16| -> Vec<u8> {
            let mut row: Vec<u8> = columns
                .iter()
                .flat_map(|column| value(column).to_le_bytes())
                .collect();
            row.resize(stride, 0xff);
            row.repeat(SIDE)
        };
        let luma = |&(nits, _, _): &(f32, u16, u16)| {
            let signal = crate::tone::pq(Light::<DisplayNits>::exactly(f64::from(nits))).raw();
            (64.0 + 876.0 * signal).round() as u16
        };
        let planes = [
            plane(&luma),
            plane(&|column| column.1),
            plane(&|column| column.2),
        ];
        let coded = Coded {
            planes: planes.each_ref().map(Vec::as_slice),
            strides: [stride; 3],
            width,
            height: SIDE,
            bits: 10,
            subsampled: false,
            rotation: 0,
            max_cll: Some(max_cll),
        };
        Picture::upload(gpu, &coded).expect("a small picture")
    }

    fn grey(gpu: &Gpu, nits: f32, max_cll: u16) -> Picture {
        picture(gpu, &[(nits, 512, 512); SIDE], max_cll)
    }

    /// What `picture` draws at `display` into `fit` of a window, at the window's `at`.
    fn drawn_at(
        gpu: &Gpu,
        picture: &Picture,
        display: Display,
        window: (usize, usize),
        fit: Rect<Canvas>,
        at: (u32, u32),
    ) -> [f32; 3] {
        let target = gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some("stage under test"),
            size: wgpu::Extent3d {
                width: window.0 as u32,
                height: window.1 as u32,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: CANVAS_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        draw(gpu, picture, &target.view(), fit, display);
        let mut recording = gpu.record();
        let staged = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("stage readback"),
            size: 256,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.encoder().copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: at.0,
                    y: at.1,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staged,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(1),
                },
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        recording.submit();
        pollster::block_on(crate::gpu::read_back(gpu, &staged, |bytes| {
            [0, 2, 4].map(|at| {
                half::f16::from_bits(u16::from_le_bytes([bytes[at], bytes[at + 1]])).to_f32()
            })
        }))
        .expect("the stage read back")
    }

    /// Display P3 to BT.709, both linear: what the browser's canvas is decoded through to compare.
    const P3_TO_709: [[f32; 3]; 3] = [
        [1.224_940_2, -0.224_940_4, 0.0],
        [-0.042_056_955, 1.042_057_1, 0.0],
        [-0.019_637_555, -0.078_636_05, 1.098_273_6],
    ];

    /// The browser's sRGB-encoded, extended display-p3 back to linear BT.709.
    fn browser_light(encoded: [f32; 3]) -> [f32; 3] {
        let decoded = encoded.map(|code| {
            let magnitude = code.abs();
            let linear = if magnitude <= 0.04045 {
                magnitude / 12.92
            } else {
                ((magnitude + 0.055) / 1.055).powf(2.4)
            };
            linear.copysign(code)
        });
        P3_TO_709.map(|row| {
            row.iter()
                .zip(decoded)
                .map(|(weight, value)| weight * value)
                .sum()
        })
    }

    /// What a TV's window is handed is the browser's own stage, light for light: SDR white lands
    /// on the window's white, a highlight rolls onto the display's peak by the same curve, and a
    /// colour comes out in the same primaries.
    #[test]
    fn the_window_is_drawn_the_light_the_browser_stage_draws() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so the stage was not drawn.");
            return;
        };
        let white = Gain::of_ratio(6.0);
        let whole = measured(0, 0, SIDE, SIDE);
        let drawn = |picture: &Picture, display: Display| {
            drawn_at(gpu, picture, display, (SIDE, SIDE), whole, (0, 0))
        };
        for (nits, blue, red, headroom) in [
            (203.0, 512, 512, 4.9),
            (1000.0, 512, 512, 2.5),
            (60.0, 512, 512, 2.5),
            (120.0, 470, 600, 2.5),
        ] {
            let headroom = Gain::of_ratio(headroom);
            let picture = picture(gpu, &[(nits, blue, red); SIDE], 1200);
            let window = drawn(&picture, Display { headroom, white });
            let browser = Display {
                headroom,
                white: Gain::of_ratio(0.0),
            };
            let agreed =
                browser_light(drawn(&picture, browser)).map(|light| light * white.raw() as f32);
            for channel in 0..3 {
                let (window, agreed) = (window[channel], agreed[channel]);
                assert!(
                    // A half float's step, through the browser's sRGB curve.
                    (window - agreed).abs() <= agreed.abs().max(white.raw() as f32 * 0.01) * 5e-3,
                    "{nits} nits ({blue}, {red}) at {headroom:?}, channel {channel}: \
                     the window has {window}, the browser {agreed}"
                );
            }
            if (blue, red) != (512, 512) {
                continue;
            }
            let window = window[0];
            let peak = (white * headroom).raw() as f32;
            assert!(
                window <= peak * 1.001,
                "{nits} nits drew at {window}, past the peak's {peak}"
            );
            if nits == 203.0 {
                let white = white.raw() as f32;
                assert!(
                    (window - white).abs() <= white * 0.01,
                    "SDR white drew at {window}"
                );
            }
        }
    }

    /// A window keeps its size from photo to photo, so each picture is letterboxed inside it in the
    /// page's ink, lit at the window's white, as the page shows around the stage.
    #[test]
    fn a_picture_is_drawn_inside_its_letterbox() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so the stage was not drawn.");
            return;
        };
        let display = Display {
            headroom: Gain::of_ratio(4.9),
            white: Gain::of_ratio(6.0),
        };
        // Two columns, SDR white then dimmer, magnified twice across and once and a half down.
        let picture = picture(gpu, &[(203.0, 512, 512), (60.0, 512, 512)], 1200);
        let dim = drawn_at(
            gpu,
            &grey(gpu, 60.0, 1200),
            display,
            (SIDE, SIDE),
            measured(0, 0, SIDE, SIDE),
            (0, 0),
        )[0];
        let fit = measured(3, 1, 4, 3);
        let window = (9, 5);
        for (at, expected) in [((3, 1), 6.0), ((4, 3), 6.0), ((5, 1), dim), ((6, 3), dim)] {
            let inside = drawn_at(gpu, &picture, display, window, fit, at)[0];
            assert!(
                (inside - expected).abs() <= expected * 0.01,
                "{at:?} drew {inside}, not {expected}"
            );
        }
        let ink = INK.map(|coded| hdr_fit::srgb_eotf(coded) as f32 * 6.0);
        for at in [(0, 0), (3, 0), (2, 1), (7, 1), (4, 4), (8, 4)] {
            let around = drawn_at(gpu, &picture, display, window, fit, at);
            for channel in 0..3 {
                assert!(
                    (around[channel] - ink[channel]).abs() <= ink[channel] * 5e-3,
                    "{at:?} drew {around:?}, not ink's {ink:?}"
                );
            }
        }
    }
}
