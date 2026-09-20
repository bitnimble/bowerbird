//! Two frames matched by what their corners look like, rather than by where a search was pointed.
//!
//! **This exists for the one question a correlation search cannot answer: is this match unique?**
//! Every other measure the panorama takes asks how *well* two places agree, and the answer on a row
//! of windows is that it agrees with the row above perfectly - so a repeating scene answers
//! confidently and wrongly, and no bar on the answer divides the two populations. Lowe's ratio test
//! asks instead how well the *second* best place agrees, which needs a description of a point good
//! enough to compare against every point of the other frame. That is what this builds.
//!
//! What it cannot do, and the reason it is evidence beside the correlation search rather than
//! instead of it: a frame of open water or sky has no corners to describe. The search finds
//! something everywhere; this finds nothing where there is nothing, so a pair over thin content
//! comes back with no opinion rather than a wrong one.

use crate::hdr_fit::{DevicePlane, Kernel, READ, UNIFORM, WRITE, kernel};

/// `composite_features.slang`'s `SIDE` squared: the descriptor's length, which does not depend on
/// how wide a window it reduced.
const DESCRIBED: usize = 64;

/// How wide a square each thread keeps the best corner of.
///
/// Spread rather than strength is what a matcher wants: the strongest four hundred corners of a
/// city frame are four hundred windows of one building, and a pair of frames agreeing about one
/// building says nothing about where they sit. A bucket a thirtieth of a frame across puts a corner
/// in every part of the picture that has one.
const BUCKET: usize = 32;

/// How much better the best match has to be than the next, for the two to be a correspondence.
///
/// **Lowe's ratio, and his number.** A point that matches one place clearly is evidence; a point
/// that matches two places nearly as well is a point on something repeated, and taking the better of
/// the two is how a facade aligns to the storey above. 0.8 keeps about the same share of true
/// matches he reports and refuses most of the rest.
const DISTINCT_ENOUGH: f64 = 0.8;

/// How many corners of a frame are carried into the matching.
const MOST_CORNERS: usize = 600;

struct Kernels {
    corners: Kernel,
    describe: Kernel,
}

fn device(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        const WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_features.wgsl"));
        const BINDINGS: &[(u32, wgpu::BufferBindingType)] =
            &[(0, READ), (1, WRITE), (2, READ), (3, WRITE), (20, UNIFORM)];
        Kernels {
            corners: kernel(gpu, "composite_corners", WGSL, BINDINGS, &[]),
            describe: kernel(gpu, "composite_describe", WGSL, BINDINGS, &[]),
        }
    })
}

/// A frame's corners and what each one looks like.
pub struct Described {
    pub at: Vec<[i32; 2]>,
    /// `DESCRIBED` floats a point, zero-mean and unit length, so a dot product is a correlation.
    pub of: Vec<f32>,
}

/// Where a point of one frame is in another, by description alone.
#[derive(Clone, Copy, Debug)]
pub struct Paired {
    pub from: [f64; 2],
    pub to: [f64; 2],
    /// How much better this was than the next best place in the other frame: Lowe's ratio, so
    /// smaller is more distinctive.
    pub over: f64,
}

fn block(width: usize, height: usize, bucket: usize, across: usize, points: usize) -> Vec<u8> {
    let mut out = [
        (width as i32).to_ne_bytes(),
        (height as i32).to_ne_bytes(),
        (bucket as i32).to_ne_bytes(),
        (across as i32).to_ne_bytes(),
        (points as i32).to_ne_bytes(),
    ]
    .concat();
    out.resize(32, 0);
    out
}

/// The corners of `plane`, one per bucket that has one, and a description of each.
pub async fn described(gpu: &'static crate::gpu::Gpu, plane: &DevicePlane) -> Option<Described> {
    let across = plane.width.div_ceil(BUCKET);
    let down = plane.height.div_ceil(BUCKET);
    let buckets = across * down;

    let mut recording = gpu.record();
    let found = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano corners"),
        size: (buckets * 3 * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let staging = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano corners out"),
        size: (buckets * 3 * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    // Bound at the descriptor slots, which this pass does not touch: one layout serves both passes.
    // Two of them, because one buffer cannot be bound as read-only and writable in a single
    // dispatch - which is a validation error rather than anything the shader would notice.
    let asking = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano features filler read"),
        contents: &[0u8; 16],
        usage: wgpu::BufferUsages::STORAGE,
    });
    let filler = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano features filler write"),
        contents: &[0u8; 16],
        usage: wgpu::BufferUsages::STORAGE,
    });
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano features push"),
        contents: &block(plane.width, plane.height, BUCKET, across, 0),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let kernels = device(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pano corners"),
        layout: &kernels.corners.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: plane.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: found.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: asking.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: filler.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernels.corners.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((buckets as u32).div_ceil(64), 1, 1);
    }
    recording
        .encoder()
        .copy_buffer_to_buffer(&found, 0, &staging, 0, (buckets * 3 * 4) as u64);
    recording.submit();

    // One candidate a bucket, which is what the device already reduced the picture to - so this is
    // a walk over a few thousand numbers rather than over a frame.
    let mut ranked = crate::gpu::read_back(gpu, &staging, |mapped| {
        mapped
            .chunks_exact(12)
            .filter_map(|word| {
                let take = |at: usize| {
                    f32::from_ne_bytes([word[at], word[at + 1], word[at + 2], word[at + 3]])
                };
                (take(0) > 0.0).then(|| (f64::from(take(0)), [take(4) as i32, take(8) as i32]))
            })
            .collect::<Vec<(f64, [i32; 2])>>()
    })
    .await?;
    // **The strongest of the spread, not the strongest outright.** The buckets already stopped a
    // frame answering with four hundred corners of one railing; this drops the buckets that had no
    // corner to offer and only reported their least flat pixel. What it is really for is the cost of
    // the matching, which is every description against every description - at six hundred a frame
    // that is sixteen million multiplies a pair, and at seventeen hundred it is a hundred and
    // eighty.
    ranked.sort_by(|left, right| right.0.total_cmp(&left.0));
    ranked.truncate(MOST_CORNERS);
    let at: Vec<[i32; 2]> = ranked.into_iter().map(|(_, at)| at).collect();
    if at.is_empty() {
        return Some(Described { at, of: Vec::new() });
    }

    let mut recording = gpu.record();
    let points: Vec<u8> = at
        .iter()
        .flat_map(|p| [p[0].to_ne_bytes(), p[1].to_ne_bytes()].concat())
        .collect();
    let asked = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano describe at"),
        contents: &points,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let bytes = (at.len() * DESCRIBED * 4) as u64;
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano described"),
        size: bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let reading = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano described out"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano describe push"),
        contents: &block(plane.width, plane.height, BUCKET, across, at.len()),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pano describe"),
        layout: &kernels.describe.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: plane.buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: found.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: asked.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: out.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 20,
                resource: push.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernels.describe.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((at.len() as u32).div_ceil(64), 1, 1);
    }
    recording
        .encoder()
        .copy_buffer_to_buffer(&out, 0, &reading, 0, bytes);
    recording.submit();

    let of = crate::gpu::read_back(gpu, &reading, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<f32>>()
    })
    .await?;
    Some(Described { at, of })
}

/// The points of `ours` that match one point of `theirs` clearly better than any other.
///
/// Every description against every description, which is a loop over a few thousand vectors of
/// sixty-four rather than over a picture - and it has to be every one, because the whole question is
/// whether somewhere *else* in the frame answers as well.
pub fn paired(ours: &Described, theirs: &Described) -> Vec<Paired> {
    // Nothing to be distinct from: with one corner over there every corner here matches it, and
    // the ratio below would call every one of them unique.
    if theirs.at.len() < 2 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (mine, from) in ours.at.iter().enumerate() {
        let us = &ours.of[mine * DESCRIBED..(mine + 1) * DESCRIBED];
        let (mut best, mut next, mut which) = (f64::MIN, f64::MIN, 0usize);
        for (yours, _) in theirs.at.iter().enumerate() {
            let them = &theirs.of[yours * DESCRIBED..(yours + 1) * DESCRIBED];
            let alike: f64 = us
                .iter()
                .zip(them)
                .map(|(u, v)| f64::from(*u) * f64::from(*v))
                .sum();
            if alike > best {
                next = best;
                best = alike;
                which = yours;
            } else if alike > next {
                next = alike;
            }
        }
        // The runner-up is only tested for having beaten nothing at all. A descriptor is zero-mean
        // and unit-length, so an uncorrelated second candidate scores either side of zero - and
        // refusing a negative one would throw away exactly the corners that are most distinctive.
        if best <= 0.0 {
            continue;
        }
        // Distances, as Lowe states it: a correlation of one is a distance of nothing.
        let (near, second) = ((1.0 - best).max(0.0), (1.0 - next).max(0.0));
        let over = match second > 1e-9 {
            true => near / second,
            false => 1.0,
        };
        if over > DISTINCT_ENOUGH {
            continue;
        }
        let there = theirs.at[which];
        out.push(Paired {
            from: [f64::from(from[0]), f64::from(from[1])],
            to: [f64::from(there[0]), f64::from(there[1])],
            over,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use crate::px::{Search, Share, Span};

    /// `REACH_OF_LONG` in `composite_features.slang`, which the emitted WGSL folds into its use
    /// sites - so the `.slang` is what a test reads (`CLAUDE.md`).
    fn reach_of_long() -> Share {
        let source = include_str!("../../../slang/composite_features.slang");
        let line = source
            .lines()
            .find(|l| l.contains("static const Share REACH_OF_LONG"))
            .expect("the descriptor's window is declared");
        let (num, den) = line
            .split_once('{')
            .and_then(|(_, rest)| rest.split_once('}'))
            .and_then(|(inner, _)| inner.split_once('/'))
            .expect("a fraction of the long edge");
        // `expect` and not a fallback: a parse that quietly answered the numbers this test is
        // asserting would be a test that cannot fail.
        let read = |at: &str| at.trim().parse::<f64>().expect("a number");
        Share::measured(read(num), read(den))
    }

    /// **The window is a share so that it describes the same picture on either plane**, and the
    /// number was chosen so a pan's plane resolves it to exactly what it was tuned at.
    ///
    /// A fixed sixteen was the `px.rs` failure in its own words: `composite_align::Kind` searches a
    /// burst on half the long edge, where sixteen pixels is twice the facade and twice the border
    /// excluded from matching.
    #[test]
    fn the_descriptor_window_is_the_sixteen_it_was_tuned_at_on_a_pans_plane() {
        let reach = reach_of_long();
        assert_eq!(
            reach.over(Span::<Search>::measured(1616)).raw(),
            16,
            "a pan is unchanged"
        );
        assert_eq!(
            reach.over(Span::<Search>::measured(808)).raw(),
            8,
            "and a burst is halved"
        );
    }
}
