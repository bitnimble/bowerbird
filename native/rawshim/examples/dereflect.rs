//! The reflection remover's network (`models/dereflect`, LightRR) on the device, a prototype held
//! against torch by `models/dereflect`'s `device_check`.
//!
//! ```text
//! dereflect <weights-dir> <in.f32> <width> <height> <out.f32>
//! ```
//!
//! Reads planar RGB light coded as the network takes it, sides multiples of 16, and writes the
//! reflection it predicts, coded the same.

use std::collections::HashMap;

use rawshim::gpu::{Buffer, Gpu};

const WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/lightrr.wgsl"));
const STATE: usize = 16;
const THREADS: usize = 64;
const KERNELS: [&str; 12] = [
    "conv",
    "layernorm",
    "silu_inplace",
    "gate",
    "scale_add",
    "fuse",
    "dwt",
    "idwt",
    "scan",
    "sum4",
    "gram",
    "softmax",
];

#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    span: u32,
    count: u32,
    width: u32,
    height: u32,
    in_channels: u32,
    out_channels: u32,
    kernel: u32,
    pad: u32,
    groups: u32,
    has_bias: u32,
    src_at: u32,
    src2_at: u32,
    dst_at: u32,
    weight_at: u32,
    bias_at: u32,
    extra0: u32,
    extra1: u32,
    extra2: u32,
    extra3: u32,
    eps: f32,
    pad0: [u32; 4],
}

/// A plane stack in a buffer of its own, from `at` floats in.
#[derive(Clone)]
struct Planes {
    buffer: Buffer,
    at: usize,
    c: usize,
    h: usize,
    w: usize,
}

impl Planes {
    fn plane(&self) -> usize {
        self.h * self.w
    }

    fn len(&self) -> usize {
        self.c * self.plane()
    }

    fn channels(&self, from: usize, count: usize) -> Planes {
        Planes {
            at: self.at + from * self.plane(),
            c: count,
            ..self.clone()
        }
    }
}

struct Net {
    gpu: &'static Gpu,
    layout: wgpu::BindGroupLayout,
    pipelines: HashMap<&'static str, wgpu::ComputePipeline>,
    weights: Buffer,
    tensors: HashMap<String, usize>,
    empty: Buffer,
}

struct Bind<'a> {
    src: Option<&'a Buffer>,
    src2: Option<&'a Buffer>,
    weights: Option<&'a Buffer>,
    dst: &'a Buffer,
}

impl Net {
    fn new(gpu: &'static Gpu, dir: &str) -> Net {
        let read = |name: &str| {
            let path = format!("{dir}/{name}");
            std::fs::read(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
        };
        let bytes = read("weights.bin");
        let manifest: serde_json::Value =
            serde_json::from_slice(&read("weights.json")).expect("weights.json parses");
        let tensors: HashMap<String, usize> = manifest["tensors"]
            .as_array()
            .expect("tensors")
            .iter()
            .map(|t| {
                let name = t["name"].as_str().expect("a name").to_string();
                (name, t["offset"].as_u64().expect("an offset") as usize)
            })
            .collect();
        assert!(
            !tensors.keys().any(|name| name.starts_with("semantics.")),
            "{dir} reads a DINOv2 backbone, which this port doesn't run yet"
        );
        assert!(
            !tensors.keys().any(|name| name.starts_with("locate."))
                && manifest["passes"].as_u64().unwrap_or(1) == 1,
            "{dir} gates by location or looks twice, which this port doesn't run yet"
        );
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("lightrr"),
            source: wgpu::ShaderSource::Wgsl(WGSL.into()),
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
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("lightrr"),
            entries: &[
                storage(0, true),
                storage(1, true),
                storage(2, false),
                storage(3, true),
                wgpu::BindGroupLayoutEntry {
                    binding: 20,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("lightrr"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipelines = KERNELS
            .iter()
            .map(|&name| {
                let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(name),
                    layout: Some(&pipeline_layout),
                    module: &module,
                    entry_point: Some(name),
                    compilation_options: Default::default(),
                    cache: None,
                });
                (name, pipeline)
            })
            .collect();
        let weights = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("lightrr weights"),
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let empty = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("lightrr empty"),
            size: 16,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        Net {
            gpu,
            layout,
            pipelines,
            weights,
            tensors,
            empty,
        }
    }

    fn at(&self, name: &str) -> u32 {
        *self
            .tensors
            .get(name)
            .unwrap_or_else(|| panic!("the weights hold no {name}")) as u32
    }

    fn tensor(&self, c: usize, h: usize, w: usize) -> Planes {
        let size = (c * h * w * 4).max(16) as u64;
        let limit = u64::from(self.gpu.limits().max_storage_buffer_binding_size);
        assert!(
            size <= limit,
            "a {size} byte plane stack is past the adapter's {limit}; pass a smaller input"
        );
        Planes {
            buffer: self.gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some("lightrr plane"),
                size,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            at: 0,
            c,
            h,
            w,
        }
    }

    fn dispatch(&self, kernel: &str, mut params: Params, bind: Bind<'_>, threads: usize) {
        assert!(threads > 0, "{kernel} has no work");
        let mut recording = self.gpu.record();
        let groups = threads.div_ceil(THREADS);
        let wide = groups.min(65535);
        let tall = groups.div_ceil(wide);
        params.span = (wide * THREADS) as u32;
        params.count = threads as u32;
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("lightrr params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        fn entry(binding: u32, buffer: &Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry {
                binding,
                resource: buffer.as_entire_binding(),
            }
        }
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some(kernel),
            layout: &self.layout,
            entries: &[
                entry(0, bind.src.unwrap_or(&self.empty)),
                entry(1, bind.weights.unwrap_or(&self.weights)),
                entry(2, bind.dst),
                entry(3, bind.src2.unwrap_or(&self.empty)),
                entry(20, &uniform),
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipelines[kernel]);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(wide as u32, tall as u32, 1);
        }
        recording.submit();
    }

    /// `nn.Conv2d` with stride 1 and `k / 2` padding; `weights` in place of the checkpoint's where
    /// the attention hands its own matrix in.
    #[allow(clippy::too_many_arguments)]
    fn conv(
        &self,
        x: &Planes,
        weight: u32,
        bias: Option<u32>,
        out: usize,
        k: usize,
        groups: usize,
        weights: Option<&Buffer>,
    ) -> Planes {
        let y = self.tensor(out, x.h, x.w);
        self.dispatch(
            "conv",
            Params {
                width: x.w as u32,
                height: x.h as u32,
                in_channels: x.c as u32,
                out_channels: out as u32,
                kernel: k as u32,
                pad: (k / 2) as u32,
                groups: groups as u32,
                has_bias: bias.is_some() as u32,
                src_at: x.at as u32,
                weight_at: weight,
                bias_at: bias.unwrap_or(0),
                ..Default::default()
            },
            Bind {
                src: Some(&x.buffer),
                src2: None,
                weights,
                dst: &y.buffer,
            },
            y.len(),
        );
        y
    }

    fn named_conv(&self, x: &Planes, name: &str, out: usize, k: usize, groups: usize) -> Planes {
        let bias = self
            .tensors
            .contains_key(&format!("{name}.bias"))
            .then(|| self.at(&format!("{name}.bias")));
        self.conv(
            x,
            self.at(&format!("{name}.weight")),
            bias,
            out,
            k,
            groups,
            None,
        )
    }

    fn layernorm(&self, x: &Planes, name: &str) -> Planes {
        let y = self.tensor(x.c, x.h, x.w);
        self.dispatch(
            "layernorm",
            Params {
                width: x.w as u32,
                height: x.h as u32,
                in_channels: x.c as u32,
                src_at: x.at as u32,
                weight_at: self.at(&format!("{name}.weight")),
                bias_at: self.at(&format!("{name}.bias")),
                eps: 1e-5,
                ..Default::default()
            },
            Bind {
                src: Some(&x.buffer),
                src2: None,
                weights: None,
                dst: &y.buffer,
            },
            x.plane(),
        );
        y
    }

    /// `a op b` elementwise into a fresh plane stack, `weight_at` and `bias_at` as the kernel reads
    /// them.
    fn pair(&self, kernel: &str, a: &Planes, b: &Planes, weight_at: u32, bias_at: u32) -> Planes {
        let y = self.tensor(a.c, a.h, a.w);
        self.dispatch(
            kernel,
            Params {
                width: a.w as u32,
                height: a.h as u32,
                src_at: a.at as u32,
                src2_at: b.at as u32,
                weight_at,
                bias_at,
                ..Default::default()
            },
            Bind {
                src: Some(&a.buffer),
                src2: Some(&b.buffer),
                weights: None,
                dst: &y.buffer,
            },
            a.len(),
        );
        y
    }

    fn dwt(&self, x: &Planes) -> Planes {
        let y = self.tensor(x.c * 4, x.h / 2, x.w / 2);
        self.dispatch(
            "dwt",
            Params {
                width: x.w as u32,
                height: x.h as u32,
                in_channels: x.c as u32,
                src_at: x.at as u32,
                ..Default::default()
            },
            Bind {
                src: Some(&x.buffer),
                src2: None,
                weights: None,
                dst: &y.buffer,
            },
            x.len() / 4,
        );
        y
    }

    fn idwt(&self, x: &Planes) -> Planes {
        let c = x.c / 4;
        let y = self.tensor(c, x.h * 2, x.w * 2);
        self.dispatch(
            "idwt",
            Params {
                width: x.w as u32,
                height: x.h as u32,
                out_channels: c as u32,
                src_at: x.at as u32,
                ..Default::default()
            },
            Bind {
                src: Some(&x.buffer),
                src2: None,
                weights: None,
                dst: &y.buffer,
            },
            c * x.plane(),
        );
        y
    }

    fn cat(&self, parts: &[&Planes]) -> Planes {
        assert!(
            parts.iter().all(|p| (p.h, p.w) == (parts[0].h, parts[0].w)),
            "joined planes differ in size"
        );
        let c = parts.iter().map(|p| p.c).sum();
        let y = self.tensor(c, parts[0].h, parts[0].w);
        let mut recording = self.gpu.record();
        let mut at = 0;
        for part in parts {
            let bytes = (part.len() * 4) as u64;
            recording.encoder().copy_buffer_to_buffer(
                &part.buffer,
                (part.at * 4) as u64,
                &y.buffer,
                at,
                bytes,
            );
            at += bytes;
        }
        recording.submit();
        y
    }

    fn afm(&self, x: &Planes, p: &str) -> Planes {
        let (c, h, w) = (x.c, x.h, x.w);
        let inner = 2 * c;
        let rank = c.div_ceil(16);
        let sa = format!("{p}.self_attention");
        let normed = self.layernorm(x, &format!("{p}.ln_1"));
        let in_proj = self.at(&format!("{sa}.in_proj.weight"));
        let xs = self.conv(&normed, in_proj, None, inner, 1, 1, None);
        let z = self.conv(
            &normed,
            in_proj + (inner * c) as u32,
            None,
            inner,
            1,
            1,
            None,
        );
        drop(normed);

        let bands = self.dwt(&xs);
        drop(xs);
        let bands = self.named_conv(&bands, &format!("{sa}.DWConv2d"), 4 * inner, 3, 4 * inner);
        self.dispatch(
            "silu_inplace",
            Params::default(),
            Bind {
                src: None,
                src2: None,
                weights: None,
                dst: &bands.buffer,
            },
            bands.len(),
        );
        let ll = bands.channels(0, inner);
        let rows = rank + 2 * STATE;
        let x_dbl = self.conv(
            &ll,
            self.at(&format!("{sa}.x_proj_weight")),
            None,
            4 * rows,
            1,
            1,
            None,
        );
        let ys = self.tensor(4 * inner, ll.h, ll.w);
        self.dispatch(
            "scan",
            Params {
                width: ll.w as u32,
                height: ll.h as u32,
                weight_at: self.at(&format!("{sa}.dt_projs_weight")),
                bias_at: self.at(&format!("{sa}.dt_projs_bias")),
                extra0: self.at(&format!("{sa}.A_logs")),
                extra1: self.at(&format!("{sa}.Ds")),
                extra2: rank as u32,
                extra3: inner as u32,
                ..Default::default()
            },
            Bind {
                src: Some(&bands.buffer),
                src2: Some(&x_dbl.buffer),
                weights: None,
                dst: &ys.buffer,
            },
            4 * inner,
        );
        drop(x_dbl);
        self.dispatch(
            "sum4",
            Params {
                src_at: ys.at as u32,
                ..Default::default()
            },
            Bind {
                src: Some(&ys.buffer),
                src2: None,
                weights: None,
                dst: &bands.buffer,
            },
            ll.len(),
        );
        drop(ys);

        let y = self.idwt(&bands);
        drop(bands);
        assert_eq!((y.c, y.h, y.w), (inner, h, w));
        let y = self.layernorm(&y, &format!("{sa}.out_norm"));
        let gated = self.pair("gate", &y, &z, 0, 0);
        let out = self.conv(
            &gated,
            self.at(&format!("{sa}.out_proj.weight")),
            None,
            c,
            1,
            1,
            None,
        );
        self.pair("scale_add", x, &out, self.at(&format!("{p}.skip_scale")), 0)
    }

    fn stage(&self, x: &Planes, p: &str) -> Planes {
        let mut x = x.clone();
        let mut block = 0;
        while self
            .tensors
            .contains_key(&format!("{p}.blocks.{block}.skip_scale"))
        {
            x = self.afm(&x, &format!("{p}.blocks.{block}"));
            // Unawaited, every block's intermediates stay alive until the whole forward finishes.
            pollster::block_on(rawshim::gpu::finished(self.gpu));
            block += 1;
        }
        assert!(block > 0, "the weights hold no {p}.blocks");
        x
    }

    /// `CrossScaleFusion` of one `CrossChannelAtt`: `att(q, kv) + kv * alpha + q * beta`.
    fn fusion(&self, q_in: &Planes, kv_in: &Planes, p: &str, heads: usize) -> Planes {
        let c = q_in.c;
        let b = format!("{p}.blocks.0");
        let q = self.named_conv(q_in, &format!("{b}.q"), c, 1, 1);
        let q = self.named_conv(&q, &format!("{b}.q_conv"), c, 3, c);
        let kv = self.named_conv(kv_in, &format!("{b}.kv"), 2 * c, 1, 1);
        let kv = self.named_conv(&kv, &format!("{b}.kv_conv"), 2 * c, 3, 2 * c);
        let attention = self.tensor(c, c, 1);
        let params = Params {
            width: q.w as u32,
            height: q.h as u32,
            in_channels: c as u32,
            extra0: heads as u32,
            extra1: self.at(&format!("{b}.temperature")),
            ..Default::default()
        };
        self.dispatch(
            "gram",
            params,
            Bind {
                src: Some(&q.buffer),
                src2: Some(&kv.buffer),
                weights: None,
                dst: &attention.buffer,
            },
            c * c,
        );
        self.dispatch(
            "softmax",
            params,
            Bind {
                src: None,
                src2: None,
                weights: None,
                dst: &attention.buffer,
            },
            c,
        );
        let v = kv.channels(c, c);
        let attended = self.conv(&v, 0, None, c, 1, 1, Some(&attention.buffer));
        let out = self.named_conv(&attended, &format!("{b}.project_out"), c, 1, 1);
        self.dispatch(
            "fuse",
            Params {
                src_at: kv_in.at as u32,
                src2_at: q_in.at as u32,
                weight_at: self.at(&format!("{p}.alpha")),
                bias_at: self.at(&format!("{p}.beta")),
                ..Default::default()
            },
            Bind {
                src: Some(&kv_in.buffer),
                src2: Some(&q_in.buffer),
                weights: None,
                dst: &out.buffer,
            },
            out.len(),
        );
        out
    }

    fn forward(&self, image: &Planes) -> Planes {
        let dims = [32, 64, 128, 256];
        let mut x = self.named_conv(image, "img_tokenizer", dims[0], 3, 1);
        let mut encoded = Vec::new();
        let mut high = Vec::new();
        let mut low = Vec::new();
        for i in 0..4 {
            x = self.stage(&x, &format!("encoders.{i}"));
            encoded.push(x.clone());
            if i < 3 {
                let bands = self.dwt(&x);
                let ll = bands.channels(0, dims[i]);
                x = self.named_conv(&ll, &format!("downs.{i}.body"), dims[i] * 2, 3, 1);
                high.push(bands.channels(dims[i], 3 * dims[i]));
                low.push(ll);
            }
        }
        let mut x = encoded[3].clone();
        let heads = [4, 2, 1];
        for i in 0..3 {
            let level = 2 - i;
            let y = self.stage(&x, &format!("decoders.{i}"));
            let y = self.named_conv(&y, &format!("reduces.{i}"), dims[level], 1, 1);
            let middle = self.stage(&low[level], &format!("middlers.{i}"));
            let attended = self.fusion(&y, &middle, &format!("restormer_attentions.{i}"), heads[i]);
            let joined = self.cat(&[&y, &attended]);
            let ll = self.named_conv(&joined, &format!("ups.{i}.reduce"), dims[level], 3, 1);
            x = self.idwt(&self.cat(&[&ll, &high[level]]));
        }
        let joined = self.cat(&[&x, &encoded[0]]);
        self.named_conv(&joined, "output", 3, 3, 1)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [weights, given, width, height, out] = args.as_slice() else {
        panic!("dereflect <weights-dir> <in.f32> <width> <height> <out.f32>");
    };
    let (w, h): (usize, usize) = (
        width.parse().expect("a width"),
        height.parse().expect("a height"),
    );
    assert!(
        w > 0 && h > 0 && w % 16 == 0 && h % 16 == 0,
        "sides must be positive multiples of 16"
    );
    let bytes = std::fs::read(given).expect("the input");
    assert_eq!(bytes.len(), 3 * w * h * 4, "planar RGB f32 of {w}x{h}");

    let gpu = rawshim::gpu::device().expect("an adapter");
    let net = Net::new(gpu, weights);
    let image = Planes {
        buffer: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("lightrr input"),
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        }),
        at: 0,
        c: 3,
        h,
        w,
    };
    let started = std::time::Instant::now();
    let result = net.forward(&image);
    let read = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("lightrr read"),
        size: (result.len() * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut recording = gpu.record();
    recording.encoder().copy_buffer_to_buffer(
        &result.buffer,
        (result.at * 4) as u64,
        &read,
        0,
        (result.len() * 4) as u64,
    );
    recording.submit();
    let predicted = pollster::block_on(rawshim::gpu::read_back(gpu, &read, <[u8]>::to_vec))
        .expect("reads back");
    eprintln!("{w}x{h} in {:?}", started.elapsed());
    std::fs::write(out, predicted).expect("wrote the reflection");
}
