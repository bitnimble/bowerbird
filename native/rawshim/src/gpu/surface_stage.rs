//! The viewer's stage drawn natively, for an Android TV: its WebView composites everything in SDR,
//! so the shell puts a window behind the page and the photograph is drawn into it by the browser's
//! own `stage.wgsl`, written as scRGB.

use super::{CANVAS_FORMAT, CANVAS_WHITE_NITS, Gpu, Texture};
use crate::avif::Coded;
use crate::light::{DisplayNits, Gain, Light};
use crate::px::{Canvas, Extent, Output, Size, Span};

const STAGE_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/stage.wgsl"));

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
    /// None where a plane is past what this device holds in a texture.
    pub fn upload(gpu: &Gpu, coded: &Coded) -> Option<Picture> {
        let layout = &coded.layout;
        let limit = gpu.limits().max_texture_dimension_2d as usize;
        if layout.width.max(layout.height) > limit {
            return None;
        }
        let (chroma_width, chroma_height) = match layout.subsampled {
            true => (layout.width.div_ceil(2), layout.height.div_ceil(2)),
            false => (layout.width, layout.height),
        };
        let planes = [0, 1, 2].map(|at| {
            let (width, height) = match at {
                0 => (layout.width, layout.height),
                _ => (chroma_width, chroma_height),
            };
            let plane = &layout.planes[at];
            // Rows packed to the width, where libavif pads its rows to a stride.
            let row = width * 2;
            let mut packed = Vec::with_capacity(row * height);
            for y in 0..height {
                let start = plane.offset + y * plane.stride;
                packed.extend_from_slice(&coded.samples[start..start + row]);
            }
            gpu.own_texture_with_data(
                &wgpu::TextureDescriptor {
                    label: Some("stage plane"),
                    size: wgpu::Extent3d {
                        width: width as u32,
                        height: height as u32,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::R16Uint,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                &packed,
            )
        });
        let sideways = coded.rotation == 90 || coded.rotation == 270;
        let (width, height) = match sideways {
            true => (layout.height, layout.width),
            false => (layout.width, layout.height),
        };
        // A file that states no `clli` is rolled from PQ's ceiling, as the browser's stage does.
        let peak = coded.max_cll.map_or(Light::PQ_CEILING, |nits| {
            Light::<DisplayNits>::exactly(f64::from(nits))
        });
        Some(Picture {
            planes,
            size: Size::measured(width, height),
            depth: if layout.bits == 12 { 4.0 } else { 1.0 },
            chroma: if layout.subsampled { 0.5 } else { 1.0 },
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

/// `picture` over the whole of `target`, a view of `window`'s size in [`CANVAS_FORMAT`].
pub fn draw(
    gpu: &Gpu,
    picture: &Picture,
    target: &wgpu::TextureView,
    window: Size<Canvas>,
    display: Display,
) {
    let sample = |across: Span<Canvas>, shown: Span<Output>| {
        Extent::<Canvas>::measured(1.0).onto(across, shown).raw() as f32
    };
    // `stage.slang`'s `Colour`, field for field.
    let colour: [f32; 12] = [
        display.headroom.raw().max(1.0) as f32,
        CANVAS_WHITE_NITS as f32,
        sample(window.width, picture.size.width),
        sample(window.height, picture.size.height),
        picture.depth,
        picture.chroma,
        0.0,
        0.0,
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
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    recording.submit();
}

/// Built once per white, which is a constant of the pipeline.
fn pipeline(gpu: &Gpu, white: Gain) -> wgpu::RenderPipeline {
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

/// A TV's window, behind the page, configured for scRGB.
#[cfg(target_os = "android")]
pub struct SurfaceStage {
    surface: wgpu::Surface<'static>,
    size: Size<Canvas>,
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
        let offered = surface
            .get_capabilities(&gpu.answered)
            .color_spaces(CANVAS_FORMAT);
        if !offered.contains(wgpu::SurfaceColorSpaces::EXTENDED_SRGB_LINEAR) {
            return Err(format!("the window takes no scRGB, only {offered:?}"));
        }
        let mut stage = SurfaceStage {
            surface,
            size: Size::default(),
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

    pub fn present(
        &mut self,
        gpu: &Gpu,
        picture: &Picture,
        display: Display,
    ) -> Result<(), String> {
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
        draw(gpu, picture, &view, self.size, display);
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
                alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                view_formats: Vec::new(),
            },
        );
        self.size = size;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey picture whose every sample codes `nits` in limited-range PQ, 10-bit 4:4:4.
    fn grey(nits: f32, max_cll: u16) -> Coded {
        let signal = crate::tone::pq(Light::<DisplayNits>::exactly(f64::from(nits))).raw();
        let code = (64.0 + 876.0 * signal).round() as u16;
        let (width, height) = (2, 2);
        let plane = |value: u16| -> Vec<u8> {
            std::iter::repeat_n(value.to_le_bytes(), width * height)
                .flatten()
                .collect()
        };
        let samples = [plane(code), plane(512), plane(512)].concat();
        let size = width * height * 2;
        Coded {
            samples,
            layout: crate::planes::Layout {
                width,
                height,
                bits: 10,
                subsampled: false,
                planes: [0, 1, 2].map(|at| crate::planes::Plane {
                    offset: at * size,
                    stride: width * 2,
                }),
            },
            rotation: 0,
            max_cll: Some(max_cll),
        }
    }

    /// The red channel of the first pixel `picture` draws at `display`.
    fn drawn(gpu: &Gpu, picture: &Picture, display: Display) -> f32 {
        let (width, height) = picture.size.raw();
        let target = gpu.own_texture(&wgpu::TextureDescriptor {
            label: Some("stage under test"),
            size: wgpu::Extent3d {
                width: width as u32,
                height: height as u32,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: CANVAS_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let window = Size::measured(width, height);
        draw(gpu, picture, &target.view(), window, display);
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
                origin: wgpu::Origin3d::ZERO,
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
            half::f16::from_bits(u16::from_le_bytes([bytes[0], bytes[1]])).to_f32()
        }))
        .expect("the stage read back")
    }

    fn srgb_decoded(code: f32) -> f32 {
        if code <= 0.04045 {
            code / 12.92
        } else {
            ((code + 0.055) / 1.055).powf(2.4)
        }
    }

    /// What a TV's window is handed is the browser's own stage, light for light: SDR white lands
    /// on the window's white, and a highlight rolls onto the display's peak by the same curve.
    #[test]
    fn the_window_is_drawn_the_light_the_browser_stage_draws() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so the stage was not drawn.");
            return;
        };
        let white = Gain::of_ratio(6.0);
        for (nits, headroom) in [(203.0, 4.9), (1000.0, 2.5), (60.0, 2.5)] {
            let headroom = Gain::of_ratio(headroom);
            let picture = Picture::upload(gpu, &grey(nits, 1200)).expect("a 2x2 picture");
            let window = drawn(gpu, &picture, Display { headroom, white });
            let browser = Display {
                headroom,
                white: Gain::of_ratio(0.0),
            };
            let agreed = srgb_decoded(drawn(gpu, &picture, browser)) * white.raw() as f32;
            assert!(
                // A half float's step, through the browser's sRGB curve.
                (window - agreed).abs() <= agreed * 5e-3,
                "{nits} nits at {headroom:?}: the window has {window}, the browser {agreed}"
            );
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
}
