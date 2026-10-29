//! The demosaic against real windows' snapshots and against the orientation table, which sit above
//! the `mosaic` crate.

use mosaic::highlight::Colouring;

/// IMG_0275's sun, where `reconstructed` was tuned. The disc, blown in every channel, comes back
/// white rather than in the illuminant's pink, and the falloff keeps its warmth without a
/// magenta ring where the second channel runs out.
#[test]
fn the_sun_comes_back_white_at_its_disc() {
    let Some(gpu) = gpu::device() else {
        return;
    };
    let Some(rcd) = mosaic::demosaic::device(gpu) else {
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
    let Some(gpu) = gpu::device() else {
        return;
    };
    let Some(rcd) = mosaic::demosaic::device(gpu) else {
        return;
    };
    let read =
        |colouring| RealWindow::read(gpu, rcd, "lit-rock", (1248, 704), A7CR_COLOUR, colouring);
    // At full recovery, where the lamp's tint reaches the blown face; the default lends it none.
    read(Colouring::at(1.0))
        .snapshot(gpu)
        .check("highlights/lit-rock", WINDOW_TOLERANCE);
    let census = read(Colouring::DEFAULT).census();
    census.blown_is_neutral("the rock's blown patches", 100_000);
    census.nothing_near_clipping_is_magenta("the rock");
}

/// DSC05443's painted temple beams: saturated colour a few pixels across, which a demosaic or a
/// chroma stage that blurs colour past what the sensor resolved washes out.
#[test]
fn painted_beams_keep_their_fine_colour() {
    let Some(gpu) = gpu::device() else {
        return;
    };
    let Some(rcd) = mosaic::demosaic::device(gpu) else {
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

const R8_COLOUR: mosaic::demosaic::Colour = mosaic::demosaic::Colour {
    matrix: [
        [0.9192243, 0.16314033, -0.08228286],
        [-0.05530379, 1.5033377, -0.44804686],
        [-0.012427266, -0.30576313, 1.3179761],
    ],
    ceiling: [1.0, 0.48831666, 0.7162613],
};

const A7CR_COLOUR: mosaic::demosaic::Colour = mosaic::demosaic::Colour {
    matrix: [
        [0.8990233, 0.3062718, -0.20521326],
        [-0.05023299, 1.4729892, -0.42276916],
        [-0.0013742517, -0.23608698, 1.237247],
    ],
    ceiling: [0.60524476, 0.35804197, 1.0],
};

const BEAMS_COLOUR: mosaic::demosaic::Colour = mosaic::demosaic::Colour {
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
        gpu: &'static gpu::Gpu,
        rcd: &'static mosaic::demosaic::Rcd,
        name: &str,
        (w, h): (usize, usize),
        colour: mosaic::demosaic::Colour,
        colouring: mosaic::highlight::Colouring,
    ) -> RealWindow {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../../test/fixtures/mosaics/{name}.f32"));
        let bytes = std::fs::read(path).expect("the window's mosaic");
        assert_eq!(
            bytes.len(),
            w * h * 4,
            "{name}.f32 is the wrong size; an LFS pointer needs `bun run get:fixtures`"
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
        [0, 1, 2].map(|c| f64::from(colour::resident::level_of_bits(self.rgb[at + c])))
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

    fn snapshot(&self, gpu: &'static gpu::Gpu) -> crate::snapshot::Snapshot {
        let levels = crate::hdr::levels_of(gpu, &self.rgb, self.width, self.height, 0.995)
            .expect("the window has levels");
        let resident = colour::resident::Resident::upload(gpu, &self.rgb, self.width, self.height);
        crate::snapshot::Snapshot::crops(
            crate::snapshot::Frame::Scene(
                &resident,
                crate::snapshot::Anchoring {
                    levels: levels.anchored(),
                    reference_white_nits: units::light::Light::exactly(203.0),
                },
            ),
            &[units::px::Rect::<units::px::Pinned>::exact(
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
    let Some(gpu) = gpu::device() else {
        return;
    };
    let Some(rcd) = mosaic::demosaic::device(gpu) else {
        return;
    };

    // Not square, so a transposing turn has to change the frame's shape rather than only move
    // its pixels - which a square fixture cannot see.
    let (w, h) = (96usize, 64usize);
    let cfa = mosaic::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
    let mosaic: Vec<f32> = (0..w * h)
        .map(|at| 0.15 + 0.7 * (at % w) as f32 / w as f32 + 0.1 * (at / w) as f32 / h as f32)
        .collect();
    let uploaded = mosaic::condition::Mosaic::upload(gpu, &mosaic, w, h);

    // Inset from the edge so RCD's own margin is not the thing being compared.
    let crop = (16usize, 16usize, 48usize, 24usize);
    let identity = mosaic::demosaic::Colour {
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
        mosaic::highlight::Colouring::DEFAULT,
    );

    for orientation in 1..8u32 {
        let at = mosaic::demosaic::Placement {
            stride: units::px::Span::exact(w),
            crop: units::px::Rect::exact(crop.0, crop.1, crop.2, crop.3),
            dest: units::px::At::ORIGIN,
            frame: units::px::Size::exact(crop.2, crop.3),
            orientation,
            reduce: 1,
        };
        let (out_w, out_h) = at.out();
        let frame = mosaic::demosaic::frame_buffer(gpu, out_w * out_h);
        let (_shape, group) =
            mosaic::demosaic::shape_group(gpu, rcd, &cfa, &uploaded, mosaic::demosaic::MARGIN);
        let field = mosaic::highlight::measure(gpu, &uploaded, &cfa, identity.ceiling)
            .expect("the highlight field");
        pollster::block_on(mosaic::demosaic::demosaic_into(
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
        let turned = pollster::block_on(mosaic::demosaic::read_frame(gpu, &frame, out_w * out_h))
            .expect("it reads back");

        let (want, want_w, want_h) =
            formats::orientation::orient_for_test(unturned.clone(), crop.2, crop.3, orientation);
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

const IDENTITY_F32: [[f32; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn rggb() -> mosaic::cfa::Cfa {
    mosaic::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap()
}

/// `crop` of an RGGB `mosaic` through the demosaic and the colour pass, unturned, as stored.
fn demosaiced(
    gpu: &'static gpu::Gpu,
    rcd: &'static mosaic::demosaic::Rcd,
    mosaic: &[f32],
    (w, h): (usize, usize),
    crop: (usize, usize, usize, usize),
    colour: mosaic::demosaic::Colour,
    colouring: mosaic::highlight::Colouring,
) -> Vec<u16> {
    let uploaded = mosaic::condition::Mosaic::upload(gpu, mosaic, w, h);
    let at = mosaic::demosaic::Placement {
        stride: units::px::Span::exact(w),
        crop: units::px::Rect::exact(crop.0, crop.1, crop.2, crop.3),
        dest: units::px::At::ORIGIN,
        frame: units::px::Size::exact(crop.2, crop.3),
        orientation: 0,
        reduce: 1,
    };
    let frame = mosaic::demosaic::frame_buffer(gpu, crop.2 * crop.3);
    let cfa = rggb();
    let (_shape, group) =
        mosaic::demosaic::shape_group(gpu, rcd, &cfa, &uploaded, mosaic::demosaic::MARGIN);
    let field = mosaic::highlight::measure(gpu, &uploaded, &cfa, colour.ceiling)
        .expect("the highlight field");
    pollster::block_on(mosaic::demosaic::demosaic_into(
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
    pollster::block_on(mosaic::demosaic::read_frame(gpu, &frame, crop.2 * crop.3))
        .expect("it reads back")
}
